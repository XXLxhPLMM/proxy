/**
 * @fileoverview 台账 → 控制面客户端的**接线**，以及「连上没有」这件事的形状
 * @module ledger/connect
 * @description
 * 本模块是「一份台账记录」到「一个能发请求的客户端」之间唯一的转换点（虽然它自己不拨号：`ManagerClient`
 * 才拨号，见 `@/utils/index.js`）。
 *
 * ⚠️ {@link clientFor} 要**再**过一次 `normalizeBaseUrl`：`Target` 在**类型上**只承诺了 `baseUrl: string`，而台账
 * 文件是给人能手改的、`Target` 也可以由界面在内存里直接构造。重复归一**没有代价**（它对已规范的输入是幂等
 * 的），漏一次的代价是「地址填对了却连不上」。
 *
 * ⚠️ {@link probeTarget} 的问题不是「能不能连上」而是「连上了吗」——后者**包含**前者为假的情形，而「manager 还
 * 没起 / 在另一台机器上 / 网络断了」是一种**常态答案**。所以它**不 re-throw**。非 `TuiError` 的异常**照旧往上
 * 抛**：那不是「连不上」，而是本包自己有 bug，探活替它兜住就等于让编程错误伪装成一次网络失败。
 *
 * @module
 */

import type { StatusBody } from "@/api/index.js";
import { ManagerClient, TuiError, normalizeBaseUrl } from "@/utils/index.js";
import type { Target } from "./types.js";

/** 探活的结果：判别联合而不是「抛或返回」（理由见文件头） */
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