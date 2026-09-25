/**
 * 配置加载辅助工具：配置目录、env 文件读取、CLI 参数归一与纯解析函数。
 *
 * 本模块不读写宿主环境。调用方必须显式提供 env 和 env 文件列表；文件读取只返回
 * 一份新对象，永远不会把文件内容写回宿主环境。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { RE_DASH_GLOBAL, RE_LEADING_DASHES } from "@/utils/constants.js";

const CONFIG_DIR_NAME = ".proxy";

/** useHomeConfig 环境变量名（决定 env 文件读取目录，需在加载 env 文件前单独解析） */
export const HOME_CONFIG_KEY = "USE_HOME_CONFIG";

/** 主目录 ~/.proxy 路径（Windows 取 %USERPROFILE%）。 */
function getHomeConfigDir(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}

/**
 * 解析配置根目录。
 *
 * @param useHome - 是否使用用户主目录作为配置目录
 * @param cwd - 非 home 模式下的显式配置目录；缺省使用进程 cwd
 */
export function getConfigDir(useHome: boolean, cwd?: string): string {
  if (useHome) {
    return getHomeConfigDir();
  }
  return cwd === undefined ? process.cwd() : path.resolve(cwd);
}

/**
 * 生成默认 env 文件名列表（只生成名字，不扫描也不读取文件）。
 *
 * 顺序为低到高：`.env.production` → `.env.development` → `.env.<NODE_ENV>`；重复
 * 名称只保留最后一次出现，交给后续 CLI 显式传给 `loadConfig`。
 */
export function defaultEnvFileNames(nodeEnv?: string): string[] {
  const candidates = [".env.production", ".env.development", `.env.${nodeEnv ?? "development"}`];
  // Set 保留首次出现，反向两轮等价于稳定地保留末次出现。
  return [...new Set(candidates.slice().reverse())].reverse();
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * 按输入顺序读取 env 文件并合并到显式 env 的副本。
 *
 * - `baseEnv` 中已经存在的键永远优先，即使它的值为 `undefined`；调用方若想允许文件
 *   提供该键，不应把它放进 `baseEnv`。
 * - 文件按顺序读取，后一个文件覆盖前一个文件的同名键。
 * - 文件缺失跳过；其它读取错误原样抛出，交给 loader 原子失败。
 * - 不修改 `files` 或 `baseEnv`，也不触碰宿主环境。
 */
export async function readEnvFiles(
  files: readonly string[],
  baseEnv: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, string | undefined>> {
  const merged: Record<string, string | undefined> = { ...baseEnv };
  const explicitKeys = new Set(Object.keys(baseEnv));

  for (const file of [...files]) {
    let content: string;
    try {
      content = await fs.promises.readFile(file, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        continue;
      }
      throw error;
    }

    const parsed = dotenv.parse(content);
    for (const [key, value] of Object.entries(parsed)) {
      if (!explicitKeys.has(key)) {
        merged[key] = value;
      }
    }
  }

  return merged;
}

/**
 * CLI -> ENV 风格键值：归一（去前导 -、- 转 _、大写）使 `--proxy-protocol` 与
 * `PROXY_PROTOCOL` 同表命中。
 *
 * 支持 `--key value`、`--key=value`、`KEY=VALUE`；`KEY=VALUE` 只在第一个 `=` 处切分，
 * 因此值本身可以继续包含 `=`。裸 flag 视为 `true`，`--` 跳过。
 */
export function parseRawArgv(argv: readonly string[]): Record<string, string> {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (!arg.startsWith("-") && arg.includes("=")) {
      // indexOf/slice 而非 split("=", 2)：值本身可能含 "="，保持完整值。
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
 * 字符串转布尔。
 *
 * 无法识别时返回 undefined，让显式配置值在统一字段解析阶段报错，而不是静默变成 false。
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
