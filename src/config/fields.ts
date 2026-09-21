/**
 * 配置字段表：全量字段描述、解析器、校验、CLI 解析
 * 新增配置只需在此加一行，initConfig/parseStartupArgs 自动生效
 */
import { defaults, type AppConfig, type ConfigKey } from "./store.js";
import { parseUpstreamUrl } from "@/utils/upstream-url.js";
import { parseRawArgv } from "./config-helpers.js";
import path from "node:path";

// ── 通用解析器：返回 undefined 表示非法，由调用方统一抛错阻止启动 ──
/** 字符串（永非法） */
const parseStr = (v: string): string => v;

/**
 * 有限数值（空串/NaN/Infinity 视为非法，回退默认）；
 * 接受 0x/1e3 等 Number() 面，小数/越界不拦，由字段表 int 约束最终校验
 */
const parseNum = (v: string): number | undefined => {
  if (v.trim() === "") {
    return undefined;
  }
  const n = Number(v);
  if (Number.isFinite(n)) {
    return n;
  }
  return undefined;
};

/**
 * 字符串转布尔 - 兼容 true/1/yes/on/enable 与
 * false/0/no/off/disable 等常见写法
 * 无法识别返回 undefined：显式给出的值一律不允许静默回退，
 * 否则 AUTH_ENABLED=treu 会悄悄变成 false（关闭鉴权）
 */
function toBoolean(value: string): boolean | undefined {
  const v = value.toLowerCase().trim();
  if (["true", "1", "yes", "on", "enable", "enabled"].includes(v)) {
    return true;
  }
  if (["false", "0", "no", "off", "disable", "disabled"].includes(v)) {
    return false;
  }
  return undefined;
}

/** 布尔解析：无法识别返回 undefined，与其余解析器一致（显式非法值一律拦截） */
const parseBool = toBoolean;

/** 枚举：大小写不敏感白名单 */
const parseEnum =
  <T extends string>(values: readonly T[]) =>
  (v: string): T | undefined => {
    const s = v.toLowerCase().trim();
    if ((values as readonly string[]).includes(s)) {
      return s as T;
    }
    return undefined;
  };

