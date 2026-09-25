/**
 * @fileoverview 日志文本净化与参数拆分（纯函数层，零 IO）
 * @module utils/logger/sanitize
 * @description
 * 两个通道共用的文本层：控制字符转义、Error 可读化、结构化字段识别，
 * 以及「任意值 → 单行文本」与「字段集合 → `k=v`」两种唯一渲染实现。
 *
 * 职责：
 * - `sanitizeLogText` / `renderErrorText`：单行可读文本的保证
 * - `isPlainObject` / `splitFields`：结构化字段的识别与拆分
 * - `renderFieldValue` / `renderFields`：字段渲染（**全目录唯一实现**）
 * - `stringifyValue`：参数 → 单行文本（**全目录唯一实现**）
 *
 * 不负责：
 * - 不读配置、不碰文件系统、不写任何输出（因此可被 console/jsonl 两条通道共用）
 * - 不决定「这条日志要不要输出」（等级门控归 `port.ts` 的 `ORDER` + 各实现）
 */

import { RE_LOG_CONTROL_CHARS } from "@/utils/constants/index.js";
import type { LogFields } from "./port.js";

/**
 * 日志文本净化：把控制字符（C0 + DEL）转义为可见形式
 * @description 客户端可控字节（SOCKS 域名/USERID、Host 头、X-Forwarded-For、凭证）可能含 `\n`
 * （伪造整条日志、污染审计）或 ESC（终端转义注入）；落盘与控制台统一净化，保证单条日志恒为单行
 * @param s - 原始文本
 * @returns 转义后的单行文本
 * @example sanitizeLogText("a\nINFO fake") // => "a\\nINFO fake"
 */
