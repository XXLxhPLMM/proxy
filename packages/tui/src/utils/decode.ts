/**
 * @fileoverview 线上的 `unknown` → 本包声明的形状（一次显式收窄，逐字段）
 * @module utils/decode
 * @description 零 IO：失败一律是 `TuiError.shape`，故它是判据的零件而不是传输面知识。
 */

import { TuiError } from "./error.js";

/** 收窄器：拿到一个值与它在 body 里的路径，成则返回声明类型，败则抛 `TuiError.shape` */
export type Decode<T> = (value: unknown, path: string, request: string) => T;

function bad(what: string, path: string, request: string): never {
  throw TuiError.shape({ what: `${path}（期望 ${what}）`, request });
}

export const str: Decode<string> = (v, path, req) =>
  typeof v === "string" ? v : bad("字符串", path, req);

export const bool: Decode<boolean> = (v, path, req) =>
  typeof v === "boolean" ? v : bad("布尔", path, req);

export const num: Decode<number> = (v, path, req) =>
  typeof v === "number" && Number.isFinite(v) ? v : bad("有限数字", path, req);

/** 可为 `null` 的版本（只认 `null`，不认 `undefined`） */
export function nullable<T>(inner: Decode<T>): Decode<T | null> {
  return (v, path, req) => (v === null ? null : inner(v, path, req));
}

/** 可缺省的版本（键可能整个不在；这是服务端 `fileOrigin` / `quota` 的形态） */
export function optional<T>(inner: Decode<T>): Decode<T | undefined> {
  return (v, path, req) => (v === undefined ? undefined : inner(v, path, req));
}

/** 固定字面量集合（闭合集；表外即错——见 `WireCode` 的纪律） */
export function oneOf<const T extends readonly string[]>(values: T): Decode<T[number]> {
  const set = new Set<string>(values);
  return (v, path, req) =>
    typeof v === "string" && set.has(v)
      ? (v as T[number])
      : bad(`${values.join(" / ")} 之一`, path, req);
}

export function arr<T>(inner: Decode<T>): Decode<T[]> {
  return (v, path, req) =>
    Array.isArray(v)
      ? v.map((item, i) => inner(item, `${path}[${i}]`, req))
      : bad("数组", path, req);
}

export const strArr: Decode<string[]> = arr(str);

/** 对象（逐键）；⚠️ 未知键放行 —— 判「对面不许加字段」会让对面每加一个字段就打挂老客户端 */
export function obj<T extends Record<string, Decode<unknown>>>(
  fields: T,
): Decode<{
  [K in keyof T]: ReturnType<T[K]>;
}> {
  return (v, path, req) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      bad("对象", path, req);
    }
    const source = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, decode] of Object.entries(fields)) {
      out[key] = decode(source[key], `${path}.${key}`, req);
    }
    return out as { [K in keyof T]: ReturnType<T[K]> };
  };
}

/** 刻意透传的值（只给「类型由对面决定」的那一个字段用）；⚠️ 不是「懒得收窄就标成它」，消费方拿到的是 `unknown` */
export const opaque: Decode<unknown> = (v) => v;