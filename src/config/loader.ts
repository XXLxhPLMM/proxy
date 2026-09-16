/**
 * 配置加载及初始化 - 全局唯一入口
 * 覆盖顺序：CLI > 终端环境变量 > env 文件 > 默认值
 * 设计：表驱动（FIELDS 描述全部字段），CLI 解析、env 合并、
 * store 写入、快照返回均由表自动生成；
 * 新增配置只需 store.ts 加字段 + 本表加一行，杜绝多处手工同步漂移
 */

import { config, getAll, defaults, type AppConfig, type ConfigKey } from "./store.js";
import { parseUpstreamUrl, applyUpstreamUrl } from "@/utils/upstream-url.js";
import { RE_DASH_GLOBAL, RE_LEADING_DASHES } from "@/utils/constants.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

const CONFIG_DIR_NAME = ".proxy";

/** useHomeConfig 的别名（决定 env 文件读取目录，需在加载 env 文件前单独解析） */
const HOME_CONFIG_ALIASES = ["USE_HOME_CONFIG", "HOME_CONFIG", "GLOBAL_CONFIG"];

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

/**
 * 按 keys 顺序取首个命中值
 * （CLI 解析结果与 process.env 共用同一别名表）
 */
function pickFirst(src: Record<string, string | undefined>, keys: string[]): string | undefined {
  for (const k of keys) {
    if (src[k] !== undefined) {
      return src[k];
    }
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
  /**
   * 环境变量名列表（首个命中生效）；
   * CLI 别名同源，--key-name / KEY=VALUE 归一为 KEY_NAME
   */
  aliases: string[];
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
const FIELDS: FieldDef[] = [
  field({ key: "host", aliases: ["HOST"], parse: parseStr, phase: "startup" }),
  field({
    key: "port",
    aliases: ["PORT"],
    parse: parseNum,
    int: { min: 1, max: 65535 },
    phase: "startup",
  }),
  field({
    key: "cacheType",
    aliases: ["CACHE_TYPE", "CACHETYPE"],
    parse: parseEnum(["memory", "redis"] as const),
    phase: "runtime",
  }),
  // http=明文+CONNECT，https=TLS+HTTP；socks4/socks5=明文分版本，sockss*=over TLS；改取值需同步 core/types/proxy.ts
  field({
    key: "proxyProtocol",
    aliases: ["PROXY_PROTOCOL", "PROXY_TYPE", "PROXY_SERVICE_TYPE"],
    parse: parseEnum(["http", "https", "socks4", "socks5", "sockss4", "sockss5"] as const),
    phase: "startup",
  }),
  field({
    key: "authEnabled",
    aliases: ["AUTH_ENABLED", "APP_USE_AUTH", "USE_AUTH", "AUTH_SWITCH"],
    parse: parseBool,
    phase: "runtime",
  }),
  field({
    key: "authType",
    aliases: ["AUTH_TYPE", "AUTHTYPE"],
    parse: parseEnum(["none", "basic", "jwt", "uid"] as const),
    phase: "runtime",
  }),
  field({
    key: "authUsername",
    aliases: ["AUTH_USERNAME"],
    parse: parseStr,
    phase: "runtime",
  }),
  field({
    key: "authPassword",
    aliases: ["AUTH_PASSWORD"],
    parse: parseStr,
    phase: "runtime",
  }),
  field({
    key: "jwtSecret",
    aliases: ["JWT_SECRET", "PROXY_SECRET", "JWT_KEY", "JWTSECRET"],
    parse: parseStr,
    phase: "runtime",
  }),
  field({
    key: "authLogging",
    aliases: ["AUTH_LOGGING", "AUTH_LOG", "LOG_AUTH"],
    parse: parseBool,
    phase: "runtime",
  }),
  field({
    key: "logLevel",
    aliases: ["LOG_LEVEL", "LOGLEVEL"],
    parse: parseEnum(["debug", "info", "warn", "error", "silent"] as const),
    phase: "runtime",
  }),
  field({
    key: "logFile",
    aliases: ["LOG_FILE", "LOGFILE", "LOG_PATH"],
    parse: parseStr,
    def: (dir) => path.join(dir, defaults.logFile),
    phase: "runtime",
  }),
  field({
    key: "upstreamTimeout",
    aliases: ["UPSTREAM_TIMEOUT", "PROXY_TIMEOUT", "TIMEOUT"],
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
    aliases: ["TLS_KEY", "TLS_KEY_PATH", "SSL_KEY"],
    parse: parseStr,
    def: (dir) => path.join(dir, defaults.tlsKey),
    phase: "startup",
  }),
  field({
    key: "tlsCert",
    aliases: ["TLS_CERT", "TLS_CERT_PATH", "SSL_CERT"],
    parse: parseStr,
    def: (dir) => path.join(dir, defaults.tlsCert),
    phase: "startup",
  }),
  field({
    key: "tlsCa",
    aliases: ["TLS_CA", "TLS_CA_PATH", "SSL_CA"],
    parse: parseStr,
    def: (dir) => path.join(dir, defaults.tlsCa),
    phase: "startup",
  }),
  field({
    key: "tlsPassphrase",
    aliases: ["TLS_PASSPHRASE", "TLS_KEY_PASS", "SSL_PASSPHRASE", "PASSPHRASE"],
    parse: parseStr,
    phase: "startup",
  }),
  field({
    key: "upstreamUrl",
    aliases: ["UPSTREAM_URL", "REMOTE_URL"],
    parse: parseUpstreamUrl,
    def: "",
    phase: "runtime",
  }),
  field({
    key: "upstreamHost",
    aliases: ["UPSTREAM_HOST", "REMOTE_HOST", "PROXY_TARGET_HOST", "TARGET_HOST"],
    parse: parseStr,
    phase: "runtime",
  }),
  field({
    key: "upstreamPort",
    aliases: ["UPSTREAM_PORT", "REMOTE_PORT", "PROXY_TARGET_PORT", "TARGET_PORT"],
    parse: parseNum,
    int: { min: 1, max: 65535 },
    phase: "runtime",
  }),
  field({
    key: "upstreamSecure",
    aliases: ["UPSTREAM_SECURE", "REMOTE_SECURE", "PROXY_TARGET_SECURE", "TARGET_SECURE"],
    parse: parseBool,
    phase: "runtime",
  }),
  field({
    key: "upstreamUsername",
    aliases: ["UPSTREAM_USERNAME", "REMOTE_USERNAME", "PROXY_TARGET_USERNAME"],
    parse: parseStr,
    phase: "runtime",
  }),
  field({
    key: "upstreamPassword",
    aliases: ["UPSTREAM_PASSWORD", "REMOTE_PASSWORD", "PROXY_TARGET_PASSWORD"],
    parse: parseStr,
    phase: "runtime",
  }),
  field({
    key: "upstreamCa",
    aliases: ["UPSTREAM_CA", "REMOTE_CA", "PROXY_TARGET_CA"],
    parse: parseStr,
    def: (dir) => path.join(dir, defaults.upstreamCa),
    phase: "runtime",
  }),
  field({
    key: "upstreamInsecure",
    aliases: ["UPSTREAM_INSECURE", "REMOTE_INSECURE", "PROXY_TARGET_INSECURE"],
    parse: parseBool,
    phase: "runtime",
  }),
  field({
    key: "upstreamProtocol",
    aliases: ["UPSTREAM_PROTOCOL", "REMOTE_PROTOCOL", "PROXY_UPSTREAM_PROTOCOL", "UPSTREAM_TYPE"],
    parse: parseEnum(["http", "https", "socks4", "socks5", "sockss4", "sockss5"] as const),
    phase: "runtime",
  }),
  // proxyMode：--mode true / --mode 1 视为 client
  field({
    key: "proxyMode",
    aliases: ["PROXY_MODE", "MODE", "RUN_MODE"],
    parse: (v) => {
      const s = v.toLowerCase().trim();
      if (s === "server" || s === "client") {
        return s;
      }
      if (s === "true" || s === "1") {
        return "client";
      }
      return undefined;
    },
    phase: "runtime",
  }),
  field({
    key: "clusterWorkers",
    aliases: ["CLUSTER_WORKERS", "WORKERS"],
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
  field({
    key: "useHomeConfig",
    aliases: HOME_CONFIG_ALIASES,
    parse: parseBool,
    phase: "runtime",
  }),
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
      const [k, v] = arg.split("=", 2);
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
 * 解析命令行启动参数 -> Partial<AppConfig>
 * 与 initConfig 共用同一张 FIELDS 表与同一套校验：显式给出的非法值直接抛错，
 * 不做静默丢弃（静默回退会让 --port banana 悄悄跑在默认端口上）
 */
export function parseStartupArgs(argv: string[] = process.argv.slice(2)): Partial<AppConfig> {
  const raw = parseRawArgv(argv);
  const out: Record<string, unknown> = {};
  const bad: string[] = [];
  for (const d of FIELDS) {
    const v = pickFirst(raw, d.aliases);
    if (v === undefined) {
      continue;
    }
    const parsed = d.parse(v);
    if (parsed === undefined) {
      bad.push(`${d.aliases[0]}=${v}`);
      continue;
    }
    out[d.key] = parsed;
  }
  if (bad.length) {
    throw new Error(`配置校验失败: ${bad.join(", ")} 非法`);
  }
  return out as Partial<AppConfig>;
}

/** 初始化幂等标记：模块加载时执行一次，重复调用直接返回快照 */
let _inited = false;

/**
 * 初始化全局配置：CLI > env 文件 > 终端 > 默认值
 * 显式给出的非法值（CLI/env 同源）与 int 越界一律抛错阻止启动，不做静默回退
 */
export function initConfig(): AppConfig {
  if (_inited) {
    return getAll();
  }
  _inited = true;

  const rawCli = parseRawArgv(process.argv.slice(2));

  // 先定 useHomeConfig（决定 env 目录；CLI > 终端 env）
  const homeRaw =
    pickFirst(rawCli, HOME_CONFIG_ALIASES) ?? pickFirst(process.env, HOME_CONFIG_ALIASES);
  // 值非法时先按 false 定位配置目录即可：下面的 FIELDS 循环会报错并终止启动
  const useHomeConfig = homeRaw === undefined ? false : (toBoolean(homeRaw) ?? false);

  loadEnvFiles(useHomeConfig);
  ensureConfigDir(useHomeConfig);
  const configDir = getConfigDir(useHomeConfig);

  const resolved: Record<string, unknown> = {};
  const bad: string[] = [];
  for (const d of FIELDS) {
    // 显式给出的值（CLI 优先于 env）一律不允许静默丢弃：解析失败记入 bad，循环后统一抛错
    const cliRaw = pickFirst(rawCli, d.aliases);
    const raw = cliRaw ?? pickFirst(process.env, d.aliases);
    if (raw !== undefined) {
      const v = d.parse(raw);
      if (v !== undefined) {
        resolved[d.key] = v;
        continue;
      }
      bad.push(`${d.aliases[0]}=${raw}`);
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
  if (upstreamUrlRaw) {
    applyUpstreamUrl(resolved, upstreamUrlRaw);
  }

  // 数值越界在此拦截（枚举已在表中由 parseEnum 保证合法）
  const badRange: string[] = [];
  for (const d of FIELDS) {
    if (d.int === undefined) {
      continue;
    }
    const v = resolved[d.key] as number;
    const { min, max } = d.int;
    if (!Number.isInteger(v) || (min !== undefined && v < min) || (max !== undefined && v > max)) {
      badRange.push(`${d.aliases[0]}=${v}`);
    }
  }
  if (badRange.length) {
    throw new Error(`配置校验失败: ${badRange.join(", ")} 越界`);
  }

  for (const d of FIELDS) {
    config.set(d.key, resolved[d.key] as AppConfig[ConfigKey]);
  }

  return getAll();
}

// import 即初始化：坏配置直接 throw、无降级，调用方（测试/孤立 import store）需 try/catch 或显式 initConfig()
initConfig();
