/** 控制面 HTTP **契约**的唯一出口（barrel，只转发）：请求面 / 端点函数 / 逐字段判据（zod schema）/ 失败面的宽松读法 */

/* 请求面：连接参数 + 那一条出口（⚠️ **拨号只有这一个实现**，纪律与代价写在那两个文件头上） */
export type { ManagerTarget, Method, RequestSpec } from "./send.js";
export { parseBody, sendDecoded } from "./send.js";

export type { ErrorBodyWire, WireCode } from "./types.js";

/* 端点函数：一个端点一个函数（`status` / `config` / `users` / `user` / `acl` / `usage` / `usageFor` /
   `createAccount` / `updateAccount` / `deleteAccount` / `addAclEntry` / `removeAclEntry`）——
   `(method, path)`、逐字段判据与剥不剥信封都在各自那一个文件里 */
export { acl, addAclEntry, ACL_GROUPS, ACL_LISTS, removeAclEntry } from "./acl.js";
export { config } from "./config.js";
export { status } from "./status.js";
export { usage, usageFor } from "./usage.js";
export {
  assertNonEmptyPatch,
  createAccount,
  deleteAccount,
  updateAccount,
  user,
  users,
} from "./users.js";

/* 逐字段判据（zod schema）：导出是因为 `tests/wire/` 要逐个拿它喂样本并删字段验（判据面必须可被单独断言） */
export { aclSchema } from "./acl.js";
export { changeSchema } from "./change.js";
export { configKeySchema, configSchema } from "./config.js";
export { statusSchema } from "./status.js";
export { usageOneSchema, usageSchema } from "./usage.js";
export { accountSchema, accountsSchema } from "./users.js";

/* 响应体类型：⚠️ **全部由 `z.infer` 从上面那些 schema 推**，故形状与判据不可能漂 */
export type { AclBody, AclGroupName, AclListBody, AclListName, AclMutationInput } from "./acl.js";
export type { ChangeBody } from "./change.js";
export type { ConfigBody, ConfigKeyBody } from "./config.js";
export type { DataRef, StatusBody, StatusData, UsageRef } from "./status.js";
export type { UsageBody, UsageOneBody, UsageRowBody } from "./usage.js";
export type { AccountBody, AccountCreateInput, AccountUpdateInput, UsersBody } from "./users.js";

/* 失败面 */
export { readErrorBody, WIRE_CODES, type ErrorBodyRead } from "./error.js";