/**
 * 配置加载及初始化 - 全局唯一入口
 * 覆盖顺序：CLI > 终端环境变量 > env 文件 > 默认值
 * 设计：表驱动（FIELDS 描述全部字段），CLI 解析、env 合并、
 * store 写入、快照返回均由表自动生成；
 * 新增配置只需 store.ts 加字段 + 本表加一行，杜绝多处手工同步漂移
 */

import { config, getAll, defaults, type AppConfig, type ConfigKey } from "./store.js";
import { readAuthUsers } from "./auth-users.js";
import { readAcl } from "./acl.js";
import { logger } from "@/utils/logger.js";
import { parseUpstreamUrl, applyUpstreamUrl } from "@/utils/upstream-url.js";
import { RE_DASH_GLOBAL, RE_LEADING_DASHES } from "@/utils/constants.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

const CONFIG_DIR_NAME = ".proxy";

/** useHomeConfig 环境变量名（决定 env 文件读取目录，需在加载 env 文件前单独解析） */
const HOME_CONFIG_KEY = "USE_HOME_CONFIG";

/** 主目录 ~/.proxy 路径（Windows 取 %USERPROFILE%） */
function getHomeConfigDir(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}

/** 解析配置根目录 */
function getConfigDir(useHome: boolean): string {
  if (useHome) {
    return getHomeConfigDir();
  }
  return process.cwd();
}

