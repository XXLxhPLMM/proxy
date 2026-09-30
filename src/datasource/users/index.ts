/**
 * @fileoverview 账号数据源子目录 barrel
 * @module datasource/users/index
 * @description
 * 对外出口。**本 barrel 是账号数据源的唯一出口**（含 `registry.ts` 的三个注册面函数）——
 * 跨目录引用只引本文件，`src/datasource/index.ts` 由上层统一再转出。
 */

export { ACCOUNTS_DB_NAME, SqliteAccountSource } from "./sqlite-source.js";
export { JsonAccountSource } from "./json-source.js";
export { normalizeOne, toAccountDoc, validateAuthUsers } from "./validate.js";
export {
  accountSourceFor,
  listAccountSourceDrivers,
  registerAccountSource,
  resolveAccountSource,
} from "./registry.js";
export {
  hasAccountExpiry,
  loadAuthUsers,
  loadUserPolicy,
  loadUserQuota,
  readAuthUsers,
  readAuthUsersAsync,
  readAuthUsersAsyncStartup,
  type ReadAuthUsersOptions,
} from "./read.js";
export type {
  AccountListOptions,
  AccountLocator,
  AccountSource,
  AccountSourceFactory,
  AuthAccount,
  PathResolver,
  UserPolicy,
  UserPolicyList,
  UserQuota,
} from "./types.js";
