/**
 * 配置字段元数据表：全量字段描述（env 名 / 解析器 / 相位 / 范围 / 路径标记）。
 *
 * 本表是 env 名的**唯一真相源**，禁止在别处新建第二张别名表。新增配置只需在此加一行，
 * `loadConfig`（env/argv/env 文件）与归一化（路径、UPSTREAM_URL）自动生效。
 *
 * 本模块只描述字段，**不做校验**（越界/交叉校验见 `validate.ts`），
 * 也**不读 env/argv/文件**——`path.join`/`defaults` 引用只是纯字面量计算。
 */

import path from "node:path";
import { parseUpstreamUrl } from "./upstream-url.js";
import { defaults } from "../store.js";
import type { AppConfig, ConfigKey } from "../types.js";
import { parseEnum, parseNum, parseStr, toBoolean } from "./parse.js";

/** 字段描述：CLI 与 env 共用别名表和解析器 */
export interface FieldDef<K extends ConfigKey = ConfigKey> {
  /** store 键名（AppConfig 字段） */
  key: K;
  /** 环境变量名（唯一，无别名）；CLI 同源，--key-name / KEY=VALUE 归一为 KEY_NAME */
  env: string;
  /** 字符串 -> 字段类型；undefined 表示非法（显式给出的非法值一律抛错阻止启动，不分来源） */
  parse: (v: string) => AppConfig[K] | undefined;
  /**
   * 整数范围约束，越界即抛错阻止启动；
   * 与 parse 同处一行，避免另建校验表造成两处手工同步
   */
  int?: { min?: number; max?: number };
  /**
   * 生效时机（必填，避免"哪些改动需要重启"沦为 get() 调用位置的偶然产物）：
   * - startup: ProxyServer.start() 读取一次写进 ProxyOptions（监听地址/协议/TLS/worker 数），
   *            运行中改动无效，需重启进程
   * - runtime: 每请求/连接或每次日志经 `ConfigAccessor.get()` 现读，可经所属 `ConfigStore.set()` 热改
   * 注：标 startup 的字段仍可能在其他位置被重读（如 host/port 另用于自环判定），
   *     判定依据是该字段是否被启动流程一次性捕获
   */
  phase: "startup" | "runtime";
  /**
   * 是否为配置目录相对路径字段；路径归一化由 normalize/paths.ts 统一遍历本表完成。
   * 空串保留为空，绝对路径原样保留，相对路径按调用方给出的 configDir 解析。
   */
  path?: boolean;
  /**
   * 兜底默认值；函数形式可依赖配置目录（日志/证书路径）；
   * 省略时取 store.ts defaults
   */
  def?: AppConfig[K] | ((configDir: string) => AppConfig[K]);
}

/** 表项构造辅助：保留字段级泛型 K，对外统一为 FieldDef */
function field<K extends ConfigKey>(d: FieldDef<K>): FieldDef {
  return d as unknown as FieldDef;
}

/** 日志等级枚举：控制台（logLevel）与落盘（logFileLevel）共用，避免两处取值漂移 */
const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;

/**
 * 全量字段表 - 新增配置只需在此加一行
 * （CLI 解析/env 合并/store 写入/快照自动生效）
 */
