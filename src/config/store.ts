/**
 * 实例化配置存储：默认种子 + `ConfigStore`。
 *
 * 本模块是**唯一配置状态**，只做零 IO 的内存读写：不读 env 文件、不读宿主环境、
 * 不持有任何模块级配置 Map。字段契约在 `types.ts`，字段元数据在 `schema/fields.ts`，
 * 解析与落库统一交给 `loadConfig`。
 */

import type { AppConfig, ConfigChangeListener, ConfigKey } from "./types.js";

/**
 * 默认配置：新建 ConfigStore 时作为初始值种子
 * 魔法值由来：port/upstreamPort 3000=开发惯例非特权端口；
 * upstreamTimeout 10000=上游拨号+转发共用容忍上限；
 * host 0.0.0.0=容器/多网卡默认全监听；
 * logLevel error + logFileLevel info=终端只报错、文件留全量（两级独立，可各自调整）；
 * tls 系默认 keys 下自签占位路径；两个 CA 默认都是空串=不启用校验（upstreamCa 配了会替换系统信任库；
 * tlsCa 配了即强制客户端证书 mTLS），拿仓库自带测试 PKI 当默认安全边界属自欺（其私钥已随仓库提交）
 *
 * 路径类字段（logFile/tlsKey/tlsCert/tlsCa/authUsersFile/aclFile）在此存的是相对配置目录的路径，
 * loadConfig 经 FIELDS.def 解析成绝对路径后写回，因此同一个 key 初始化前读相对值、
 * 初始化后读绝对值；不跑 loadConfig 的调用方拿到的是相对 cwd 的路径。
 */
export const defaults: AppConfig = {
  host: "0.0.0.0",
  port: 3000,
  cacheType: "memory",
  proxyProtocol: "http",
  authEnabled: false,
  authType: "none",
  authUsersFile: "cfg/users.json",
  aclFile: "cfg/acl.json",
  jwtSecret: "",
  authLogging: true,
  logLevel: "error",
  logFileLevel: "info",
  logFile: "log",
  upstreamTimeout: 10000,
  upstreamUrl: "",
  tlsKey: "keys/server.key",
  tlsCert: "keys/server.crt",
  tlsCa: "",
  tlsPassphrase: "",
  upstreamHost: "127.0.0.1",
  upstreamPort: 3000,
  upstreamSecure: false,
  upstreamUsername: "",
  upstreamPassword: "",
  upstreamCa: "",
  upstreamInsecure: false,
  upstreamProtocol: "http",
  proxyMode: "server",
  clusterWorkers: 1,
  useHomeConfig: false,
};

// ── 实例化 store：配置值只存在于调用方拥有的实例中 ──
// loader 负责把解析结果一次性 merge 到目标 store；本模块不提供模块级 Map 或隐式单例。

/**
 * 实例化配置仓库：每个实例自持一份 Map，**实例之间互不影响**（多份配置并存的前提）
 * - 零 IO：不读 env 文件或宿主环境，值从哪来由调用方给（构造参数 / `loadConfig`）
 * - 变更通知只在**值真的变了**时触发（写同值不触发）：避免把「热改配置」退化成无谓的连锁反应
 */
export class ConfigStore {
  /** 实例私有值表（不同实例之间无任何共享） */
  private readonly values: Map<ConfigKey, AppConfig[ConfigKey]>;
  /** 变更订阅者；回调时先拷贝，允许订阅者在回调内部退订自己 */
  private readonly listeners = new Set<ConfigChangeListener>();

  /**
   * @param initial - 初始值补丁（缺省即纯 `defaults`）；`undefined` 项按「未提供」跳过
   */
  constructor(initial?: Partial<AppConfig>) {
    this.values = new Map(Object.entries(defaults) as [ConfigKey, AppConfig[ConfigKey]][]);
    if (initial !== undefined) {
      // 构造期还没有订阅者，走 merge 不会触发任何通知
      this.merge(initial);
    }
  }

  /**
   * 读取配置
   * @param key - 配置键
   * @returns 该键的生效值
   */
  get<K extends ConfigKey>(key: K): AppConfig[K] {
    return this.values.get(key) as AppConfig[K];
  }

  /**
   * 写入配置；值与现值相同则不触发变更通知
   * @param key - 配置键
   * @param value - 新值
   */
  set<K extends ConfigKey>(key: K, value: AppConfig[K]): void {
    if (Object.is(this.values.get(key), value)) {
      return;
    }
    this.values.set(key, value);
    this.emit([key]);
  }

  /**
   * 是否持有该键（实例恒有全部 defaults 键，故实际用于确认键名合法）
   * @param key - 配置键
   */
  has(key: ConfigKey): boolean {
    return this.values.has(key);
  }

  /**
   * 全量浅拷贝快照：调用方 mutate 返回值不会影响 store
   * @returns 当前全量配置的拷贝
   */
  getAll(): AppConfig {
    // Object.fromEntries 推断为 {[k:string]:unknown}，需经 unknown 中转至 AppConfig
    return Object.fromEntries(this.values) as unknown as AppConfig;
  }

  /**
   * 就地合并一批键（`loadConfig` 用它把解析结果灌进目标 store）
   * @param patch - 待合并的键值；`undefined` 项按「未提供」跳过（保留现值）
   * @returns 实际发生变更的键（值相同的键不在其中）
   */
  merge(patch: Partial<AppConfig>): ConfigKey[] {
    const changed: ConfigKey[] = [];
    // Object.entries 抹掉 key 的字面量类型，逐项回投
    for (const [k, v] of Object.entries(patch) as [ConfigKey, AppConfig[ConfigKey] | undefined][]) {
      if (v === undefined || Object.is(this.values.get(k), v)) {
        continue;
      }
      this.values.set(k, v);
      changed.push(k);
    }
    if (changed.length > 0) {
      this.emit(changed);
    }
    return changed;
  }

  /**
   * 订阅配置变更
   * @param listener - 变更回调，签名见 `ConfigChangeListener`
   * @returns 退订函数（幂等：重复调用无副作用）
   */
  onChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this.listeners.delete(listener);
    };
  }

  /** 广播变更：快照只构造一次，单个订阅者抛错不影响 store 与其它订阅者 */
  private emit(changed: ConfigKey[]): void {
    if (this.listeners.size === 0) {
      return;
    }
    const snapshot: Readonly<AppConfig> = this.getAll();
    // 拷贝后再回调：允许监听器在回调里退订/新增订阅者，不影响本次遍历
    for (const listener of [...this.listeners]) {
      try {
        listener(changed, snapshot);
      } catch {
        // store 刻意不依赖 logger；
        // 订阅者自己的异常与配置存储无关，吞掉只影响它自己
      }
    }
  }
}
