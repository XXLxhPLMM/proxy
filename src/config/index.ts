/**
 * 配置层唯一对外出口（barrel）。
 *
 * 跨目录只引本文件；**唯一的第二出口是 `@/config/files/rules/index.js`**（acl.json 条目
 * 规则层），它刻意不进本 barrel——理由与分层职责见 ./AGENTS.md「硬约定」与决策 4、5。
 */

export { ConfigStore, defaults } from "./store.js";
export type {
  AppConfig,
  AuthType,
  CacheType,
  ConfigChangeListener,
  ConfigKey,
  LogLevel,
} from "./types.js";

export { configAccessorFromStore, createConfigContext } from "./context.js";
export type {
  ConfigAccessor,
  ConfigContext,
  ConfigSourceMetadata,
  ConfigStoreReader,
  CreateConfigContextOptions,
} from "./context.js";

export { FIELDS, keysByPhase } from "./schema/index.js";
export type { FieldDef } from "./schema/index.js";

// sources 只出「产候选文件名」这一层公开能力（CLI 需要自己决定读哪些文件）；
// readEnvFiles/parseRawArgv/getConfigDir 属编排内部件，由 load.ts 独占使用——见 ./AGENTS.md 决策 2
export { defaultEnvFileNames } from "./sources/index.js";

// normalize 同理只出跨目录装配入口，路径/URL 的纯函数原语留给本目录内部编排
export { prepareRuntimeConfigStore } from "./normalize/index.js";
export type { PreparedRuntimeConfig } from "./normalize/index.js";

export { loadConfig } from "./load.js";
export type { LoadConfigOptions } from "./load.js";

export {
  applyPreset,
  builtinPresets,
  definePreset,
  getPreset,
  listPresets,
  registerPreset,
  type ProxyPreset,
} from "./presets.js";

export {
  createJsonFileEventHandler,
  hasConfiguredAcl,
  loadAcl,
  loadAuthUsers,
  loadUserPolicy,
  loadUserQuota,
  readAcl,
  readAuthUsers,
  readAclAsync,
  readAuthUsersAsync,
  validateAcl,
  validateAuthUsers,
  type AclConfig,
  type AclList,
  type AuthAccount,
  type UserPolicy,
  type UserPolicyList,
  type UserQuota,
} from "./files/index.js";