/** 字段描述：CLI 与 env 共用别名表和解析器 */
interface FieldDef<K extends ConfigKey = ConfigKey> {
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
   * - runtime: 每请求/连接或每次日志重新 get()，可经 set() 热改
   * 注：标 startup 的字段仍可能在其他位置被重读（如 host/port 另用于自环判定），
   *     判定依据是该字段是否被启动流程一次性捕获
   */
  phase: "startup" | "runtime";
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
  field({ key: "authEnabled", env: "AUTH_ENABLED", parse: parseBool, phase: "runtime" }),
  field({
    key: "authType",
    env: "AUTH_TYPE",
    parse: parseEnum(["none", "basic", "jwt", "uid"] as const),
    phase: "runtime",
  }),
  // 账号表在 cfg/users.json（AUTH_USERS_FILE 指向），本表只存路径；内容校验见 initConfig 的启动期强校验
  field({
    key: "authUsersFile",
    env: "AUTH_USERS_FILE",
    parse: parseStr,
    def: (dir) => path.join(dir, defaults.authUsersFile),
    phase: "runtime",
  }),
  field({ key: "jwtSecret", env: "JWT_SECRET", parse: parseStr, phase: "runtime" }),
  field({ key: "authLogging", env: "AUTH_LOGGING", parse: parseBool, phase: "runtime" }),
  // 访问控制名单在 cfg/acl.json（ACL_FILE 指向）：clientIp 控来源、target 控目标；内容校验同启动期强校验
  field({
    key: "aclFile",
    env: "ACL_FILE",
    parse: parseStr,
    def: (dir) => path.join(dir, defaults.aclFile),
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
  }),
  field({
    key: "tlsCert",
    env: "TLS_CERT",
    parse: parseStr,
    def: (dir) => path.join(dir, defaults.tlsCert),
    phase: "startup",
  }),
  // 无默认文件：空串=不校验客户端证书；配了即 mTLS 开关，文件读不到在启动期 abort（见 cert.ts:loadCerts）
  field({
    key: "tlsCa",
    env: "TLS_CA",
    parse: parseStr,
    def: "",
    phase: "startup",
  }),
  field({ key: "tlsPassphrase", env: "TLS_PASSPHRASE", parse: parseStr, phase: "startup" }),
  field({
    key: "upstreamUrl",
    env: "UPSTREAM_URL",
    parse: parseUpstreamUrl,
    def: "",
    phase: "runtime",
  }),
  field({ key: "upstreamHost", env: "UPSTREAM_HOST", parse: parseStr, phase: "runtime" }),
  field({
    key: "upstreamPort",
    env: "UPSTREAM_PORT",
    parse: parseNum,
    int: { min: 1, max: 65535 },
    phase: "runtime",
  }),
  field({ key: "upstreamSecure", env: "UPSTREAM_SECURE", parse: parseBool, phase: "runtime" }),
  field({ key: "upstreamUsername", env: "UPSTREAM_USERNAME", parse: parseStr, phase: "runtime" }),
  field({ key: "upstreamPassword", env: "UPSTREAM_PASSWORD", parse: parseStr, phase: "runtime" }),
  field({
    key: "upstreamCa",
    env: "UPSTREAM_CA",
    parse: parseStr,
    def: "",
    phase: "runtime",
  }),
  field({ key: "upstreamInsecure", env: "UPSTREAM_INSECURE", parse: parseBool, phase: "runtime" }),
  field({
    key: "upstreamProtocol",
    env: "UPSTREAM_PROTOCOL",
    parse: parseEnum(["http", "https", "socks4", "socks5", "sockss4", "sockss5"] as const),
    phase: "runtime",
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
  field({ key: "useHomeConfig", env: "USE_HOME_CONFIG", parse: parseBool, phase: "startup" }),
];

/**
 * 按生效时机分组的字段名，供启动日志说明「哪些改动需要重启」
 * startup 字段被 ProxyServer.start() 一次性读进 ProxyOptions，运行中经 set() 改动无效
 */
export function keysByPhase(): { startup: ConfigKey[]; runtime: ConfigKey[] } {
  const startup: ConfigKey[] = [];
  const runtime: ConfigKey[] = [];
  for (const d of FIELDS) {
    (d.phase === "startup" ? startup : runtime).push(d.key);
  }
  return { startup, runtime };
}

/**
 * 整数范围校验（initConfig 与 parseStartupArgs 共用）
 * @description 遍历 FIELDS 的 `int` 约束，对已出现在 resolved 表中的字段检查整数性与上下界，
 * 返回 `ENV=value` 形式的越界清单（空数组表示全部合法）；未出现在表中的字段跳过（parseStartupArgs 只含显式提供的键）
 * @param resolved - 已解析的字段表（键为 `ConfigKey`）
 * @returns 越界字段的 `ENV=value` 列表
 * @example collectIntRangeErrors({ port: 70000 }) // => ["PORT=70000"]
 */
export function collectIntRangeErrors(resolved: Record<string, unknown>): string[] {
  const bad: string[] = [];
  for (const d of FIELDS) {
    if (d.int === undefined || !(d.key in resolved)) {
      continue;
    }
    const v = resolved[d.key] as number;
    const { min, max } = d.int;
    if (!Number.isInteger(v) || (min !== undefined && v < min) || (max !== undefined && v > max)) {
      bad.push(`${d.env}=${v}`);
    }
  }
  return bad;
}

/**
 * 交叉字段校验：开启鉴权时的组合必须能真正拦人（fail-closed，任一项不成立即阻止启动）
 * @description
 * - `authEnabled + none`：开了鉴权却不选方式 = 全部放行，属自相矛盾配置
 * - `authEnabled + basic/uid + 账号表为空`：无账号可比对时一律判否是徒劳的「拒绝一切」，
 *   真正原因是 AUTH_USERS_FILE 没配好（路径写错/文件为空），必须让启动失败而不是静默全拒
 * - `authEnabled + jwt + 空 JWT_SECRET`：无密钥的 JWT 校验没有意义
 * 抽成导出的纯函数便于单测（无需起子进程）。
 * @param cfg - 待校验组合（authEnabled / authType / accountCount / jwtSecret）
 * @throws {Error} 配置非法时抛 `配置校验失败: ...`
 * @example assertAuthConfig({ authEnabled: true, authType: "basic", accountCount: 0 }); // throws
 * @example assertAuthConfig({ authEnabled: true, authType: "basic", accountCount: 2 }); // ok
 */
export function assertAuthConfig(cfg: {
  authEnabled: boolean;
  authType: string;
  accountCount: number;
  jwtSecret?: string;
}): void {
  if (!cfg.authEnabled) {
    return;
  }
  if (cfg.authType === "none") {
    throw new Error(
      "配置校验失败: AUTH_ENABLED=true 但 AUTH_TYPE=none（不会校验任何凭证）；确需关闭鉴权请设 AUTH_ENABLED=false",
    );
  }
  if ((cfg.authType === "basic" || cfg.authType === "uid") && cfg.accountCount === 0) {
    throw new Error(
      `配置校验失败: 账号表为空（AUTH_ENABLED=true 且 AUTH_TYPE=${cfg.authType}）；请检查 AUTH_USERS_FILE 指向的文件是否存在且至少配置一个账号`,
    );
  }
  if (cfg.authType === "jwt" && !cfg.jwtSecret) {
    throw new Error("配置校验失败: JWT_SECRET 为空（AUTH_ENABLED=true 且 AUTH_TYPE=jwt）");
  }
}

/**
 * 解析命令行启动参数 -> Partial<AppConfig>
 * 与 initConfig 共用同一张 FIELDS 表与同一套校验：显式给出的非法值直接抛错，
 * 不做静默丢弃（静默回退会让 --port banana 悄悄跑在默认端口上）；int 字段同样做越界拦截
 */
export function parseStartupArgs(argv: string[] = process.argv.slice(2)): Partial<AppConfig> {
  const raw = parseRawArgv(argv);
  const out: Record<string, unknown> = {};
  const bad: string[] = [];
  for (const d of FIELDS) {
    const v = raw[d.env];
    if (v === undefined) {
      continue;
    }
    const parsed = d.parse(v);
    if (parsed === undefined) {
      bad.push(`${d.env}=${v}`);
      continue;
    }
    out[d.key] = parsed;
  }
  if (bad.length) {
    throw new Error(`配置校验失败: ${bad.join(", ")} 非法`);
  }
  // 与 initConfig 同款越界检查：--port 70000 之类在此拦截，不静默截断/回退
  const badRange = collectIntRangeErrors(out);
  if (badRange.length) {
    throw new Error(`配置校验失败: ${badRange.join(", ")} 越界`);
  }
  return out as Partial<AppConfig>;
}
