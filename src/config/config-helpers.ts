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

/** 解析配置根目录
 * @description `useHome` 为真取 `~/.proxy`，否则取 `cwd`（缺省进程工作目录）。
 * @param useHome - 是否用用户主目录作配置目录
 * @param cwd - 显式配置目录（`useHome` 为真时仍以主目录为准），缺省 `process.cwd()`
 */
export function getConfigDir(useHome: boolean, cwd?: string): string {
  if (useHome) {
    return getHomeConfigDir();
  }
  return cwd ?? process.cwd();
}

/**
 * 目录缺失时创建
 * @param useHome - 是否用用户主目录作配置目录
 * @param cwd - 显式配置目录，缺省 `process.cwd()`
 */
export function ensureConfigDir(useHome: boolean, cwd?: string): void {
  const dir = getConfigDir(useHome, cwd);
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
 * env 文件候选名（低 -> 高，已去重保留末次出现）
 * - `.env.production` -> `.env.development` -> `.env.<NODE_ENV>`；
 *   NODE_ENV 未设时缺省拼 .env.development，与第二项重名去重后只读一次
 */
function envFileCandidates(nodeEnv: string | undefined): string[] {
  const candidates = [".env.production", ".env.development", `.env.${nodeEnv ?? "development"}`];
  // Set 保留首次出现，反向两轮即等价于「保留末次出现」的稳定去重
  return [...new Set(candidates.slice().reverse())].reverse();
}

/**
 * 读取 env 文件，返回「文件带来的增量」（纯读，绝不写 `process.env`）
 * - 覆盖顺序低 -> 高（后文件胜过前文件），与 `loadEnvFiles` 同款
 * - `baseEnv` 里已存在的键视为「终端/显式 env 源已提供」，**不在增量里**
 *   （与 dotenv / `node --env-file` 一致：环境变量优先于 env 文件）
 * @param configDir - 配置文件所在目录
 * @param baseEnv - 终端/显式 env 源；缺省 `process.env`（其 NODE_ENV 决定第三个候选文件名）
 * @returns 文件带来的键值增量（缺失文件跳过）
 */
export function readEnvFileOverrides(
  configDir: string,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  // 快照必须在读任何文件之前取：只挡「终端来源」，
  // 实时查 baseEnv 会让前一个文件刚写入的键挡住后一个文件（丢掉「后文件覆盖前文件」）
  const preset = new Set(Object.keys(baseEnv));
  const overrides: Record<string, string> = {};
  for (const f of envFileCandidates(baseEnv.NODE_ENV)) {
    const filePath = path.join(configDir, f);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const parsed = dotenv.parse(fs.readFileSync(filePath));
    for (const [k, v] of Object.entries(parsed)) {
      if (v !== undefined && !preset.has(k)) {
        overrides[k] = v;
      }
    }
  }
  return overrides;
}

/**
 * 加载 env 文件到 process.env
 * - 候选（低 -> 高）：.env.production -> .env.development -> .env.<NODE_ENV>；
 *   NODE_ENV 未设时缺省拼 .env.development，与第二项重名去重后只读一次
 * - 终端已存在的变量不被覆盖（与 node --env-file / dotenv 默认一致：
 *   环境变量优先于 env 文件，保证启动命令能覆盖文件）；文件之间仍后者覆盖前者
 * - 手工 dotenv.parse 后写入；缺失文件跳过
 * @param useHome - env 文件所在目录是否取 `~/.proxy`（否则取 `opts.cwd` / 进程 cwd）
 * @param opts.cwd - 显式配置目录
 */
export function loadEnvFiles(useHome: boolean, opts?: { cwd?: string }): void {
  const overrides = readEnvFileOverrides(getConfigDir(useHome, opts?.cwd), process.env);
  for (const [k, v] of Object.entries(overrides)) {
    process.env[k] = v;
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
