/**
 * @fileoverview 访问控制名单数据源出口（端口 + 校验 + JSON 实现器 + 驱动注册表）
 * @module datasource/acl
 * @description
 * 跨目录只引本 barrel。名单是**数据**不是配置：它决定「谁被放行」，而这一层不该由
 * 「配置文件长什么样」来决定。装配（谁用哪个驱动）由消费方给 `ConfigAccessor` 完成。
 *
 * 判定语义（黑白名单优先级、命中后动作、client/target/upstream 三组的真值表）**不在这里**，
 * 在 `src/core/access-control.ts`。
 */

export { EMPTY_ACL, type AclConfig, type AclList, type AclLocator, type AclReadOptions, type AclSource, type AclSourceFactory } from "./types.js";
export { validateAcl } from "./validate.js";
export { JsonAclSource } from "./json-source.js";
export {
  aclSourceFor,
  hasAclSourceDriver,
  hasConfiguredAcl,
  listAclSourceDrivers,
  loadAcl,
  readAcl,
  registerAclSource,
  resolveAclSource,
  type ReadAclOptions,
} from "./registry.js";