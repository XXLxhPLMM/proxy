/**
 * @fileoverview 工具形参的读取器 —— 把 `unknown`（模型给的 JSON）收窄成本包认识的形状
 * @module tools/args
 * @description
 * ⚠️ **收窄而非清洗**：不合法的输入一律抛 `local` 并把该给的合法取值列出来。
 * 悄悄把 `"whitelst"` 改成 `"whitelist"` 会让调用方以为改的是白名单而它其实是别的什么 ——
 * 对一个**写**工具来说那是「改错了地方却报成功」。
 *
 * 形参是模型给的，所以**每一格都要有判据**：JSON 协议没有类型保证，模型也会送来字符串冒充数组。
 */

import { McpError } from "../utils/errors.js";

/** 读一格必填字符串（空串 ⇒ 不合法） */
export function readString(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw McpError.local(`${key} 必填，且必须是一个非空字符串`);
  }
  return value.trim();
}

/** 读一格选填字符串（缺省 ⇒ `undefined`；给了空串 ⇒ **当没给**，不是错误） */
export function optionalString(
  args: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw McpError.local(`${key} 给的话必须是一个字符串`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 读一格选填整数（⚠️ **只收 number 或纯数字串**：`"5"` 收，而 `5.5` / `true` / `"5s"` 拒） */
export function optionalNumber(
  args: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw McpError.local(`${key} 给的话必须是一个数字`);
  }
  return parsed;
}

/** 读一格选填布尔（⚠️ 只收真 boolean 与 `"true"/"false"` 两串 —— `1` / `"yes"` 拒，避免「1 是什么意思」这题） */
export function optionalBoolean(
  args: Readonly<Record<string, unknown>>,
  key: string,
): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  throw McpError.local(`${key} 给的话必须是 true 或 false`);
}

/** 读一格必填字符串数组（⚠️ **每项都 trim 且不许为空串** —— 空串那条在服务端是「路径穿越候选」） */
export function readStringArray(args: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw McpError.local(`${key} 必填，且必须是一个非空的字符串数组`);
  }
  return value.map((one, at) => {
    if (typeof one !== "string" || one.trim() === "") {
      throw McpError.local(`${key} 的第 ${String(at + 1)} 项必须是一个非空字符串`);
    }
    return one.trim();
  });
}

/** 读一格选填字符串数组（缺省 ⇒ `undefined`；⚠️ **给了空数组当没给**，那与「不给」在语义上等价） */
export function optionalStringArray(
  args: Readonly<Record<string, unknown>>,
  key: string,
): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw McpError.local(`${key} 给的话必须是一个字符串数组`);
  }
  if (value.length === 0) {
    return undefined;
  }
  return value.map((one, at) => {
    if (typeof one !== "string" || one.trim() === "") {
      throw McpError.local(`${key} 的第 ${String(at + 1)} 项必须是一个非空字符串`);
    }
    return one.trim();
  });
}

/**
 * 把字符串收窄进一个闭集
 * @description 报错文案**逐字列出合法取值** —— 模型不需要猜，而「猜一个近似的」在写工具上
 * 等于把数据写到另一个名单方向里去。
 */
export function readEnum<T extends string>(
  args: Readonly<Record<string, unknown>>,
  key: string,
  allowed: readonly T[],
): T {
  const value = readString(args, key);
  const hit = allowed.find((one) => one === value);
  if (hit === undefined) {
    throw McpError.local(`${key} 只能是这些之一：${allowed.join(" | ")}（收到的是 ${value}）`);
  }
  return hit;
}

/** 选填闭集（缺省 ⇒ `undefined`） */
export function optionalEnum<T extends string>(
  args: Readonly<Record<string, unknown>>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  if (args[key] === undefined || args[key] === null) {
    return undefined;
  }
  return readEnum(args, key, allowed);
}

/**
 * 只拼**给了的**键（服务端对未知键直接 400，故入参体必须是白名单的子集）
 * @description ⚠️ `undefined` 的键**整个不出现**，而不是出现成 `null` —— 后者会被服务端读成
 * 「显式清空」，而「没给」与「清空」在账号写面上是两种不同的操作。
 */
export function compact(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}
