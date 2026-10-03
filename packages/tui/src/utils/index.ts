/**
 * @fileoverview 工具面的**唯一出口**（barrel，**只转发**，一行逻辑都不许有）
 * @module utils/index
 * @description
 * 本目录放**工具形状**的东西：唯一拨号点（`client.ts`）、失败三档词汇（`error.ts`）、两处
 * `字符串 → URL` 的变换（`http.ts`）、收窄组合子（`decode.ts`）。⚠️ **线上契约不在这里** ——
 * 端点表、响应体形状、逐字段判据都在 `@/api/index.js`。
 *
 * 分界判据是**依赖方向**：本目录**依赖** `@/api`（工具实现契约），而 `@/api` **不引本目录的 barrel**
 * （`wire.ts` 为拿组合子而引 `@/utils/decode.js` 的深层路径）—— 走 barrel 就是一条运行期环
 * （`api/index` → `api/wire` → `utils/index` → `utils/client` → `api/index`）。这条纪律是**结构性的**，
 * 不是一次省字的取舍。
 *
 * ⚠️ `decode.ts` 的九件零件**不从本 barrel 取**（与今天的 `@/api/index.js` 同一取舍）：收窄器是判据的装配料，
 * 而本包唯一的调用点是 `@/api/wire.js`。取它的档经深层路径 `@/utils/decode.js`。
 *
 * @module
 */

export {
  ACL_GROUPS,
  ACL_LISTS,
  ManagerClient,
  assertNonEmptyPatch,
  type CallOptions,
  type FetchLike,
  type ManagerEndpoint,
} from "./client.js";
export {
  TuiError,
  isRetryable,
  LOCAL_REQUEST,
  type FailureKind,
  type LocalCode,
  type TuiCode,
} from "./error.js";
export { endpointPath, normalizeBaseUrl } from "./http.js";