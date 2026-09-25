/**
 * 路径归一化：把 FIELDS 中标记 `path` 的字段按 configDir 绝对化。
 *
 * 纯内存操作：不读 env/argv/文件，不修改入参（只在副本上写）。
 */

import path from "node:path";
import { FIELDS } from "../schema/fields.js";
import { asRecord } from "./record.js";

/**
 * 复制配置并按 `configDir` 归一化所有标记为 path 的字段。
 *
 * 规则刻意保持简单：空串仍为空，绝对路径原样保留，只有相对路径才调用
 * `path.resolve(configDir, value)`。本函数不触碰输入对象，也不做任何 IO。
 */
export function resolveConfigPaths<T extends object>(config: T, configDir: string): T {
  const copy = { ...config };
  const values = asRecord(copy);
  for (const field of FIELDS) {
    if (field.path !== true) {
      continue;
    }
    const value = values[field.key];
    if (typeof value !== "string" || value === "" || path.isAbsolute(value)) {
      continue;
    }
    values[field.key] = path.resolve(configDir, value);
  }
  return copy;
}
