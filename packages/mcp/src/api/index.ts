/**
 * @fileoverview 控制面 HTTP 的**契约**（零 IO）—— 端点表 + 响应体形状
 * @module api/index
 * @description `src/api/` 目录的唯一出口。端点路径逐条对照根仓 `src/manager/routes/*.ts` 抄。
 */

export {
  ACL_ENDPOINTS,
  CONFIG_ENDPOINTS,
  ENDPOINTS,
  STATUS_ENDPOINTS,
  USAGE_ENDPOINTS,
  USERS_ENDPOINTS,
  type Endpoint,
} from "./endpoints.js";
export { ACL_GROUPS, ACL_LISTS, QUOTA_WINDOWS, type QuotaWindow } from "./values.js";
export type {
  AclBody,
  AclGroupName,
  AclListName,
  AclMutationInput,
  AccountBody,
  AccountCreateInput,
  AccountUpdateInput,
  ChangeBody,
  ConfigBody,
  ConfigKeyBody,
  DataRef,
  StatusBody,
  StatusData,
  UsageBody,
  UsageOneBody,
  UsageRef,
  UsageRowBody,
  UsersBody,
} from "./types.js";

export { getStatus } from "./status.js";
export { getConfig } from "./config.js";
export { createAccount, deleteAccount, getAccount, listAccounts, updateAccount } from "./users.js";
export { addAclEntry, getAcl, removeAclEntry } from "./acl.js";
export { getUsage, getUsageFor } from "./usage.js";
export { asArray, asRecord } from "./decode.js";
