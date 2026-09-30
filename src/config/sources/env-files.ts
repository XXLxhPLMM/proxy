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
 * 生成默认 env 文件名列表（只生成名字，不扫描也不读取文件；候选固定三档、重复只留末次）。
 *
 * 三档的取舍与本层其余来源语义（`baseEnv` 优先、相对路径锚 `configDir`、缺失跳过其它抛错…）
 * 见 `tests/unit/config-loader.test.ts` 的头注释。
 */
export function defaultEnvFileNames(nodeEnv?: string): string[] {
  const candidates = [".env.production", ".env.development", `.env.${nodeEnv ?? "development"}`];
  return [...new Set(candidates.slice().reverse())].reverse();
}

/** env 文件读取结果：合并后的键值表 + 每个**文件来源**键的出处。 */
export interface EnvFilesRead {
  /** `baseEnv` 与各文件按优先级合并后的键值表。 */
  readonly merged: Readonly<Record<string, string | undefined>>;
  /**
   * 只含**文件带来的**键；`baseEnv` 已有的键不在其中（那个键的生效值由调用方决定，
   * 归到文件头上会把诊断指到一个不决定结果的地方）。值为实际提供该值的文件路径，
   * 多个文件给同一键时记后写入的那个——与合并优先级一致。
   *
   * 「某键来自哪个文件」这件事只能从这里取：调用方自行重读文件会与合并结果漂移
   * （`baseEnv` 优先级、文件顺序都在本模块内完成）。
   */
  readonly fileOrigins: ReadonlyMap<string, string>;
}

/**
 * - `baseEnv` 中已经存在的键永远优先，即使它的值为 `undefined`；调用方若想允许文件
 *   提供该键，不应把它放进 `baseEnv`。
 * - 文件按顺序读取，后一个文件覆盖前一个文件的同名键。
 * - 文件缺失跳过；其它读取错误原样抛出，交给 loader 原子失败。
 * - 不修改 `files` 或 `baseEnv`，也不触碰宿主环境。
 */
export async function readEnvFiles(
  files: readonly string[],
  baseEnv: Readonly<Record<string, string | undefined>>,
): Promise<EnvFilesRead> {
  const merged: Record<string, string | undefined> = { ...baseEnv };
  const explicitKeys = new Set(Object.keys(baseEnv));
  const fileOrigins = new Map<string, string>();

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
        fileOrigins.set(key, file);
      }
    }
  }

  return { merged, fileOrigins };
}
