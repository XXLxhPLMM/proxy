/**
 * 配置加载及初始化 - 全局唯一入口
 * 职责：解析启动参数 + 读取环境变量，初始化 store 的 Map
 * 覆盖顺序：启动参数 > env 文件 > 直接设置终端环境变量 > 默认值
 * - 启动参数：--port / --cache-type 等（parseStartupArgs 解析）
 * - env 文件：node --env-file / pnpm start:dev 注入到 process.env 的值
 * - 终端环境变量：PORT=xxx node dist/app.js 等直接注入
 * 注意：env 文件与终端变量均落在 process.env，为实现 env 文件 > 终端，
 * 会先以 dotenv 覆写（override:true）加载对应 env 文件，再取 process.env
 * 加载时机：模块被 import 时自动执行一次 initConfig()
 */

import { config, getAll, type AppConfig } from "./store.js";
import fs from "node:fs";
import dotenv from "dotenv";

function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback; // 空值回退默认值
  const n = Number(value); // 显式数字转换
  return Number.isFinite(n) ? n : fallback; // 非数字回退，避免 NaN 污染
}

function toBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback; // 未配置回退
  const v = value.toLowerCase().trim(); // 归一化大小写
  if (["true", "1", "yes", "on", "enable", "enabled"].includes(v)) return true; // 真值白名单
  if (["false", "0", "no", "off", "disable", "disabled"].includes(v)) return false; // 假值白名单
  return fallback; // 无法识别回退
}

/**
 * 按 env 文件 > 终端 的优先级加载 env 文件（覆写终端同名变量）
 * 依次尝试 .env / .env.development 等，存在即 override 加载
 */
