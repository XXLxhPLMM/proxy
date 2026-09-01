/**
 * 配置加载及初始化 - 全局唯一入口
 * 覆盖顺序：CLI > env 文件 > 终端 > 默认值
 */

import { config, getAll, type AppConfig } from "./store.js";
import fs from "node:fs";
import dotenv from "dotenv";
import { z } from "zod";

/**
 * 字符串转数字 - 空值/非有限数（NaN、Infinity）均回退默认值
 * @param value - 原始字符串（env 或 CLI 值）
 * @param fallback - 兜底值
 */
function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 字符串转布尔 - 兼容 true/1/yes/on/enable 与 false/0/no/off/disable 等常见写法
 * 无法识别时回退 fallback，避免误把拼写错误当成 false
 */
function toBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  const v = value.toLowerCase().trim();
  if (["true", "1", "yes", "on", "enable", "enabled"].includes(v)) return true;
  if (["false", "0", "no", "off", "disable", "disabled"].includes(v)) return false;
  return fallback;
}

/** 取首个存在的 env 值（兼容别名）- 按 keys 顺序命中即返回，用于同一配置的多环境变量名 */
function envPick(keys: string[]): string | undefined {
  for (const k of keys) if (process.env[k] !== undefined) return process.env[k];
  return undefined;
}
/** 取首个存在的 raw 值（CLI 解析后）- 与 envPick 同构，数据源换成命令行解析结果 */
function rawPick(raw: Record<string, string>, keys: string[]): string | undefined {
  for (const k of keys) if (raw[k] !== undefined) return raw[k];
  return undefined;
}

/**
 * 加载 env 文件并覆盖 process.env
 * - 候选顺序：.env.<NODE_ENV> -> .env.development -> .env.production，seen 去重防止 NODE_ENV 重复命中
 * - 用 dotenv.parse 手工解析后「覆盖」写入 process.env，
 *   使 env 文件优先级高于终端已有环境变量（与 package.json 的 --env-file-if-exists 行为对齐）
 * - 缺失文件跳过，不报错
 */
function loadEnvFiles(): void {
  const candidates = [`.env.${process.env.NODE_ENV ?? "development"}`, ".env.development", ".env.production"];
  const seen = new Set<string>();
  for (const f of candidates) {
    if (seen.has(f)) continue;
    seen.add(f);
    if (!fs.existsSync(f)) continue;
    const parsed = dotenv.parse(fs.readFileSync(f));
    for (const [k, v] of Object.entries(parsed)) if (v !== undefined) process.env[k] = v;
  }
}

/**
 * 解析命令行启动参数 -> Partial<AppConfig>
 * 支持的写法（等价，键名统一归一为 ENV 风格：去前导 -、- 转 _、大写）：
 *   --port 3000 / --port=3000 / PORT=3000 / --auth-enabled（无值即 "true"）
 * 规则：
 *   - "--" 单独出现直接跳过；不以 - 开头且含 = 视为 KEY=VALUE 直写
 *   - --key 后紧跟的非 - 开头 token 作为值消费掉（i++），否则值记为 "true"
 * 值合法性：枚举/数字类字段在此处做白名单与数值校验，非法值忽略（不落 out），
 *           最终由 initConfig 回退到 env 或默认值，保证 CLI 优先级最高但不会注入脏数据
 */
