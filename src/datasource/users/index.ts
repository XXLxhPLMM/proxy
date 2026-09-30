/**
 * @fileoverview 账号数据源子目录 barrel
 * @module datasource/users/index
 * @description
 * 对外出口。**本 barrel 是账号数据源的唯一出口**（含 `registry.ts` 的三个注册面函数）——
 * 跨目录引用只引本文件，`src/datasource/index.ts` 由上层统一再转出。
 */

export { ACCOUNTS_DB_NAME, SqliteAccountSource } from "./sqlite-source.js";
export { JsonAccountSource } from "./json-source.js";
// `normalizeAccountExpiry` 一并出去：磁盘形态的 ISO 8601 串 → epoch 毫秒的**唯一**那个归一。
// 它对外的理由很具体——CLI（`proxy-cli user set --expires`）收的是磁盘形态、而它要交给
// `AccountSource.put` 的是归一化形态（epoch 毫秒），那份转换的判据必须是本函数而不是 CLI 自己
// 的 `Date.parse`（后者会给「无时区偏移」的写法默默猜一个时区，见本函数的注释）。
export { normalizeAccountExpiry, normalizeOne, toAccountDoc, validateAuthUsers } from "./validate.js";
export {
  accountSourceFor,
  listAccountSourceDrivers,
  registerAccountSource,
  resolveAccountSource,
} from "./registry.js";
export {
  hasAccountDisabled,
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
