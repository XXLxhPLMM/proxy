/**
 * @fileoverview 控制面客户端的**唯一出口**（barrel）
 * @module client/index
 * @description
 * `src/client/` 目录的**唯一**出口。目录内的其它文件（`endpoints` / `types` / `decode` /
 * `wire` / `error` / `client`）都是零件，本文件是它们对外的全部承诺。
 *
 * 为什么要 barrel：本包是**独立子包**，没有根仓那条「跨目录一律 `@/`」的仓库级约定可依
 * （那条约定在 `@b-hole/proxy` 的根 `AGENTS.md` 里管的是根包）。给本包也立同一条的好处是
 * 目录将来拆分时调用方零改动；代价是多一层转发，故**本文件只转发、不含任何逻辑**。
 *
 * ## 层不变量（详见各零件文件头）
 * - **零 console、零 `process.*`**：呈现归 UI 层。
 * - **不 import 本目录以外的任何东西**（连文件系统都不碰，台账的读写在 `@/ledger`）——
 *   本目录是本包**唯一**拨号的地方，其余模块都只做纯变换。
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
