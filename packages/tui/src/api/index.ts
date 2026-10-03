/**
 * @fileoverview 控制面客户端的**唯一出口**（barrel，**只转发**，一行逻辑都不许有）
 * @module api/index
 * @description
 * 目录内的 `endpoints` / `types` / `decode` / `wire` / `error` / `client` 都是零件，本文件是对外的全部
 * 承诺。跨目录只引 `@/api/index.js`。
 *
 * @module
 */

export { ENDPOINTS, endpointPath, type Endpoint, type Method } from "./endpoints.js";
export {
  TuiError,
  isRetryable,
  LOCAL_REQUEST,
  type FailureKind,
  type LocalCode,
  type TuiCode,
} from "./error.js";
export {
  ACL_GROUPS,
  ACL_LISTS,
  ManagerClient,
  assertNonEmptyPatch,
  normalizeBaseUrl,
  type CallOptions,
  type FetchLike,
  type ManagerEndpoint,
} from "./client.js";
export {
  SHAPES,
  readErrorBody,
  WIRE_CODES,
  type ErrorBodyRead,
  type UsageOneBody,
} from "./wire.js";
export type {
  AclBody,
  AclGroupName,
  AclListBody,
  AclListName,
  AclMutationInput,
  AccountBody,
  AccountCreateInput,
  AccountUpdateInput,
  ChangeBody,
  ConfigBody,
  ConfigKeyBody,
  DataRef,
  ErrorBodyWire,
  StatusBody,
  StatusData,
  UsageBody,
  UsageRef,
  UsageRowBody,
  UsersBody,
  WireCode,
} from "./types.js";