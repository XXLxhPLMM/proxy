/**
 * files 层出口：磁盘上的配置资源（users.json / acl.json）+ 热加载事件呈现。
 *
 * 本层只做「读文件、校验结构、报告状态迁移」；请求期如何使用这些数据不在这里。
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
  loadAcl,
  readAcl,
  readAclAsync,
  validateAcl,
  type AclConfig,
  type AclList,
} from "./acl.js";
export { createJsonFileEventHandler, logJsonFileEvent } from "./event-log.js";
