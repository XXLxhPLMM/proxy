/**
 * 数据源操作层（ops）出口 —— 传输层（`proxy-cli`）与「数据」之间的那一段
 *
 * @description
 * 本层做**数据源的操作**（装配 / 读 / 写 / 账本读 / 配置事实），**不做呈现**：
 * - 它返回**结构化数据**（对象 / 数组 / `Map`）并**抛 `OpsError`** 表达失败，绝不 `console`、
 *  绝不碰 `process.*`、绝不渲染表格或任何面向人的行；
 * - 呈现、通道选择（stdout / stderr）、退出码、帮助文本全归 `@/admin/`。
 *
 * ## 依赖方向
 *
 * 向下只用 `@/config/index.js`（折接线）、`@/addr/index.js`（名单条目语法原语）
 * 与 `@/datasource/*`。**绝不 import `@/admin/*`、`@/core/*`、`@/runtime/*`、`@/server/*`** ——
 * 管理工具不启动代理，它没有理由持有任何代理侧的东西；而反向也不成立：数据源操作不该知道
 * 「谁在显示它的结果」。双向都断，这条路径才可能再接一个 HTTP / manager 面而不动本层。
 *
 * 本目录内部用相对路径，**不自我引用本 barrel**；`./error.js` 与 `./change.js` 单列正是为此
 * （它们被本层每一个模块使用，而 barrel 会把兄弟模块全拉进循环依赖图）。
 */

export { OpsError, type OpsErrorCode } from "./error.js";
export type { OpsChange } from "./change.js";

export {
  opsSourcesFromContext,
  readAccountsOrFail,
  readAclOrFail,
  requireAclWrite,
  resolveOpsSources,
  type OpsSources,
  type UsageObserver,
} from "./sources.js";

export {
  addAccount,
  applyPatch,
  findAccount,
  getAccount,
  inertNoticeFor,
  listAccounts,
  passwdAccount,
  removeAccount,
  setAccount,
  setAccountEnabled,
  type AccountPatch,
} from "./accounts.js";

export {
  aclGroupKey,
  addAclEntry,
  readAcl,
  removeAclEntry,
  type AclGroupName,
  type AclListName,
} from "./acl.js";

export { readUsage, usageFor, type OpsUsageReading } from "./usage.js";

export {
  redactConfigValue,
  reportConfig,
  reportConfigKeys,
  type OpsConfigEntry,
  type OpsConfigPhase,
  type OpsConfigReport,
  type OpsConfigSnapshot,
  type OpsDataRef,
  type OpsUsageRef,
} from "./report.js";
