/** 本目录答「怎么把 `@/api` 那份契约变成一次真的请求」：唯一拨号点 / 失败三档 / 两处 URL 变换 */

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