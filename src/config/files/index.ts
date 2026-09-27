/**
 * files 层出口：只做「读文件、校验结构、报告状态迁移」；请求期如何使用这些数据不在这里。
 * 各文件职责与边界理由见 ./AGENTS.md。
 */

export {
  loadAuthUsers,
  loadUserPolicy,
  loadUserQuota,
  readAuthUsers,
  readAuthUsersAsync,
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
