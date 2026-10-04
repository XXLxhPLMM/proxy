/** 本目录答「本包怎么把 `@/api` 那份契约变成一次真的请求」；⚠️ `config/` 与 `terminal/` 各有自己的 barrel，不在这里转发 */

export {
  ACL_GROUPS,
  ACL_LISTS,
  ManagerClient,
  assertNonEmptyPatch,
  type CallOptions,
  type FetchLike,
  type ManagerEndpoint,
} from "./manager-client.js";