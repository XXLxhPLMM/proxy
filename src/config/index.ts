/**
 * 配置层唯一对外出口。
 *
 * 跨目录引用一律走本文件（`@/config/index.js`），**不要**深入 `config/` 内部路径：
 * 这样目录重构时调用方零改动，config 内部也能自由拆分文件而不牵动外部。
 *
 * 分层（依赖单向，由下至上）：
 * ```
 * types.ts        字段契约（纯类型）
 * store.ts        唯一状态 + 默认种子（零 IO）
 * schema/         字段元数据 + 解析原语 + 校验
 * sources/        配置目录 / env 文件 / CLI argv → 键值
 * normalize/      路径与 UPSTREAM_URL 归一化（纯内存）
 * context.ts      ConfigAccessor 只读端口 + ConfigContext
 * files/          users.json / acl.json 读取校验 + 热加载事件日志
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
  readAcl,
  readAuthUsers,
  readAclAsync,
  readAuthUsersAsync,
  validateAcl,
  validateAuthUsers,
  type AclConfig,
  type AclList,
  type AuthAccount,
} from "./files/index.js";