function loadEnvFiles(): void {
  const candidates = [`.env.${process.env.NODE_ENV ?? "development"}`, ".env.development", ".env.production"];
  const seen = new Set<string>();
  for (const f of candidates) {
    if (seen.has(f)) continue;
    seen.add(f);
    if (!fs.existsSync(f)) continue;
    const parsed = dotenv.parse(fs.readFileSync(f));
    // env 文件覆写终端：直接写入 process.env 覆盖
    for (const [k, v] of Object.entries(parsed)) {
      if (v !== undefined) process.env[k] = v;
    }
  }
}

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
    const nk = key.replace(/-/g, "_").toUpperCase();
    raw[nk] = value;
  }

  const out: Partial<AppConfig> = {};
  const portRaw = raw["PORT"];
  if (portRaw !== undefined) {
    const n = Number(portRaw);
    if (Number.isFinite(n)) out.port = n;
  }
  const cacheRaw = (raw["CACHE_TYPE"] ?? raw["CACHETYPE"] ?? "").toLowerCase();
  if (cacheRaw === "memory" || cacheRaw === "redis") out.cacheType = cacheRaw as AppConfig["cacheType"];
  /**
   * 代理协议 - 双端语义，需同时满足客户端与服务端：
   * - 客户端：决定以何种握手语义连接本代理（如 http 用 Proxy-Authorization + CONNECT，socks 用 RFC1928 帧）
   * - 服务端：决定本代理以何种语义对外提供服务及解析入站流量
   * CLI：--proxy-protocol=http | 环境：PROXY_PROTOCOL（主）兼容 PROXY_TYPE/PROXY_SERVICE_TYPE
   */
  const proxyRaw = (
    raw["PROXY_PROTOCOL"] ??
    raw["PROXY_TYPE"] ??
    raw["PROXY_SERVICE_TYPE"] ??
    ""
  ).toLowerCase();
  if (proxyRaw === "http" || proxyRaw === "https" || proxyRaw === "socks" || proxyRaw === "tls")
    out.proxyProtocol = proxyRaw as AppConfig["proxyProtocol"];
  // 鉴权开关：AUTH_ENABLED / APP_USE_AUTH / USE_AUTH / AUTH_SWITCH 兼容
  const enabledRaw =
    raw["AUTH_ENABLED"] ?? raw["APP_USE_AUTH"] ?? raw["USE_AUTH"] ?? raw["AUTH_SWITCH"];
  if (enabledRaw !== undefined) out.authEnabled = toBoolean(enabledRaw, false);
  const authRaw = (raw["AUTH_TYPE"] ?? raw["AUTHTYPE"] ?? "").toLowerCase();
  if (authRaw === "none" || authRaw === "basic" || authRaw === "jwt") out.authType = authRaw as AppConfig["authType"];
  if (raw["AUTH_USERNAME"] !== undefined) out.authUsername = raw["AUTH_USERNAME"];
  if (raw["AUTH_PASSWORD"] !== undefined) out.authPassword = raw["AUTH_PASSWORD"];
  // 兼容多种命名：JWT_SECRET / PROXY_SECRET / JWT_KEY / JWTSECRET
  const jwtRaw = raw["JWT_SECRET"] ?? raw["PROXY_SECRET"] ?? raw["JWT_KEY"] ?? raw["JWTSECRET"];
  if (jwtRaw !== undefined) out.jwtSecret = jwtRaw;
  // 鉴权日志开关：AUTH_LOGGING / AUTH_LOG / LOG_AUTH（默认 true）
  const authLoggingRaw = raw["AUTH_LOGGING"] ?? raw["AUTH_LOG"] ?? raw["LOG_AUTH"];
  if (authLoggingRaw !== undefined) out.authLogging = toBoolean(authLoggingRaw, true);
  // 日志等级：LOG_LEVEL / LOGLEVEL
  const logRaw = (raw["LOG_LEVEL"] ?? raw["LOGLEVEL"] ?? "").toLowerCase();
  if (logRaw === "debug" || logRaw === "info" || logRaw === "warn" || logRaw === "error" || logRaw === "silent")
    out.logLevel = logRaw as AppConfig["logLevel"];
  // 日志文件：LOG_FILE / LOGFILE / LOG_PATH
  const logFileRaw = raw["LOG_FILE"] ?? raw["LOGFILE"] ?? raw["LOG_PATH"];
  if (logFileRaw !== undefined) out.logFile = logFileRaw;
  // 上游超时：UPSTREAM_TIMEOUT / PROXY_TIMEOUT / TIMEOUT（ms），CLI：--upstream-timeout
  const timeoutRaw = raw["UPSTREAM_TIMEOUT"] ?? raw["PROXY_TIMEOUT"] ?? raw["TIMEOUT"];
  if (timeoutRaw !== undefined) {
    const n = Number(timeoutRaw);
    if (Number.isFinite(n) && n > 0) out.upstreamTimeout = n;
  }
  // TLS 证书路径：优先级 CLI > env 文件 > 终端 > 默认；兼容多种命名
  const tlsKeyRaw = raw["TLS_KEY"] ?? raw["TLS_KEY_PATH"] ?? raw["SSL_KEY"];
  if (tlsKeyRaw !== undefined) out.tlsKey = tlsKeyRaw;
  const tlsCertRaw = raw["TLS_CERT"] ?? raw["TLS_CERT_PATH"] ?? raw["SSL_CERT"];
  if (tlsCertRaw !== undefined) out.tlsCert = tlsCertRaw;
  const tlsCaRaw = raw["TLS_CA"] ?? raw["TLS_CA_PATH"] ?? raw["SSL_CA"];
  if (tlsCaRaw !== undefined) out.tlsCa = tlsCaRaw;
  const tlsPassphraseRaw =
    raw["TLS_PASSPHRASE"] ?? raw["TLS_KEY_PASS"] ?? raw["SSL_PASSPHRASE"] ?? raw["PASSPHRASE"];
  if (tlsPassphraseRaw !== undefined) out.tlsPassphrase = tlsPassphraseRaw;
  return out;
}

let _inited = false;

