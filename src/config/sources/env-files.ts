/**
 * env 文件来源：只按调用方给出的显式路径列表读取。
 *
 * 本模块不扫描目录、不猜文件名、不把内容写回宿主环境；`defaultEnvFileNames` 只负责
 * **产名字**，读不读由 CLI 决定后再显式传给 `loadConfig`。
 */

import fs from "node:fs";
import dotenv from "dotenv";

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
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
