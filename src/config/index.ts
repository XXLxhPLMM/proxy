/**
 * 配置层唯一对外出口（barrel）。
 *
 * 跨目录只引本文件。访问控制名单与账号表的读取面都不在这里（它们已独立成数据源，出口
 * `@/datasource/acl/index.js` 与 `@/datasource/users/index.js`）；本 barrel 只出**接线**：
 * 把配置访问器翻译成数据源要的「驱动名 + 路径」两个闭包。
 */

export { ConfigStore, defaults } from "./store.js";
export type {
  AppConfig,
  AuthType,
  ConfigChangeListener,
  ConfigKey,
  LogLevel,
  StoreDriver,
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
// readEnvFiles/parseRawArgv/getConfigDir 属编排内部件，由 load.ts 独占使用
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

export { accountLocatorFor, accountLocatorFrom } from "./account-locator.js";
export { aclLocatorFor, aclLocatorFrom } from "./acl-locator.js";
