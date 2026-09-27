/**
 * 配置加载辅助工具：目录解析、env 文件加载、CLI 参数归一
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { RE_DASH_GLOBAL, RE_LEADING_DASHES } from "@/utils/constants.js";

const CONFIG_DIR_NAME = ".proxy";

/** useHomeConfig 环境变量名（决定 env 文件读取目录，需在加载 env 文件前单独解析） */
export const HOME_CONFIG_KEY = "USE_HOME_CONFIG";

/** 主目录 ~/.proxy 路径（Windows 取 %USERPROFILE%） */
function getHomeConfigDir(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}

/** 解析配置根目录 */
export function getConfigDir(useHome: boolean): string {
  if (useHome) {
    return getHomeConfigDir();
  }
  return process.cwd();
}

/** 目录缺失时创建 */
export function ensureConfigDir(useHome: boolean): void {
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
export function toBoolean(value: string): boolean | undefined {
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
 * 加载 env 文件到 process.env
 * - 候选（低 -> 高）：.env.production -> .env.development -> .env.<NODE_ENV>；
 *   NODE_ENV 未设时缺省拼 .env.development，与第二项重名去重后只读一次
 * - 终端已存在的变量不被覆盖（与 node --env-file / dotenv 默认一致：
 *   环境变量优先于 env 文件，保证启动命令能覆盖文件）；文件之间仍后者覆盖前者
 * - 手工 dotenv.parse 后写入；缺失文件跳过
 */
export function loadEnvFiles(useHome: boolean): void {
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
export function parseRawArgv(argv: string[]): Record<string, string> {
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