export function initConfig(): AppConfig {
  if (_inited) return getAll();
  _inited = true;

  // env 文件 > 终端：覆写加载后，process.env 已体现该优先级
  loadEnvFiles();

  const cli = parseStartupArgs();
  // 覆盖顺序：CLI > env 文件 > 终端 > 默认值（此时 process.env 已是 env 文件覆写终端后的结果）
  const port = toNumber(cli.port !== undefined ? String(cli.port) : process.env.PORT, 3000);
  const envCacheRaw = (process.env.CACHE_TYPE ?? process.env.CACHETYPE ?? "").toLowerCase();
  const envCacheType = envCacheRaw === "memory" || envCacheRaw === "redis" ? envCacheRaw : undefined;
  const cacheType = cli.cacheType ?? (envCacheType as AppConfig["cacheType"]) ?? "memory";

  // 代理协议同上，优先级 CLI > env文件 > 终端 > 默认 http；env文件已在 loadEnvFiles 阶段覆写到 process.env
  const envProxyRaw = (
    process.env.PROXY_PROTOCOL ??
    process.env.PROXY_TYPE ??
    process.env.PROXY_SERVICE_TYPE ??
    ""
  ).toLowerCase();
  const envProxyType =
    envProxyRaw === "http" || envProxyRaw === "https" || envProxyRaw === "socks" || envProxyRaw === "tls"
      ? envProxyRaw
      : undefined;
  const proxyProtocol = cli.proxyProtocol ?? (envProxyType as AppConfig["proxyProtocol"]) ?? "http";

  const envEnabledRaw =
    process.env.AUTH_ENABLED ?? process.env.APP_USE_AUTH ?? process.env.USE_AUTH ?? process.env.AUTH_SWITCH;
  const authEnabled = cli.authEnabled ?? toBoolean(envEnabledRaw, false);

  const envAuthRaw = (process.env.AUTH_TYPE ?? process.env.AUTHTYPE ?? "").toLowerCase();
  const envAuthType =
    envAuthRaw === "none" || envAuthRaw === "basic" || envAuthRaw === "jwt" ? envAuthRaw : undefined;
  const authType = cli.authType ?? (envAuthType as AppConfig["authType"]) ?? "none";

  const authUsername = cli.authUsername ?? process.env.AUTH_USERNAME ?? "";
  const authPassword = cli.authPassword ?? process.env.AUTH_PASSWORD ?? "";
  const jwtSecret =
    cli.jwtSecret ??
    process.env.JWT_SECRET ??
    process.env.PROXY_SECRET ??
    process.env.JWT_KEY ??
    process.env.JWTSECRET ??
    "";

  const envAuthLoggingRaw = process.env.AUTH_LOGGING ?? process.env.AUTH_LOG ?? process.env.LOG_AUTH;
  const authLogging = cli.authLogging ?? toBoolean(envAuthLoggingRaw, true);

  const envLogRaw = (process.env.LOG_LEVEL ?? process.env.LOGLEVEL ?? "").toLowerCase();
  const envLogLevel =
    envLogRaw === "debug" || envLogRaw === "info" || envLogRaw === "warn" || envLogRaw === "error" || envLogRaw === "silent"
      ? envLogRaw
      : undefined;
  const logLevel = cli.logLevel ?? (envLogLevel as AppConfig["logLevel"]) ?? "info";

  const logFile = cli.logFile ?? process.env.LOG_FILE ?? process.env.LOGFILE ?? process.env.LOG_PATH ?? "log";

  const envTimeoutRaw =
    process.env.UPSTREAM_TIMEOUT ?? process.env.PROXY_TIMEOUT ?? process.env.TIMEOUT ?? "";
  const envTimeout = toNumber(envTimeoutRaw || undefined, NaN);
  const upstreamTimeout =
    cli.upstreamTimeout ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : undefined) ?? 10000;

  const tlsKey = cli.tlsKey ?? process.env.TLS_KEY ?? process.env.TLS_KEY_PATH ?? process.env.SSL_KEY ?? "keys/server.key";
  const tlsCert = cli.tlsCert ?? process.env.TLS_CERT ?? process.env.TLS_CERT_PATH ?? process.env.SSL_CERT ?? "keys/server.crt";
  const tlsCa = cli.tlsCa ?? process.env.TLS_CA ?? process.env.TLS_CA_PATH ?? process.env.SSL_CA ?? "keys/ca.crt";
  const tlsPassphrase =
    cli.tlsPassphrase ??
    process.env.TLS_PASSPHRASE ??
    process.env.TLS_KEY_PASS ??
    process.env.SSL_PASSPHRASE ??
    process.env.PASSPHRASE ??
    "";

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
  config.set("upstreamTimeout", upstreamTimeout);
  config.set("tlsKey", tlsKey);
  config.set("tlsCert", tlsCert);
  config.set("tlsCa", tlsCa);
  config.set("tlsPassphrase", tlsPassphrase);

  return { port, cacheType, proxyProtocol, authEnabled, authType, authUsername, authPassword, jwtSecret, authLogging, logLevel, logFile, upstreamTimeout, tlsKey, tlsCert, tlsCa, tlsPassphrase } as AppConfig;
}

initConfig();