export function sanitizeLogText(s: string): string {
  return s.replace(RE_LOG_CONTROL_CHARS, (c) => {
    if (c === "\n") {
      return "\\n";
    }
    if (c === "\r") {
      return "\\r";
    }
    if (c === "\t") {
      return "\\t";
    }
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

/**
 * Error 渲染为可读单行文本（落盘 msg 与控制台字段共用）
 * @description Error 的 message/stack 是非枚举属性，JSON.stringify 只会得到 `{}`——
 * 转发层 502 的成因（ECONNREFUSED/TLS 校验失败）会因此丢失。这里特判渲染为
 * `name: message [code=...] [stack 首帧]`，经 sanitizeLogText 净化保证单行。
 * 控制台 msg 通道不经过此函数：Error 原样交给 console，保持原生堆栈可读。
 * @param e - 待渲染的 Error（含自定义 name/code）
 * @returns 净化后的单行文本
 * @example renderErrorText(Object.assign(new Error("boom"), { code: "ECONNREFUSED" }))
 */
export function renderErrorText(e: Error): string {
  try {
    const parts: string[] = [`${e.name || "Error"}: ${e.message}`];
    const code = (e as { code?: unknown }).code;
    if (code !== undefined && code !== null) {
      parts.push(`code=${String(code)}`);
    }
    // stack 首帧（`at ...`）：定位抛点；首行通常是 `name: message`，与上方重复故跳过
    const frame = e.stack?.split("\n").find((line) => line.trim().startsWith("at "));
    if (frame) {
      parts.push(frame.trim());
    }
    return sanitizeLogText(parts.join(" "));
  } catch {
    // 病态 Error 子类（抛错的 getter 等）：退化为 String，绝不外抛
    try {
      return sanitizeLogText(String(e));
    } catch {
      return "[unserializable]";
    }
  }
}

/**
 * plain object 判定（严格）
 * @description 仅接受「纯净对象字面量」：原型为 `Object.prototype` 或 `null`。
 * 天然排除 Error / Array / Buffer / Date / Map / 类实例——它们仍按 `stringifyValue()` 规则进 msg。
 * 这条判定是「最后一个参数是否视作结构化 fields」的唯一依据。
 * @param v - 待判定值
 * @returns 是 plain object 时返回 true，并收窄为 `Record<string, unknown>`
 * @example isPlainObject({ a: 1 }) // => true
 * @example isPlainObject(new Error("x")) // => false
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
  );
}

/**
 * 拆出结构化字段：`args` 末位若为 plain object 则视为 fields，不再参与 msg 拼接
 * @description 仅识别**最后一个**参数，前面的 plain object 仍按普通参数进 msg。
 * @param args - 原始参数数组
 * @returns `args`（剔除 fields 后的 msg 参数）与可选 `fields`
 */
export function splitFields(args: unknown[]): { args: unknown[]; fields?: Record<string, unknown> } {
  const last = args.length > 0 ? args[args.length - 1] : undefined;
  if (isPlainObject(last)) {
    return { args: args.slice(0, -1), fields: last };
  }
  return { args };
}

/**
 * 渲染单个字段值
 * @description string 净化后原样；number/boolean 直接 String；undefined/null 返回 undefined
 * 表示「跳过该键」；Error 渲染为可读单行文本（`renderErrorText`）；其余（嵌套对象/数组等）
 * JSON.stringify，失败回退 String，绝不抛。
 * @param v - 字段值
 * @returns 可读文本，或 undefined 表示不打印该键
 */
export function renderFieldValue(v: unknown): string | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v === "string") {
    return sanitizeLogText(v);
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  if (v instanceof Error) {
    return renderErrorText(v);
  }
  try {
    const s = JSON.stringify(v);
    // 函数/Symbol 的 JSON.stringify 返回 undefined（非抛错），同样回退 String
    if (s !== undefined) {
      return s;
    }
  } catch {
    // 循环引用 / BigInt 等抛错：落入下方 String 回退
  }
  try {
    return String(v);
  } catch {
    return "[unserializable]";
  }
}

/**
 * 将结构化字段渲染为控制台使用的 `k=v` 文本
 * @description 跳过 undefined/null 的键，其余 `k=v` 空格拼接；无可见字段时返回空串
 * （调用方据此决定是否追加这一段，避免尾随空格）。
 * @param fields - 结构化字段集合
 * @returns 渲染文本，可能为空串
 * @example renderFields({ user: "alice", ip: undefined }) // => "user=alice"
 */
export function renderFields(fields?: LogFields): string {
  if (fields === undefined) {
    return "";
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    const rendered = renderFieldValue(v);
    if (rendered !== undefined) {
      parts.push(`${k}=${rendered}`);
    }
  }
  return parts.join(" ");
}

/**
 * 序列化单个参数为单行文本（**全目录唯一的「参数 → 文本」实现**）
 * @description string 净化后原样，Error 渲染为可读单行文本，其余尽力 JSON 化；
 * 循环引用/BigInt/Symbol/函数等一律不抛，最终占位 `[unserializable]`。
 * 落盘 msg 拼装（`impl.ts` 的 `plain`）与轻量控制台参数拼装（`console.ts`）共用本函数。
 * @param a - 待序列化的任意值
 * @returns 恒为单行的可读文本
 * @example stringifyValue(Object.assign(new Error("boom"), { code: "ECONNREFUSED" }))
 * // => "Error: boom code=ECONNREFUSED at ..."
 */
export function stringifyValue(a: unknown): string {
  if (typeof a === "string") {
    return sanitizeLogText(a);
  }
  if (a instanceof Error) {
    return renderErrorText(a);
  }
  try {
    const s = JSON.stringify(a);
    // 函数/Symbol/undefined 的 JSON.stringify 返回 undefined，非抛错，同样回退到 String
    if (s !== undefined) {
      return s;
    }
  } catch {
    // 循环引用 / BigInt 等抛错：落入下方 String 回退
  }
  try {
    return String(a);
  } catch {
    // String(symbol) 之外的极端不可字符串化值：占位兜底，绝不外抛
    return "[unserializable]";
  }
}