/** 目录缺失时创建 */
function ensureConfigDir(useHome: boolean): void {
  const dir = getConfigDir(useHome);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

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

/**
 * 全量字段表 - 新增配置只需在此加一行
 * （CLI 解析/env 合并/store 写入/快照自动生效）
 */

/** 日志等级枚举：控制台（logLevel）与落盘（logFileLevel）共用，避免两处取值漂移 */
const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;

const FIELDS: FieldDef[] = [
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
  field({
    key: "tlsCa",
    env: "TLS_CA",
    parse: parseStr,
    def: (dir) => path.join(dir, defaults.tlsCa),
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
  field({ key: "useHomeConfig", env: HOME_CONFIG_KEY, parse: parseBool, phase: "startup" }),
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
 * 加载 env 文件到 process.env
 * - 候选（低 -> 高）：.env.production -> .env.development -> .env.<NODE_ENV>；
 *   NODE_ENV 未设时缺省拼 .env.development，与第二项重名去重后只读一次
 * - 终端已存在的变量不被覆盖（与 node --env-file / dotenv 默认一致：
 *   环境变量优先于 env 文件，保证启动命令能覆盖文件）；文件之间仍后者覆盖前者
 * - 手工 dotenv.parse 后写入；缺失文件跳过
 */
function loadEnvFiles(useHome: boolean): void {
  const configDir = getConfigDir(useHome);
  const candidates = [
    ".env.production",
    ".env.development",
    `.env.${process.env.NODE_ENV ?? "development"}`,
  ];
  // Set 保留首次出现，反向两轮即等价于「保留末次出现」的稳定去重
  const ordered = [...new Set(candidates.slice().reverse())].reverse();
  // 快照必须在写入任何文件之前取：文件之间仍按低->高覆盖，只挡终端来源
  const preset = new Set(Object.keys(process.env));
  for (const f of ordered) {
    const filePath = path.join(configDir, f);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const parsed = dotenv.parse(fs.readFileSync(filePath));
    for (const [k, v] of Object.entries(parsed)) {
      if (v !== undefined && !preset.has(k)) {
        process.env[k] = v;
      }
    }
  }
}

/**
 * CLI -> ENV 风格键值：归一（去前导 -、- 转 _、大写）使 --proxy-protocol 与 PROXY_PROTOCOL 同表命中
 *   --port 3000 / --port=3000 / PORT=3000 / --auth-enabled（无值即 "true"）
 *   "--" 跳过；--key 后非 - 开头 token 作为值消费（i++），否则记 "true"
 */
function parseRawArgv(argv: string[]): Record<string, string> {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (!arg.startsWith("-") && arg.includes("=")) {
      // indexOf/slice 而非 split("=", 2)：值本身可能含 "="（如 JWT_SECRET=Zm9v==），
      // split 截断会丢尾巴，与 --key=value 路径保持一致
      const eqIdx = arg.indexOf("=");
      const k = arg.slice(0, eqIdx);
      const v = arg.slice(eqIdx + 1);
      raw[k.replace(RE_LEADING_DASHES, "").replace(RE_DASH_GLOBAL, "_").toUpperCase()] = v;
      continue;
    }
    if (!arg.startsWith("-")) {
      continue;
    }
    arg = arg.replace(RE_LEADING_DASHES, "");
    const eqIdx = arg.indexOf("=");
    let key: string;
    let value: string;
    if (eqIdx !== -1) {
      key = arg.slice(0, eqIdx);
      value = arg.slice(eqIdx + 1);
    } else {
      key = arg;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        value = next;
        i++;
      } else {
        value = "true";
      }
    }
    raw[key.replace(RE_DASH_GLOBAL, "_").toUpperCase()] = value;
  }
  return raw;
}

/**
 * 整数范围校验（initConfig 与 parseStartupArgs 共用）
 * @description 遍历 FIELDS 的 `int` 约束，对已出现在 resolved 表中的字段检查整数性与上下界，
 * 返回 `ENV=value` 形式的越界清单（空数组表示全部合法）；未出现在表中的字段跳过（parseStartupArgs 只含显式提供的键）
 * @param resolved - 已解析的字段表（键为 `ConfigKey`）
 * @returns 越界字段的 `ENV=value` 列表
 * @example collectIntRangeErrors({ port: 70000 }) // => ["PORT=70000"]
 */
function collectIntRangeErrors(resolved: Record<string, unknown>): string[] {
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

/** 初始化幂等标记：模块加载时执行一次，重复调用直接返回快照 */
let _inited = false;

/**
 * 初始化全局配置：CLI > env 文件 > 终端 > 默认值
 * 显式给出的非法值（CLI/env 同源）、int 越界、账号/名单文件内容非法（users.json / acl.json）、
 * 以及 auth 交叉非法（启用 basic/uid 但账号表为空）
 * 一律抛错阻止启动，不做静默回退；幂等位仅在全部校验通过、store 写完后置位（失败后可重试且仍抛错）
 */
export function initConfig(): AppConfig {
  if (_inited) {
    return getAll();
  }

  const rawCli = parseRawArgv(process.argv.slice(2));

  // 先定 useHomeConfig（决定 env 目录；CLI > 终端 env）
  const homeRaw = rawCli[HOME_CONFIG_KEY] ?? process.env[HOME_CONFIG_KEY];
  // 值非法时先按 false 定位配置目录即可：下面的 FIELDS 循环会报错并终止启动
  const useHomeConfig = homeRaw === undefined ? false : (toBoolean(homeRaw) ?? false);

  loadEnvFiles(useHomeConfig);
  ensureConfigDir(useHomeConfig);
  const configDir = getConfigDir(useHomeConfig);

  const resolved: Record<string, unknown> = {};
  const bad: string[] = [];
  const provided = new Set<string>();
  for (const d of FIELDS) {
    // 显式给出的值（CLI 优先于 env）一律不允许静默丢弃：解析失败记入 bad，循环后统一抛错
    const cliRaw = rawCli[d.env];
    const raw = cliRaw ?? process.env[d.env];
    if (raw !== undefined) {
      provided.add(d.env);
      const v = d.parse(raw);
      if (v !== undefined) {
        resolved[d.key] = v;
        continue;
      }
      bad.push(`${d.env}=${raw}`);
    }
    if (d.def !== undefined) {
      if (typeof d.def === "function") {
        resolved[d.key] = d.def(configDir);
      } else {
        resolved[d.key] = d.def;
      }
    } else {
      resolved[d.key] = defaults[d.key];
    }
  }
  if (bad.length) {
    throw new Error(`配置校验失败: ${bad.join(", ")} 非法`);
  }

  // 上游标准 URL 整体覆盖拆项：配了 UPSTREAM_URL 时 granular 字段以它为准（已过 parseUpstreamUrl 校验）
  const upstreamUrlRaw = resolved.upstreamUrl as string;
  let clobbered: string[] = [];
  if (upstreamUrlRaw) {
    const before = new Map(Object.entries(resolved));
    applyUpstreamUrl(resolved, upstreamUrlRaw);
    // 显式提供了拆项、值又被 URL 改写：静默换值最难排查，收集起来等写库后再告警
    clobbered = FIELDS.filter(
      (d) => provided.has(d.env) && before.get(d.key) !== resolved[d.key],
    ).map((d) => d.env);
  }

  // 数值越界在此拦截（枚举已在表中由 parseEnum 保证合法）
  const badRange = collectIntRangeErrors(resolved);
  if (badRange.length) {
    throw new Error(`配置校验失败: ${badRange.join(", ")} 越界`);
  }

  // 账号表与访问控制名单来自独立 JSON 文件：启动期强制重读并校验内容，非法即 abort（不做静默降级）。
  // 此刻尚未写 store，故显式把解析出的路径传给读取器（其默认路径取自 store，会读到旧值）
  const usersRead = readAuthUsers({ force: true, path: resolved.authUsersFile as string });
  const aclRead = readAcl({ force: true, path: resolved.aclFile as string });
  const badFiles: string[] = [];
  if (usersRead.error) {
    badFiles.push(`AUTH_USERS_FILE=${usersRead.path} ${usersRead.error}`);
  }
  if (aclRead.error) {
    badFiles.push(`ACL_FILE=${aclRead.path} ${aclRead.error}`);
  }
  if (badFiles.length) {
    throw new Error(`配置校验失败: ${badFiles.join("; ")}`);
  }

  // 交叉字段校验（与 bad/badRange 同阶段、写 store 之前）：开启鉴权就必须真正能拦人，否则阻止启动
  assertAuthConfig({
    authEnabled: resolved.authEnabled as boolean,
    authType: resolved.authType as string,
    accountCount: usersRead.value.length,
    jwtSecret: resolved.jwtSecret as string,
  });

  for (const d of FIELDS) {
    config.set(d.key, resolved[d.key] as AppConfig[ConfigKey]);
  }

  // 全部解析/校验通过、store 已写：此刻置幂等位；此前任何一步抛错都不置位，
  // 从而首次失败后重试 initConfig() 会重跑并再次抛错，而非静默返回默认配置
  _inited = true;

  // 写库之后再告警：此刻 LOG_LEVEL/LOG_FILE 等已生效，告警不会绕过用户设定的等级
  if (clobbered.length) {
    logger.warn(`[config] UPSTREAM_URL 已设置，覆盖了同时提供的拆项: ${clobbered.join(", ")}`);
  }

  return getAll();
}

// import 即初始化：坏配置直接 throw、无降级，调用方（测试/孤立 import store）需 try/catch 或显式 initConfig()
initConfig();
