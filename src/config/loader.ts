/**
 * 配置加载及初始化 - 全局唯一入口
 * 覆盖顺序：CLI > env 文件 > 终端 > 默认值
 */

import { config, getAll, type AppConfig } from "./store.js";
import fs from "node:fs";
import dotenv from "dotenv";
import { z } from "zod";

function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  const v = value.toLowerCase().trim();
  if (["true", "1", "yes", "on", "enable", "enabled"].includes(v)) return true;
  if (["false", "0", "no", "off", "disable", "disabled"].includes(v)) return false;
  return fallback;
}

/** 取首个存在的 env 值（兼容别名） */
function envPick(keys: string[]): string | undefined {
  for (const k of keys) if (process.env[k] !== undefined) return process.env[k];
  return undefined;
}
/** 取首个存在的 raw 值（CLI 解析后） */
function rawPick(raw: Record<string, string>, keys: string[]): string | undefined {
  for (const k of keys) if (raw[k] !== undefined) return raw[k];
  return undefined;
}

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
  const pick = (keys: string[]) => rawPick(raw, keys);
  const lowerPick = (keys: string[]) => pick(keys)?.toLowerCase();

  // 数值/布尔/枚举按别名表收敛，避免手抄 if
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
  const remoteHostRaw = pick(["REMOTE_HOST", "PROXY_TARGET_HOST", "TARGET_HOST"]); if (remoteHostRaw !== undefined) out.remoteHost = remoteHostRaw;
  const remotePortRaw = pick(["REMOTE_PORT", "PROXY_TARGET_PORT", "TARGET_PORT"]); if (remotePortRaw !== undefined) { const n = Number(remotePortRaw); if (Number.isFinite(n)) out.remotePort = n; }
  const remoteSecureRaw = pick(["REMOTE_SECURE", "PROXY_TARGET_SECURE", "TARGET_SECURE"]); if (remoteSecureRaw !== undefined) out.remoteSecure = toBoolean(remoteSecureRaw, false);
  const remoteUserRaw = pick(["REMOTE_USERNAME", "PROXY_TARGET_USERNAME"]); if (remoteUserRaw !== undefined) out.remoteUsername = remoteUserRaw;
  const remotePassRaw = pick(["REMOTE_PASSWORD", "PROXY_TARGET_PASSWORD"]); if (remotePassRaw !== undefined) out.remotePassword = remotePassRaw;
  const remoteCaRaw = pick(["REMOTE_CA", "PROXY_TARGET_CA"]); if (remoteCaRaw !== undefined) out.remoteCa = remoteCaRaw;
  const remoteInsecureRaw = pick(["REMOTE_INSECURE", "PROXY_TARGET_INSECURE"]); if (remoteInsecureRaw !== undefined) out.remoteInsecure = toBoolean(remoteInsecureRaw, false);
  const modeRaw = lowerPick(["PROXY_MODE", "MODE", "RUN_MODE"]); if (modeRaw === "server" || modeRaw === "client") out.proxyMode = modeRaw as AppConfig["proxyMode"]; else if (modeRaw === "true" || modeRaw === "1") out.proxyMode = "client";
  return out;
}

let _inited = false;

export function initConfig(): AppConfig {
  if (_inited) return getAll();
  _inited = true;
  loadEnvFiles();
  const cli = parseStartupArgs();

  // 统一用 envPick 收敛别名，CLI > envFile>terminal>默认 保持不变
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
  const remoteHost = cli.remoteHost ?? envPick(["REMOTE_HOST", "PROXY_TARGET_HOST", "TARGET_HOST"]) ?? "127.0.0.1";
  const remotePort = toNumber(cli.remotePort !== undefined ? String(cli.remotePort) : envPick(["REMOTE_PORT", "PROXY_TARGET_PORT", "TARGET_PORT"]), 3000);
  const remoteSecure = cli.remoteSecure ?? toBoolean(envPick(["REMOTE_SECURE", "PROXY_TARGET_SECURE", "TARGET_SECURE"]), false);
  const remoteUsername = cli.remoteUsername ?? envPick(["REMOTE_USERNAME", "PROXY_TARGET_USERNAME"]) ?? "";
  const remotePassword = cli.remotePassword ?? envPick(["REMOTE_PASSWORD", "PROXY_TARGET_PASSWORD"]) ?? "";
  const remoteCa = cli.remoteCa ?? envPick(["REMOTE_CA", "PROXY_TARGET_CA"]) ?? "keys/ca.crt";
  const remoteInsecure = cli.remoteInsecure ?? toBoolean(envPick(["REMOTE_INSECURE", "PROXY_TARGET_INSECURE"]), false);
  const proxyMode = cli.proxyMode ?? (envPick(["PROXY_MODE", "MODE", "RUN_MODE"])?.toLowerCase() as AppConfig["proxyMode"] | undefined) ?? "server";

  // 校验
  const schema = z.object({
    port: z.number().int().min(1).max(65535),
    cacheType: z.enum(["memory", "redis"]),
    proxyProtocol: z.enum(["http", "https", "socks", "tls"]),
    authType: z.enum(["none", "basic", "jwt"]),
    logLevel: z.enum(["debug", "info", "warn", "error", "silent"]),
    upstreamTimeout: z.number().int().positive(),
    proxyMode: z.enum(["server", "client"]),
    remotePort: z.number().int().min(1).max(65535),
  });
  const candidate = { port, cacheType, proxyProtocol, authType, logLevel, upstreamTimeout: _upstreamTimeout, proxyMode, remotePort };
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) throw new Error(`配置校验失败: ${parsed.error.message}`);

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
  config.set("remoteHost", remoteHost);
  config.set("remotePort", remotePort);
  config.set("remoteSecure", remoteSecure);
  config.set("remoteUsername", remoteUsername);
  config.set("remotePassword", remotePassword);
  config.set("remoteCa", remoteCa);
  config.set("remoteInsecure", remoteInsecure);
  config.set("proxyMode", proxyMode);

  return { port, cacheType, proxyProtocol, authEnabled, authType, authUsername, authPassword, jwtSecret, authLogging, logLevel, logFile, upstreamTimeout: finalUpstream, tlsKey, tlsCert, tlsCa, tlsPassphrase, remoteHost, remotePort, remoteSecure, remoteUsername, remotePassword, remoteCa, remoteInsecure, proxyMode } as AppConfig;
}

initConfig();
