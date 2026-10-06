/**
 * @fileoverview 台账 → 控制面请求参数的**接线**；⚠️ `probeTarget` **不 re-throw** `TuiError`（但非 `TuiError` 的异常照旧往上抛）
 * @description
 * ⚠️ **这里没有「建一个客户端」这一步**（那是本目录旧形态的产物）：端点函数吃的是 `{baseUrl, token, timeoutMs}`
 * 那个**普通数据**，而它经 `@/api/send.js` 自己 axios 发出去。于是本目录的接线只剩两件事：
 * 把台账那一条**变成**一份能直接递进去的参数，以及探活。
 */

import { status, type ManagerTarget, type StatusBody } from "@/api/index.js";
import { TuiError } from "@/lib/errors.js";
import type { Target } from "./types.js";

/** 探活的结果：判别联合而不是「抛或返回」 */
export type ProbeResult =
  | { readonly ok: true; readonly status: StatusBody }
  | { readonly ok: false; readonly error: TuiError };

/**
 * 一条台账记录 → 一份能直接递进端点函数的请求参数
 * @description ⚠️ **原样透传**，一个字段都不改：`baseUrl` 已经由 `validate.ts` 归一过，而端点函数
 * 自己会在出门前**再**过一次 `normalizeBaseUrl`（台账文件是给人能手改的，那道防线归 `@/api/send.js` 所有）。
 * @throws {TuiError} `unreachable`：`target.baseUrl` 不是可用的控制面地址
 */
export function targetOf(target: Target): ManagerTarget {
  return { baseUrl: target.baseUrl, token: target.token, timeoutMs: target.timeoutMs };
}

/**
 * 探活一次（`GET /api/status`，**不抛**）
 * @description 选 `status` 是因为它是唯一一个**必然存在、只读、且能回答「数据面在不在」**的端点。
 */
export async function probeTarget(target: ManagerTarget): Promise<ProbeResult> {
  try {
    return { ok: true, status: await status(target) };
  } catch (err) {
    if (err instanceof TuiError) return { ok: false, error: err };
    throw err;
  }
}