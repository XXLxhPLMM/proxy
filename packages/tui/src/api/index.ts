/**
 * @fileoverview 控制面 HTTP **契约**的唯一出口（barrel，**只转发**，一行逻辑都不许有）
 * @module api/index
 * @description
 * 本目录只放**契约**：端点表（`endpoints/`，按服务端模块分段）、响应体形状（`types.ts`）、把两者接起来的逐字段
 * 判据（`wire.ts`）。跨目录只引 `@/api/index.js`。
 *
 * ⚠️ **工具形状的东西一律不在这里**：拨号（`ManagerClient`）、`字符串 → URL` 的两处变换、失败三档词汇
 * （`TuiError` / `isRetryable` / `LOCAL_REQUEST`）、收窄组合子都在 `@/utils/index.js`。判据是**依赖方向** ——
 * 本目录**不依赖** `@/utils` 的 barrel（只有 `wire.ts` 为拿组合子而引它的深层路径），故契约可以被单独读懂、
 * 单独测试，而「怎么发出去」是可替换的实现细节。
 *
 * @module
 */

export { ENDPOINTS, type Endpoint, type Method } from "./endpoints/index.js";
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