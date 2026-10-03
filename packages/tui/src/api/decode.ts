/**
 * @fileoverview 线上的 `unknown` → 本包声明的形状（**一次显式收窄**，逐字段）
 * @module api/decode
 * @description
 * 服务端是**另一个进程**（甚至另一台机器）：它的响应不经过本包任何一行代码的类型检查。故从 `unknown` 到具
 * 体类型之间**必须**有一次显式收窄 —— 否则一次版本不匹配会以「界面上某个格子莫名其妙空白」的形式出现，而栈
 * 里一个有用的帧都没有。声明式组合子换来的是**字段清单与判据写在一起、加字段时漏不掉**。
 *
 * ⚠️ 收窄范围 = UI 会读的**全部**字段，一条不落（漏掉的字段会在某个不相关的页面变成 `undefined`）。唯一刻意
 * 透传的是 `configKey.value` —— 它的类型由服务端的配置 schema 决定，本包不猜。
 *
 * @module
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

/** 有限数字（epoch 毫秒 / 字节数 / 毫秒数都走它） */
export const num: Decode<number> = (v, path, req) =>
  typeof v === "number" && Number.isFinite(v) ? v : bad("有限数字", path, req);

/** 可为 null 的版本（`null` 与 `undefined` **只前者**合法：服务端显式写了 null 的地方就是这样） */
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

/**
 * 对象（逐键）
 * @description 未知键**放行**（不判别）：服务端加字段是它的自由，而「本包声明的键都在」才是本包的
 * 责任。判「服务端不许加字段」会让对面每加一个字段就把老版本客户端打挂。
 */
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

/**
 * 刻意透传的值（只给「类型由对面决定、本包不该猜」的那一个字段用）
 * @description ⚠️ 它**不是**「懒得收窄就标成它」——那样全仓每个 `unknown` 都会变成合法值，而这里只有
 * 一个调用点，且那个调用点的类型是 `unknown`（消费方必须自己处理）。
 */
export const opaque: Decode<unknown> = (v) => v;