export const FIELDS: FieldDef[] = [
  field({ key: "host", env: "HOST", parse: parseStr, phase: "startup" }),
  field({
    key: "port",
    env: "PORT",
    parse: parseNum,
    int: { min: 1, max: 65535 },
    phase: "startup",
  }),
  field({
    key: "cacheType",
    env: "CACHE_TYPE",
    parse: parseEnum(["memory", "redis"] as const),
    phase: "runtime",
  }),
  // http=明文+CONNECT，https=TLS+HTTP；socks4/socks5=明文分版本，sockss*=over TLS；改取值需同步 core/types/proxy.ts
  field({
    key: "proxyProtocol",
    env: "PROXY_PROTOCOL",
    parse: parseEnum(["http", "https", "socks4", "socks5", "sockss4", "sockss5"] as const),
    phase: "startup",
  }),
  field({ key: "authEnabled", env: "AUTH_ENABLED", parse: toBoolean, phase: "runtime" }),
  field({
    key: "authType",
    env: "AUTH_TYPE",
    parse: parseEnum(["none", "basic", "jwt", "uid"] as const),
    phase: "runtime",
  }),
  // 账号表在 cfg/users.json（AUTH_USERS_FILE 指向），本表只存路径；内容校验见 loadConfig 的启动期强校验
  field({
    key: "authUsersFile",
    env: "AUTH_USERS_FILE",
    parse: parseStr,
    def: (dir) => path.join(dir, defaults.authUsersFile),
    phase: "runtime",
    path: true,
  }),
  field({ key: "jwtSecret", env: "JWT_SECRET", parse: parseStr, phase: "runtime" }),
  field({ key: "authLogging", env: "AUTH_LOGGING", parse: toBoolean, phase: "runtime" }),
  // 访问控制名单在 cfg/acl.json（ACL_FILE 指向）：clientIp 控来源、target 控目标；内容校验同启动期强校验
  field({
    key: "aclFile",
    env: "ACL_FILE",
    parse: parseStr,
    def: (dir) => path.join(dir, defaults.aclFile),
    phase: "runtime",
    path: true,
  }),
  // 每用户流量配额的三个字段（配额本身在 cfg/users.json 的 quota 组里）
  // 账本目录刻意是 **startup**：运行中改目录 = 已打开的 append 句柄仍指向旧文件，改了等于没改
  // （句柄归属在启动期确定）。要改必须重建 runtime —— 与 UPSTREAM_URL 同一类裁决
  field({
    key: "quotaLedgerDir",
    env: "QUOTA_LEDGER_DIR",
    parse: parseStr,
    def: (dir) => path.join(dir, defaults.quotaLedgerDir),
    phase: "startup",
    path: true,
  }),
  // 窗口重置小时（本地时区 0..23）：runtime 相位，每请求现读 —— 热改立即生效
  field({
    key: "quotaResetHour",
    env: "QUOTA_RESET_HOUR",
    parse: parseNum,
    int: { min: 0, max: 23 },
    phase: "runtime",
  }),
  // delta 落盘间隔（ms）：runtime 相位。5b-1 只落字段与校验，写盘实现属 5b-2
  field({
    key: "quotaFlushInterval",
    env: "QUOTA_FLUSH_INTERVAL",
    parse: parseNum,
    int: { min: 1 },
    phase: "runtime",
  }),
  // 日志两级独立：LOG_LEVEL 管控制台（默认 error），LOG_FILE_LEVEL 管落盘（默认 info）
  field({
    key: "logLevel",
    env: "LOG_LEVEL",
    parse: parseEnum(LOG_LEVELS),
    phase: "runtime",
  }),
  field({
    key: "logFileLevel",
    env: "LOG_FILE_LEVEL",
    parse: parseEnum(LOG_LEVELS),
    phase: "runtime",
  }),
  field({
    key: "logFile",
    env: "LOG_FILE",
    parse: parseStr,
    def: (dir) => path.join(dir, defaults.logFile),
    phase: "runtime",
    path: true,
  }),
  field({
    key: "upstreamTimeout",
    env: "UPSTREAM_TIMEOUT",
    int: { min: 1 },
    parse: (v) => {
      const n = parseNum(v);
      if (n !== undefined && n > 0) {
        return n;
      }
      return undefined;
    },
    phase: "runtime",
  }),
  field({
    key: "tlsKey",
    env: "TLS_KEY",
    parse: parseStr,
    def: (dir) => path.join(dir, defaults.tlsKey),
    phase: "startup",
    path: true,
  }),
  field({
    key: "tlsCert",
    env: "TLS_CERT",
    parse: parseStr,
    def: (dir) => path.join(dir, defaults.tlsCert),
    phase: "startup",
    path: true,
  }),
  // 无默认文件：空串=不校验客户端证书；配了即 mTLS 开关，文件读不到在启动期 abort
  // （见 @/utils/tls/index.js:loadCerts；路径按 configDir 绝对化由本行的 path: true 负责）
  field({
    key: "tlsCa",
    env: "TLS_CA",
    parse: parseStr,
    def: "",
    phase: "startup",
    path: true,
  }),
  field({ key: "tlsPassphrase", env: "TLS_PASSPHRASE", parse: parseStr, phase: "startup" }),
  field({
    key: "upstreamUrl",
    env: "UPSTREAM_URL",
    parse: parseUpstreamUrl,
    def: "",
    phase: "startup",
  }),
  field({ key: "upstreamHost", env: "UPSTREAM_HOST", parse: parseStr, phase: "startup" }),
  field({
    key: "upstreamPort",
    env: "UPSTREAM_PORT",
    parse: parseNum,
    int: { min: 1, max: 65535 },
    phase: "startup",
  }),
  field({ key: "upstreamSecure", env: "UPSTREAM_SECURE", parse: toBoolean, phase: "startup" }),
  field({ key: "upstreamUsername", env: "UPSTREAM_USERNAME", parse: parseStr, phase: "startup" }),
  field({ key: "upstreamPassword", env: "UPSTREAM_PASSWORD", parse: parseStr, phase: "startup" }),
  field({
    key: "upstreamCa",
    env: "UPSTREAM_CA",
    parse: parseStr,
    def: "",
    phase: "runtime",
    path: true,
  }),
  field({ key: "upstreamInsecure", env: "UPSTREAM_INSECURE", parse: toBoolean, phase: "runtime" }),
  field({
    key: "upstreamProtocol",
    env: "UPSTREAM_PROTOCOL",
    parse: parseEnum(["http", "https", "socks4", "socks5", "sockss4", "sockss5"] as const),
    phase: "startup",
  }),
  field({
    key: "proxyMode",
    env: "PROXY_MODE",
    parse: parseEnum(["server", "client"] as const),
    phase: "runtime",
  }),
  field({
    key: "clusterWorkers",
    env: "CLUSTER_WORKERS",
    int: { min: 0, max: 1024 },
    // 小数向下截断；0=按 CPU 核数，负数丢弃回默认
    parse: (v) => {
      const n = parseNum(v);
      if (n !== undefined && n >= 0) {
        return Math.floor(n);
      }
      return undefined;
    },
    phase: "startup",
  }),
  // useHomeConfig 只在启动期生效：决定 env 文件读取目录与各路径默认值，运行中改动无意义
  field({ key: "useHomeConfig", env: "USE_HOME_CONFIG", parse: toBoolean, phase: "startup" }),
];

/**
 * 按生效时机分组的字段名，供启动日志说明「哪些改动需要重启」
 * startup 字段由 runtime 构造时冻结进 ProxyOptions，运行中经 `ConfigStore.set()` 改动只提示重启
 */
export function keysByPhase(): { startup: ConfigKey[]; runtime: ConfigKey[] } {
  const startup: ConfigKey[] = [];
  const runtime: ConfigKey[] = [];
  for (const d of FIELDS) {
    (d.phase === "startup" ? startup : runtime).push(d.key);
  }
  return { startup, runtime };
}
