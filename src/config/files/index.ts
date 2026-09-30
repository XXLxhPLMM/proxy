/**
 * files 层出口：只做「读数据、校验结构、报告状态迁移」；请求期如何使用这些数据不在这里。
 */

export {
  ACCOUNTS_DB_NAME,
  JsonAccountStore,
  SqliteAccountStore,
  accountStoreFor,
  type AccountListOptions,
  type AccountStore,
} from "./account-store.js";
export {
  hasAccountExpiry,
  loadAuthUsers,
  loadUserPolicy,
  loadUserQuota,
  readAuthUsers,
  readAuthUsersAsync,
  readAuthUsersAsyncStartup,
  validateAuthUsers,
  type AuthAccount,
  type ReadAuthUsersOptions,
  type UserPolicy,
  type UserPolicyList,
  type UserQuota,
} from "./users.js";
export {
  hasConfiguredAcl,
  loadAcl,
  readAcl,
  readAclAsync,
  validateAcl,
  type AclConfig,
  type AclList,
} from "./acl.js";
export { createJsonFileEventHandler, logJsonFileEvent } from "./event-log.js";
