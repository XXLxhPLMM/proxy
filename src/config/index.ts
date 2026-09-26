/**
 * 配置层唯一对外出口。
 *
 * 跨目录引用一律走本文件（`@/config/index.js`），**不要**深入 `config/` 内部路径：
 * 这样目录重构时调用方零改动，config 内部也能自由拆分文件而不牵动外部。
 *
 * **唯一的第二出口是 `@/config/files/rules/index.js`**（acl.json 的条目规则层：IP/CIDR
 * 解析编译 + 主机/通配域名匹配）。它刻意**不进**本 barrel：它是一组纯函数原语，被
 * `core/access-control.ts` 与转发层在热路径上高频调用，与「配置状态/加载器」是两类关注点。
 * 除它之外，跨目录引任何 `@/config/...` 深路径都算违规。
 *
 * 分层（依赖单向，由下至上）：
 * ```
 * types.ts        字段契约（纯类型）
 * store.ts        唯一状态 + 默认种子（零 IO）
 * schema/         字段元数据 + 解析原语 + 校验 + upstream-url.ts（UPSTREAM_URL 契约）
 * sources/        配置目录 / env 文件 / CLI argv → 键值
 * normalize/      路径与 UPSTREAM_URL 归一化（纯内存，实现调 schema/upstream-url.ts）
 * context.ts      ConfigAccessor 只读端口 + ConfigContext
 * files/          users.json / acl.json 读取校验 + 热加载事件日志
 * files/rules/    acl.json 条目规则层（纯函数；第二出口，不进本 barrel）
 * presets.ts      配置预设
 * load.ts         唯一 async 加载器（唯一做 IO 编排的入口）
 * ```
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
// readEnvFiles/parseRawArgv/getConfigDir 属编排内部件，由 load.ts 独占使用，不对外。
export { defaultEnvFileNames } from "./sources/index.js";

// normalize 只出跨目录的装配入口；路径/URL 的纯函数原语留给本目录内部编排。
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
