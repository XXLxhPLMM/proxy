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

import { config, type AppConfig } from "./store.js";
import fs from "node:fs";
import dotenv from "dotenv";

function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 按 env 文件 > 终端 的优先级加载 env 文件（覆写终端同名变量）
 * 依次尝试 .env / .env.development 等，存在即 override 加载
 */
function loadEnvFiles(): void {
  const candidates = [".env", `.env.${process.env.NODE_ENV ?? "development"}`, ".env.development", ".env.production"];
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
  return out;
}

let _inited = false;

export function initConfig(): AppConfig {
  if (_inited) return { port: config.get("port")!, cacheType: config.get("cacheType")! } as AppConfig;
  _inited = true;

  // env 文件 > 终端：覆写加载后，process.env 已体现该优先级
  loadEnvFiles();

  const cli = parseStartupArgs();
  // 覆盖顺序：CLI > env 文件 > 终端 > 默认值（此时 process.env 已是 env 文件覆写终端后的结果）
  const port = toNumber(cli.port !== undefined ? String(cli.port) : process.env.PORT, 3000);
  const envCacheRaw = (process.env.CACHE_TYPE ?? process.env.CACHETYPE ?? "").toLowerCase();
  const envCacheType = envCacheRaw === "memory" || envCacheRaw === "redis" ? envCacheRaw : undefined;
  const cacheType = cli.cacheType ?? (envCacheType as AppConfig["cacheType"]) ?? "memory";

  config.set("port", port);
  config.set("cacheType", cacheType);

  return { port, cacheType } as AppConfig;
}

initConfig();
