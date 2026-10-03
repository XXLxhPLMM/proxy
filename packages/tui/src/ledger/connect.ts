/**
 * @fileoverview 台账 → 控制面客户端的**接线**；⚠️ `clientFor` 要**再**过一次 `normalizeBaseUrl`（台账文件是给人能手改的），⚠️ `probeTarget` **不 re-throw** `TuiError`（但非 `TuiError` 的异常照旧往上抛）
 */

import type { StatusBody } from "@/api/index.js";
import { ManagerClient, TuiError, normalizeBaseUrl } from "@/utils/index.js";
import type { Target } from "./types.js";

/** 探活的结果：判别联合而不是「抛或返回」 */
export type ProbeResult =
  | { readonly ok: true; readonly status: StatusBody }
  | { readonly ok: false; readonly error: TuiError };

/**
 * 一条台账记录 → 一个客户端
 * @description `Target` 本身就 `extends ManagerEndpoint`，所以这里真正做的只有「再过一次地址归一」。
 * @throws {TuiError} `unreachable`：`target.baseUrl` 不是可用的控制面地址
 */
export function clientFor(target: Target): ManagerClient {
  return new ManagerClient({
    baseUrl: normalizeBaseUrl(target.baseUrl),
    token: target.token,
    timeoutMs: target.timeoutMs,
  });
}

/**
 * 探活一次（`GET /api/status`，**不抛**）
 * @description 选 `status` 是因为它是唯一一个**必然存在、只读、且能回答「数据面在不在」**的端点。
 */
export async function probeTarget(client: ManagerClient): Promise<ProbeResult> {
  try {
    return { ok: true, status: await client.status() };
  } catch (err) {
    if (err instanceof TuiError) return { ok: false, error: err };
    throw err;
  }
}