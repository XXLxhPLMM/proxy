/**
 * 字段表数据 + 表查询 - env 名的唯一真相源
 *
 * 新增配置只需在此加一行（`load.initConfig` / `source.argv.parseStartupArgs` /
 * runtime candidate 校验自动生效）。表里的解析器与范围约束来自 `field.ts`，
 * 基于表的校验在 `validate.ts`，跨字段守卫在 `guards.ts`。
 *
 * 硬规则：**不许在别处再建第二张 env 名表。** 机器可读源是本文件，
 * 用户可见清单是 `src/config/AGENTS.md` 的 env 表（人工同步）。
 */
import path from "node:path";

import { defaults } from "../defaults.js";
import { parseUpstreamUrl } from "../upstream-url.js";
import { PRESET_NAMES } from "../presets.js";
import type { ConfigKey } from "../types.js";
import {
  field,
  parseBoolean,
  parseEnum,
  parseNum,
  parseStr,
  type FieldDef,
} from "./field.js";

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
  field({ key: "authEnabled", env: "AUTH_ENABLED", parse: parseBoolean, phase: "runtime" }),
  field({
    key: "authType",
    env: "AUTH_TYPE",
    parse: parseEnum(["none", "basic", "jwt", "uid"] as const),
    phase: "runtime",
  }),
  // 账号表在 cfg/users.json（AUTH_USERS_FILE 指向），本表只存路径；内容校验见 load 的启动期强校验
  field({
    key: "authUsersFile",
    env: "AUTH_USERS_FILE",
    parse: parseStr,
    def: (dir) => path.join(dir, defaults.authUsersFile),
    phase: "runtime",
  }),
  field({ key: "jwtSecret", env: "JWT_SECRET", parse: parseStr, phase: "runtime" }),
  field({ key: "authLogging", env: "AUTH_LOGGING", parse: parseBoolean, phase: "runtime" }),
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
      return n !== undefined && n > 0 ? n : undefined;
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
    // 空串仍表示不启用；函数形式标记它是配置目录相对路径，供 preset 解析复用。
    def: () => "",
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
  field({ key: "upstreamSecure", env: "UPSTREAM_SECURE", parse: parseBoolean, phase: "runtime" }),
  field({ key: "upstreamUsername", env: "UPSTREAM_USERNAME", parse: parseStr, phase: "runtime" }),
  field({ key: "upstreamPassword", env: "UPSTREAM_PASSWORD", parse: parseStr, phase: "runtime" }),
  field({
    key: "upstreamCa",
    env: "UPSTREAM_CA",
    parse: parseStr,
    // 空串表示系统信任库；函数形式标记它是配置目录相对路径，供 preset 解析复用。
    def: () => "",
    phase: "runtime",
  }),
  field({
    key: "upstreamInsecure",
    env: "UPSTREAM_INSECURE",
    parse: parseBoolean,
    phase: "runtime",
  }),
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
    key: "preset",
    env: "PRESET",
    parse: parseEnum(PRESET_NAMES),
    phase: "startup",
    def: "",
  }),
  field({
    key: "clusterWorkers",
    env: "CLUSTER_WORKERS",
    int: { min: 0, max: 1024 },
    // 小数向下截断；0=按 CPU 核数，负数丢弃回默认
    parse: (v) => {
      const n = parseNum(v);
      return n !== undefined && n >= 0 ? Math.floor(n) : undefined;
    },
    phase: "startup",
  }),
  // useHomeConfig 只在启动期生效：决定 env 文件读取目录与各路径默认值，运行中改动无意义
  field({ key: "useHomeConfig", env: "USE_HOME_CONFIG", parse: parseBoolean, phase: "startup" }),
];

const FIELD_BY_KEY = new Map<ConfigKey, FieldDef>(
  FIELDS.map((definition) => [definition.key, definition]),
);

/** 运行时是否识别某个配置键；不维护第二张字段/环境变量表。 */
export function isConfigKey(value: string): value is ConfigKey {
  return FIELD_BY_KEY.has(value as ConfigKey);
}

/** 取字段定义；未知键返回 undefined。 */
export function getFieldDef(key: ConfigKey): FieldDef | undefined {
  return FIELD_BY_KEY.get(key);
}

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
