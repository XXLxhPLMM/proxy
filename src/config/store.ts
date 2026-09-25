/**
 * 配置类型与实例化配置存储。
 *
 * 本模块只定义配置契约与 `ConfigStore`，不持有任何模块级配置状态，也不做 IO。
 * 每个 store 自持一份值表；配置来源解析与落库统一交给 `loadConfig`。
 */

export type CacheType = "memory" | "redis";

/** 权限校验类型，none=无鉴权，basic=账号密码，jwt=Bearer Token，uid=仅用户名（socks4 USERID） */
export type AuthType = "none" | "basic" | "jwt" | "uid";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
import type { ProxyProtocol } from "@/core/types/proxy.js";

export type { ProxyProtocol } from "@/core/types/proxy.js";

export interface AppConfig {
  /** 服务监听 IP，默认 0.0.0.0 */
  host: string;
  /** 服务监听端口，默认 3000 */
  port: number;
  /** 缓存实现类型，默认 memory */
  cacheType: CacheType;
  /**
   * 代理协议 - 双端生效的全局开关，默认 http
   * - 服务端侧：决定 src/server/index.ts:createProxy 创建何种 ProxyCore
   *   （HttpProxy/SocksProxy/TlsProxy）
   *   以及监听的底层 Server 类型
   *   （http.Server / net.Server / tls.Server）
   * - 客户端侧：决定下游客户端应使用何种协议与本代理握手
   *   （浏览器填 http 代理 vs 客户端填 socks5://）
   * 可选值：http(明文+CONNECT) / https(TLS+HTTP)
   * / socks4 / socks5(明文 SOCKS) / sockss4 / sockss5(SOCKS over TLS)
   * 环境变量：PROXY_PROTOCOL，CLI：--proxy-protocol
   */
  proxyProtocol: ProxyProtocol;
  /** 鉴权总开关，默认 false（关闭），优先于 authType */
  authEnabled: boolean;
  /** 鉴权类型，默认 none（不校验），authEnabled=true 时生效 */
  authType: AuthType;
  /**
   * 用户账号文件路径（AUTH_USERS_FILE，默认 <配置目录>/cfg/users.json）
   * - 内容为 `[{ "username": "alice", "password": "pw1" }]`，多账号即多项
   * - 文件缺失 = 无账号；内容非法 = 保留上一份有效值并告警；改动最多 1s 内热生效
   * - 路径本身为 runtime 相位：可 set() 热改指向
   */
  authUsersFile: string;
  /**
   * 访问控制名单文件路径（ACL_FILE，默认 <配置目录>/cfg/acl.json）
   * - 内容为 `{ clientIp: {whitelist, blacklist}, target: {whitelist, blacklist} }`
   * - clientIp 只收 IP/CIDR（按 TCP 对端地址判定，不看 XFF）；target 收 IP/CIDR/域名/`*.域名`
   * - 文件缺失 = 全部放行；内容非法 = 保留上一份有效值并告警；改动最多 1s 内热生效
   */
  aclFile: string;
  /** JWT 密钥（JWT_SECRET），authType=jwt 时生效 */
  jwtSecret: string;
  /** 鉴权日志开关，默认 true，false 时静默 allow/deny 审计日志 */
  authLogging: boolean;
  /**
   * 控制台日志等级，默认 error，可选 debug/info/warn/error/silent
   * - 与 logFileLevel 独立：终端求安静、文件求详尽，两边各调各的
   * - 环境变量：LOG_LEVEL，CLI：--log-level
   */
  logLevel: LogLevel;
  /**
   * 落盘日志等级，默认 info，可选 debug/info/warn/error/silent
   * - 与 logLevel 独立，仅 logFile 配了路径时生效
   * - 环境变量：LOG_FILE_LEVEL，CLI：--log-file-level
   */
  logFileLevel: LogLevel;
  /**
   * 日志持久化路径，默认 log 目录按小时分文件
   * - 设为目录（log/logs）或文件均按小时生成
   *   log/YYYY-MM-DD-HH.jsonl（每行一个 JSON 对象，可直接 jq/grep 查询）
   * - 落盘等级由 logFileLevel 单独控制，留空则完全不落盘
   * - 环境变量：LOG_FILE，CLI：--log-file
   */
  logFile: string;
  /** 上游目标超时 ms，默认 10000，超时回 504/断开隧道 */
  upstreamTimeout: number;
  /**
   * TLS 私钥路径，默认 keys/server.key
   * - 仅 https/sockss4/sockss5 协议生效，http/socks4/socks5 忽略
   * - 支持绝对路径或相对项目根目录的路径
   * - 环境变量：TLS_KEY，CLI：--tls-key
   */
  tlsKey: string;
  /**
   * TLS 证书路径，默认 keys/server.crt
   * - 仅 https/sockss4/sockss5 协议生效，需与 tlsKey 配对使用
   * - 环境变量：TLS_CERT，CLI：--tls-cert
   */
  tlsCert: string;
  /**
   * 客户端证书 CA 路径（mTLS），默认空串 = 不校验客户端证书
   * - 仅 https/sockss4/sockss5 生效：配置即强制校验客户端证书（要求由该 CA 签发），留空则只做服务端 TLS
   * - 配置后文件缺失/不可读会在启动时 abort（fail-closed），绝不静默降级为不校验
   * - 默认必须为空串：keys/ 下是仓库自带的测试 PKI（私钥已提交），拿它当安全边界是自欺
   * - 环境变量：TLS_CA，CLI：--tls-ca
   */
  tlsCa: string;
  /**
   * TLS 私钥口令（加密私钥时需）
   * - 仅私钥为 ENCRYPTED PRIVATE KEY 时生效，无口令私钥忽略
   * - 环境变量：TLS_PASSPHRASE，CLI：--tls-passphrase
   */
  tlsPassphrase: string;
  /**
   * 上游代理标准 URL（可选，替代逐项 granular 配置）
   * - 形式：scheme://[user:pass@]host[:port]，
   *   scheme ∈ http/https/socks5/tls（大小写不敏感）
   * - 配置后整体生效，覆盖
   *   upstreamProtocol/Secure/Host/Port/Username/Password 拆项；
   *   缺省端口按 scheme 补齐
   *   （http:80 / https,tls:443 / socks5:1080）
   * - 拒绝携带 path/query/hash（代理端点无路径语义）；
   *   upstreamCa/upstreamInsecure 仍为独立配置
   * - 环境：UPSTREAM_URL，CLI：--upstream-url；
   *   快照打印时自动脱敏 userinfo
   */
  upstreamUrl: string;
  /** 上游地址；配 UPSTREAM_URL 时被整体覆盖 */
  upstreamHost: string;
  /** 上游端口；配 UPSTREAM_URL 时同样被覆盖（与 host 一致） */
  upstreamPort: number;
  /** 上游是否 TLS；配 UPSTREAM_URL 时被覆盖 */
  upstreamSecure: boolean;
  /** 上游用户名；配 UPSTREAM_URL 时被覆盖 */
  upstreamUsername: string;
  /** 上游密码；配 UPSTREAM_URL 时被覆盖 */
  upstreamPassword: string;
  /**
   * 上游 CA 路径；独立配置，不受 UPSTREAM_URL 覆盖
   * 默认空串 = 用系统信任库校验上游证书；配了则**整体替换**系统信任库（只信任该 CA）
   */
  upstreamCa: string;
  /** 上游是否跳过证书校验；独立配置，不受 UPSTREAM_URL 覆盖 */
  upstreamInsecure: boolean;
  /**
   * 上游代理协议（client 模式下，本地服务收到请求后向哪个协议的上游转发）
   * 取值与 proxyProtocol 相同（http/https/socks4/socks5/sockss4/sockss5），
   * 与 proxyProtocol 正交：下游可 http，上游可 sockss5，实现链式异构
   * 环境：UPSTREAM_PROTOCOL，CLI：--upstream-protocol
   */
  upstreamProtocol: ProxyProtocol;
  /** 运行模式：server=服务端，client=客户端 */
  proxyMode: "server" | "client";
  /**
   * cluster worker 进程数，默认 1（不启用 cluster，单进程运行）
   * - 1: 单进程；>1: master fork 指定数量 worker 共享监听端口，
   *   崩溃自动重启
   * - 0: 按 CPU 核数 fork
   * 环境变量：CLUSTER_WORKERS，CLI：--cluster-workers
   */
  clusterWorkers: number;
  /**
   * 使用用户主目录作为配置目录，默认 false（使用当前工作目录）
   * - true: 从 ~/.proxy/ 读取 .env、keys/、log/ 等配置
   * - false: 从当前工作目录读取
   * 开启后只需配置一次，全局可用
   * 环境变量：USE_HOME_CONFIG，CLI：--use-home-config
   */
  useHomeConfig: boolean;
}

export type ConfigKey = keyof AppConfig;

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
 * 配置变更订阅回调
 * @param changed - 本次**实际**变更的键（写同值不触发，故每项都是真变更）
 * @param snapshot - 变更后的全量浅拷贝快照；只读语义，mutate 它不会影响 store
 */
export type ConfigChangeListener = (
  changed: readonly ConfigKey[],
  snapshot: Readonly<AppConfig>,
) => void;

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
