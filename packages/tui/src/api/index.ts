/** 控制面 HTTP **契约**的唯一出口（barrel，只转发）：请求面 / 端点函数 / 逐字段判据（zod schema）/ 失败面的宽松读法 */

 /* 请求面：连接参数 + 那一条出口（⚠️ **拨号只有 `transport/send.ts` 这一处实现**，纪律与代价写在那个文件头上；
    请求的形状是纯类型，住 `@/lib/request/transport.js`，这里转出以便调用方只引一处） */
export type { ManagerTarget, Method, RequestSpec } from "@/lib/request/transport.js";
export { parseBody, sendDecoded } from "./transport/send.js";

export type { ErrorBodyWire, WireCode } from "./error/schema.js";

/* 端点函数：一个端点一个函数（`status` / `config` / `users` / `user` / `acl` / `usage` / `usageFor` /
   `createAccount` / `updateAccount` / `deleteAccount` / `addAclEntry` / `removeAclEntry`）——
   `(method, path)`、逐字段判据与剥不剥信封都在各自那个模块目录里（`client.ts` 管前者与接口，`schema.ts` 管判据） */
export { acl, addAclEntry, removeAclEntry } from "./acl/client.js";
export { ACL_GROUPS, ACL_LISTS } from "./acl/schema.js";
export { config } from "./config/client.js";
export { status } from "./status/client.js";
export { usage, usageFor } from "./usage/client.js";
export {
  assertNonEmptyPatch,
  createAccount,
  deleteAccount,
  updateAccount,
  user,
  users,
} from "./users/client.js";

/* 逐字段判据（zod schema）：导出是因为 `tests/wire/` 要逐个拿它喂样本并删字段验（判据面必须可被单独断言） */
export { aclSchema } from "./acl/schema.js";
export { changeSchema } from "./change/schema.js";
export { configKeySchema, configSchema } from "./config/schema.js";
export { statusSchema } from "./status/schema.js";
export { usageOneSchema, usageSchema } from "./usage/schema.js";
export { accountSchema, accountsSchema } from "./users/schema.js";

/* 响应体类型：⚠️ **全部由 `z.infer` 从上面那些 schema 推**，故形状与判据不可能漂 */
export type { AclBody, AclGroupName, AclListBody, AclListName, AclMutationInput } from "./acl/schema.js";
export type { ChangeBody } from "./change/schema.js";
export type { ConfigBody, ConfigKeyBody } from "./config/schema.js";
export type { DataRef, StatusBody, StatusData, UsageRef } from "./status/schema.js";
export type { UsageBody, UsageOneBody, UsageRowBody } from "./usage/schema.js";
export type { AccountBody, AccountCreateInput, AccountUpdateInput, UsersBody } from "./users/schema.js";

/* 失败面 */
export { readErrorBody, WIRE_CODES, type ErrorBodyRead } from "./error/schema.js";
