/** 控制面 HTTP **契约**的唯一出口（barrel，只转发）：端点表 / 响应体形状 / 逐字段判据 */

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