export function parseStartupArgs(argv: string[] = process.argv.slice(2)): Partial<AppConfig> {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === "--") continue;
    if (!arg.startsWith("-") && arg.includes("=")) {
      const [k, v] = arg.split("=", 2);
      raw[k.replace(/^-+/, "").replace(/-/g, "_").toUpperCase()] = v;
      continue;
    }
    if (!arg.startsWith("-")) continue;
    arg = arg.replace(/^-+/, "");
    const eqIdx = arg.indexOf("=");
    let key: string; let value: string;
    if (eqIdx !== -1) { key = arg.slice(0, eqIdx); value = arg.slice(eqIdx + 1); }
    else { key = arg; const next = argv[i + 1]; if (next !== undefined && !next.startsWith("-")) { value = next; i++; } else value = "true"; }
    raw[key.replace(/-/g, "_").toUpperCase()] = value;
  }

  const out: Partial<AppConfig> = {};
  const pick = (keys: string[]) => rawPick(raw, keys); // 多别名取首个命中
  const lowerPick = (keys: string[]) => pick(keys)?.toLowerCase(); // 枚举值统一小写比较

  // 逐字段映射：每个字段列出其 CLI 别名，命中且合法才写入 out
  const portRaw = pick(["PORT"]); if (portRaw !== undefined) { const n = Number(portRaw); if (Number.isFinite(n)) out.port = n; }
  const cacheRaw = lowerPick(["CACHE_TYPE", "CACHETYPE"]); if (cacheRaw === "memory" || cacheRaw === "redis") out.cacheType = cacheRaw as AppConfig["cacheType"];
  const proxyRaw = lowerPick(["PROXY_PROTOCOL", "PROXY_TYPE", "PROXY_SERVICE_TYPE"]); if (proxyRaw === "http" || proxyRaw === "https" || proxyRaw === "socks" || proxyRaw === "tls") out.proxyProtocol = proxyRaw as AppConfig["proxyProtocol"];
  const enabledRaw = pick(["AUTH_ENABLED", "APP_USE_AUTH", "USE_AUTH", "AUTH_SWITCH"]); if (enabledRaw !== undefined) out.authEnabled = toBoolean(enabledRaw, false);
  const authRaw = lowerPick(["AUTH_TYPE", "AUTHTYPE"]); if (authRaw === "none" || authRaw === "basic" || authRaw === "jwt") out.authType = authRaw as AppConfig["authType"];
  if (raw["AUTH_USERNAME"] !== undefined) out.authUsername = raw["AUTH_USERNAME"];
  if (raw["AUTH_PASSWORD"] !== undefined) out.authPassword = raw["AUTH_PASSWORD"];
  const jwtRaw = pick(["JWT_SECRET", "PROXY_SECRET", "JWT_KEY", "JWTSECRET"]); if (jwtRaw !== undefined) out.jwtSecret = jwtRaw;
  const authLoggingRaw = pick(["AUTH_LOGGING", "AUTH_LOG", "LOG_AUTH"]); if (authLoggingRaw !== undefined) out.authLogging = toBoolean(authLoggingRaw, true);
  const logRaw = lowerPick(["LOG_LEVEL", "LOGLEVEL"]); if (logRaw === "debug" || logRaw === "info" || logRaw === "warn" || logRaw === "error" || logRaw === "silent") out.logLevel = logRaw as AppConfig["logLevel"];
  const logFileRaw = pick(["LOG_FILE", "LOGFILE", "LOG_PATH"]); if (logFileRaw !== undefined) out.logFile = logFileRaw;
  const timeoutRaw = pick(["UPSTREAM_TIMEOUT", "PROXY_TIMEOUT", "TIMEOUT"]); if (timeoutRaw !== undefined) { const n = Number(timeoutRaw); if (Number.isFinite(n) && n > 0) out.upstreamTimeout = n; }
  const tlsKeyRaw = pick(["TLS_KEY", "TLS_KEY_PATH", "SSL_KEY"]); if (tlsKeyRaw !== undefined) out.tlsKey = tlsKeyRaw;
  const tlsCertRaw = pick(["TLS_CERT", "TLS_CERT_PATH", "SSL_CERT"]); if (tlsCertRaw !== undefined) out.tlsCert = tlsCertRaw;
  const tlsCaRaw = pick(["TLS_CA", "TLS_CA_PATH", "SSL_CA"]); if (tlsCaRaw !== undefined) out.tlsCa = tlsCaRaw;
  const tlsPassRaw = pick(["TLS_PASSPHRASE", "TLS_KEY_PASS", "SSL_PASSPHRASE", "PASSPHRASE"]); if (tlsPassRaw !== undefined) out.tlsPassphrase = tlsPassRaw;
  const upstreamHostRaw = pick(["UPSTREAM_HOST", "REMOTE_HOST", "PROXY_TARGET_HOST", "TARGET_HOST"]); if (upstreamHostRaw !== undefined) out.upstreamHost = upstreamHostRaw;
  const upstreamPortRaw = pick(["UPSTREAM_PORT", "REMOTE_PORT", "PROXY_TARGET_PORT", "TARGET_PORT"]); if (upstreamPortRaw !== undefined) { const n = Number(upstreamPortRaw); if (Number.isFinite(n)) out.upstreamPort = n; }
  const upstreamSecureRaw = pick(["UPSTREAM_SECURE", "REMOTE_SECURE", "PROXY_TARGET_SECURE", "TARGET_SECURE"]); if (upstreamSecureRaw !== undefined) out.upstreamSecure = toBoolean(upstreamSecureRaw, false);
  const upstreamUserRaw = pick(["UPSTREAM_USERNAME", "REMOTE_USERNAME", "PROXY_TARGET_USERNAME"]); if (upstreamUserRaw !== undefined) out.upstreamUsername = upstreamUserRaw;
  const upstreamPassRaw = pick(["UPSTREAM_PASSWORD", "REMOTE_PASSWORD", "PROXY_TARGET_PASSWORD"]); if (upstreamPassRaw !== undefined) out.upstreamPassword = upstreamPassRaw;
  const upstreamCaRaw = pick(["UPSTREAM_CA", "REMOTE_CA", "PROXY_TARGET_CA"]); if (upstreamCaRaw !== undefined) out.upstreamCa = upstreamCaRaw;
  const upstreamInsecureRaw = pick(["UPSTREAM_INSECURE", "REMOTE_INSECURE", "PROXY_TARGET_INSECURE"]); if (upstreamInsecureRaw !== undefined) out.upstreamInsecure = toBoolean(upstreamInsecureRaw, false);
  const upstreamProtoRaw = lowerPick(["UPSTREAM_PROTOCOL", "REMOTE_PROTOCOL", "PROXY_UPSTREAM_PROTOCOL", "UPSTREAM_TYPE"]); if (upstreamProtoRaw === "http" || upstreamProtoRaw === "https" || upstreamProtoRaw === "socks" || upstreamProtoRaw === "tls") out.upstreamProtocol = upstreamProtoRaw as AppConfig["upstreamProtocol"];
  const modeRaw = lowerPick(["PROXY_MODE", "MODE", "RUN_MODE"]); if (modeRaw === "server" || modeRaw === "client") out.proxyMode = modeRaw as AppConfig["proxyMode"]; else if (modeRaw === "true" || modeRaw === "1") out.proxyMode = "client";
  const clusterRaw = pick(["CLUSTER_WORKERS", "WORKERS"]); if (clusterRaw !== undefined) { const n = Number(clusterRaw); if (Number.isFinite(n) && n >= 0) out.clusterWorkers = Math.floor(n); }
  return out;
}

