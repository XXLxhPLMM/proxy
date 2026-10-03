/**
 * @fileoverview 台账 → 控制面客户端的**接线**，以及「连上没有」这件事的形状
 * @module ledger/connect
 * @description
 * 本模块是「一份台账记录」到「一个能发请求的客户端」之间唯一的转换点，也是本目录里**唯一**碰
 * 网络的地方（虽然它自己不拨号：`ManagerClient` 才拨号，见 `@/api/index.js`）。有了这一个点，
 * 「台账里的哪几个字段喂给客户端」就有唯一答案，不必在界面各处各拼一次。
 *
 * ## ⚠️ 为什么 {@link clientFor} 要**再**过一次 `normalizeBaseUrl`
 * @description
 * 因为 {@link ./validate.ts:validateLedger} 与 {@link ./validate.ts:validateTargetInput} 各管一个面，
 * 而 {@link ManagerClient} 的构造参数来自 `Target` —— 也就是一个**类型上**只承诺了 `baseUrl: string`
 * 的对象。台账文件是给人能手改的，而 `Target` 也可以由界面在内存里直接构造（不必先过一遍盘）。
 * 不重过那道判据，就等于把「`baseUrl` 已经是规范形态」这件事寄托在「每一处构造都记得先校验」上 ——
 * 而那条约定在第一次赶时间时就破了。
 *
 * 重复一次归一**没有代价**（它对已规范的输入是幂等的），漏一次的代价是「地址填对了却连不上」这种
 * 没有线索的失败。
 *
 * ## ⚠️ 探活**不 re-throw**
 * @description
 * {@link probeTarget} 的问题不是「能不能连上」，而是「连上了吗」—— 后者**包含**前者为假的情形。
 * 把失败抛出去，等于让「这个端点连不上」这件事在界面上以「操作失败」的面貌出现，而它其实是
 * 一种**常态答案**（manager 还没起 / 在另一台机器上 / 网络断了）。于是返回值是判别联合：
 * `ok: true` 带状态，`ok: false` 带那个 {@link TuiError}—— 三档判别（wire / transport / shape）
 * 原样交给界面，由界面决定怎么显示、要不要重试。
 *
 * 非 `TuiError` 的异常**照旧往上抛**：那不是「连不上」，而是本包自己有 bug，探活替它兜住就等于
 * 让一个编程错误伪装成一次网络失败。
 *
 * 本模块零 console、零 `process.*`。
 *
 * @module
 */

import { ManagerClient, TuiError, normalizeBaseUrl, type StatusBody } from "@/api/index.js";
import type { Target } from "./types.js";

/**
 * 探活的结果
 * @description 判别联合而不是「抛或返回」：见文件头「探活不 re-throw」。
 */
export type ProbeResult =
  | { readonly ok: true; readonly status: StatusBody }
  | { readonly ok: false; readonly error: TuiError };

/**
 * 一条台账记录 → 一个客户端
 * @description
 * `Target` 本身就 `extends ManagerEndpoint`（`baseUrl` / `token` / `timeoutMs`），所以这里真正做的
 * 只有「再过一次地址归一」这一件事 —— 那件事恰好是本函数存在的理由（见文件头）。
 *
 * @param target - 台账里的一个端点
 * @returns 可发请求的客户端
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
 * 探活一次（`GET /api/status`）
 * @description
 * 选 `status` 是因为它是唯一一个**必然存在、且只读、且能回答「数据面在不在」**的端点。
 *
 * @param client - 客户端
 * @returns 连上了带状态；没连上带那个 `TuiError`（不抛）
 */
export async function probeTarget(client: ManagerClient): Promise<ProbeResult> {
  try {
    return { ok: true, status: await client.status() };
  } catch (err) {
    if (err instanceof TuiError) return { ok: false, error: err };
    throw err;
  }
}