/** 初始化幂等标记：模块加载时执行一次，重复调用直接返回快照 */
let _inited = false;

/**
 * 初始化全局配置 - 收敛三层优先级并写入 store
 * 优先级：CLI 参数 > env 文件（已由 loadEnvFiles 覆盖进 process.env）> 终端环境变量 > 默认值
 * 步骤：
 *   1) loadEnvFiles 把 env 文件灌进 process.env
 *   2) parseStartupArgs 解析 CLI
 *   3) 逐字段 `cli.x ?? env ?? default` 合并（?? 短路保证 CLI 命中即胜出）
 *   4) zod schema 校验关键枚举/范围，失败抛错阻止启动
 *   5) 全量写入 config Map（store.ts 单例），供 get() 读取
 * @returns 最终生效的完整配置
 */
export function initConfig(): AppConfig {
  if (_inited) return getAll();
  _inited = true;
  loadEnvFiles();
  const cli = parseStartupArgs();

  // 合并阶段：每个字段依次尝试 CLI 值、env 别名、硬编码默认值
  const port = toNumber(cli.port !== undefined ? String(cli.port) : envPick(["PORT"]), 3000);
  const cacheType = cli.cacheType ?? (envPick(["CACHE_TYPE", "CACHETYPE"])?.toLowerCase() as AppConfig["cacheType"] | undefined) ?? "memory";
  const proxyProtocol = cli.proxyProtocol ?? (envPick(["PROXY_PROTOCOL", "PROXY_TYPE", "PROXY_SERVICE_TYPE"])?.toLowerCase() as AppConfig["proxyProtocol"] | undefined) ?? "http";
  const authEnabled = cli.authEnabled ?? toBoolean(envPick(["AUTH_ENABLED", "APP_USE_AUTH", "USE_AUTH", "AUTH_SWITCH"]), false);
  const authType = cli.authType ?? (envPick(["AUTH_TYPE", "AUTHTYPE"])?.toLowerCase() as AppConfig["authType"] | undefined) ?? "none";
  const authUsername = cli.authUsername ?? envPick(["AUTH_USERNAME"]) ?? "";
  const authPassword = cli.authPassword ?? envPick(["AUTH_PASSWORD"]) ?? "";
  const jwtSecret = cli.jwtSecret ?? envPick(["JWT_SECRET", "PROXY_SECRET", "JWT_KEY", "JWTSECRET"]) ?? "";
  const authLogging = cli.authLogging ?? toBoolean(envPick(["AUTH_LOGGING", "AUTH_LOG", "LOG_AUTH"]), true);
  const logLevel = cli.logLevel ?? (envPick(["LOG_LEVEL", "LOGLEVEL"])?.toLowerCase() as AppConfig["logLevel"] | undefined) ?? "info";
  const logFile = cli.logFile ?? envPick(["LOG_FILE", "LOGFILE", "LOG_PATH"]) ?? "log";
  const _upstreamTimeout = cli.upstreamTimeout ?? (() => { const v = envPick(["UPSTREAM_TIMEOUT", "PROXY_TIMEOUT", "TIMEOUT"]); if (v === undefined) return undefined; const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined; })() ?? 10000;
  const tlsKey = cli.tlsKey ?? envPick(["TLS_KEY", "TLS_KEY_PATH", "SSL_KEY"]) ?? "keys/server.key";
  const tlsCert = cli.tlsCert ?? envPick(["TLS_CERT", "TLS_CERT_PATH", "SSL_CERT"]) ?? "keys/server.crt";
  const tlsCa = cli.tlsCa ?? envPick(["TLS_CA", "TLS_CA_PATH", "SSL_CA"]) ?? "keys/ca.crt";
  const tlsPassphrase = cli.tlsPassphrase ?? envPick(["TLS_PASSPHRASE", "TLS_KEY_PASS", "SSL_PASSPHRASE", "PASSPHRASE"]) ?? "";
  const upstreamHost = cli.upstreamHost ?? envPick(["UPSTREAM_HOST", "REMOTE_HOST", "PROXY_TARGET_HOST", "TARGET_HOST"]) ?? "127.0.0.1";
  const upstreamPort = toNumber(cli.upstreamPort !== undefined ? String(cli.upstreamPort) : envPick(["UPSTREAM_PORT", "REMOTE_PORT", "PROXY_TARGET_PORT", "TARGET_PORT"]), 3000);
  const upstreamSecure = cli.upstreamSecure ?? toBoolean(envPick(["UPSTREAM_SECURE", "REMOTE_SECURE", "PROXY_TARGET_SECURE", "TARGET_SECURE"]), false);
  const upstreamUsername = cli.upstreamUsername ?? envPick(["UPSTREAM_USERNAME", "REMOTE_USERNAME", "PROXY_TARGET_USERNAME"]) ?? "";
  const upstreamPassword = cli.upstreamPassword ?? envPick(["UPSTREAM_PASSWORD", "REMOTE_PASSWORD", "PROXY_TARGET_PASSWORD"]) ?? "";
  const upstreamCa = cli.upstreamCa ?? envPick(["UPSTREAM_CA", "REMOTE_CA", "PROXY_TARGET_CA"]) ?? "keys/ca.crt";
  const upstreamInsecure = cli.upstreamInsecure ?? toBoolean(envPick(["UPSTREAM_INSECURE", "REMOTE_INSECURE", "PROXY_TARGET_INSECURE"]), false);
  const upstreamProtocol = cli.upstreamProtocol ?? (envPick(["UPSTREAM_PROTOCOL", "REMOTE_PROTOCOL", "PROXY_UPSTREAM_PROTOCOL", "UPSTREAM_TYPE"])?.toLowerCase() as AppConfig["upstreamProtocol"] | undefined) ?? "http";
  const proxyMode = cli.proxyMode ?? (envPick(["PROXY_MODE", "MODE", "RUN_MODE"])?.toLowerCase() as AppConfig["proxyMode"] | undefined) ?? "server";
  const clusterWorkers = cli.clusterWorkers ?? (() => { const v = envPick(["CLUSTER_WORKERS", "WORKERS"]); if (v === undefined) return undefined; const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined; })() ?? 1;

  // 校验阶段：仅对枚举与数值范围做硬校验（字符串/布尔字段已在合并阶段归一，无需再验）
  const schema = z.object({
    port: z.number().int().min(1).max(65535),
    cacheType: z.enum(["memory", "redis"]),
    proxyProtocol: z.enum(["http", "https", "socks", "tls"]),
    upstreamProtocol: z.enum(["http", "https", "socks", "tls"]),
    authType: z.enum(["none", "basic", "jwt"]),
    logLevel: z.enum(["debug", "info", "warn", "error", "silent"]),
    upstreamTimeout: z.number().int().positive(),
    proxyMode: z.enum(["server", "client"]),
    upstreamPort: z.number().int().min(1).max(65535),
    clusterWorkers: z.number().int().min(0).max(1024),
  });
  const candidate = { port, cacheType, proxyProtocol, upstreamProtocol, authType, logLevel, upstreamTimeout: _upstreamTimeout, proxyMode, upstreamPort, clusterWorkers };
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) throw new Error(`配置校验失败: ${parsed.error.message}`);

  // 写入阶段：校验通过后全量写入 store，覆盖 defaults，此后 get() 读到的即最终生效值
  const finalUpstream = _upstreamTimeout;
  config.set("port", port);
  config.set("cacheType", cacheType);
  config.set("proxyProtocol", proxyProtocol);
  config.set("authEnabled", authEnabled);
  config.set("authType", authType);
  config.set("authUsername", authUsername);
  config.set("authPassword", authPassword);
  config.set("jwtSecret", jwtSecret);
  config.set("authLogging", authLogging);
  config.set("logLevel", logLevel);
  config.set("logFile", logFile);
  config.set("upstreamTimeout", finalUpstream);
  config.set("tlsKey", tlsKey);
  config.set("tlsCert", tlsCert);
  config.set("tlsCa", tlsCa);
  config.set("tlsPassphrase", tlsPassphrase);
  config.set("upstreamHost", upstreamHost);
  config.set("upstreamPort", upstreamPort);
  config.set("upstreamSecure", upstreamSecure);
  config.set("upstreamUsername", upstreamUsername);
  config.set("upstreamPassword", upstreamPassword);
  config.set("upstreamCa", upstreamCa);
  config.set("upstreamInsecure", upstreamInsecure);
  config.set("upstreamProtocol", upstreamProtocol);
  config.set("proxyMode", proxyMode);
  config.set("clusterWorkers", clusterWorkers);

  // 返回完整快照（与 store 内容一致），便于调用方一次性拿到全部配置
  return { port, cacheType, proxyProtocol, authEnabled, authType, authUsername, authPassword, jwtSecret, authLogging, logLevel, logFile, upstreamTimeout: finalUpstream, tlsKey, tlsCert, tlsCa, tlsPassphrase, upstreamHost, upstreamPort, upstreamSecure, upstreamUsername, upstreamPassword, upstreamCa, upstreamInsecure, upstreamProtocol, proxyMode, clusterWorkers } as AppConfig;
}

// 模块被导入时即完成初始化（src/index.ts 以副作用方式 import 本文件）
initConfig();
