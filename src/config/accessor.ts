/**
 * 配置读取端口与加载上下文。
 *
 * `ConfigAccessor` 是配置消费者能看到的最小能力面：只有泛型 `get`，没有写入、
 * 全量读取或任何隐式全局状态。`ConfigStore` 通过一个独立闭包适配成该端口，
 * 因而多个实例不会共享读取器。
 */

import { keysByPhase } from "./fields.js";
import { resolveConfigPaths } from "./runtime-config.js";
import type { AppConfig, ConfigKey, ConfigStore } from "./store.js";

/** 配置消费者所需的最小读取能力。 */
export interface ConfigAccessor {
  get<K extends ConfigKey>(key: K): AppConfig[K];
}

/**
 * 可被适配为 `ConfigAccessor` 的结构化只读 store。
 *
 * 这里只要求 `get`，不要求 `getAll`、写入能力或某个具体类，便于第三方提供自己的
 * 配置容器。
 */
export interface ConfigStoreReader {
  get(key: ConfigKey): AppConfig[ConfigKey];
}

/**
 * 从结构化只读 store 派生访问器。
 *
 * 每次调用都返回一个新的、稳定的适配对象；读取时直接委托给传入的 store，因此
 * store 后续热改仍会立即反映到 accessor，而不同调用的 accessor 对象彼此独立。
 */
export function configAccessorFromStore(store: ConfigStoreReader): ConfigAccessor {
  const accessor: ConfigAccessor = {
    get: <K extends ConfigKey>(key: K): AppConfig[K] => store.get(key) as AppConfig[K],
  };
  return Object.freeze(accessor);
}

/**
 * 一次加载所使用的来源元数据。
 *
 * 这里故意只记录键名/路径，不记录任何值：日志、诊断和事件消费方可以知道配置来自
 * 哪些来源，但不会把密码或其它敏感配置复制到上下文里。
 */
export interface ConfigSourceMetadata {
  readonly envKeys: readonly string[];
  /** 已解析为绝对路径的 env 文件列表，包含调用方明确传入但可能不存在的文件。 */
  readonly envFiles: readonly string[];
  readonly argvKeys: readonly string[];
}

/** 成功加载后返回的不可变初始视图。 */
export interface ConfigContext {
  readonly store: ConfigStore;
  readonly accessor: ConfigAccessor;
  /** 加载完成时的配置快照；后续 store 热改不会改写这份快照。 */
  readonly config: Readonly<AppConfig>;
  readonly configDir: string;
  readonly sources: ConfigSourceMetadata;
  readonly startupKeys: readonly ConfigKey[];
  readonly warnings: readonly string[];
}

/** `createConfigContext` 的对象形式参数。 */
export interface CreateConfigContextOptions {
  store: ConfigStore;
  configDir: string;
  sources?: Partial<ConfigSourceMetadata>;
  warnings?: readonly string[];
}

function copySources(sources?: Partial<ConfigSourceMetadata>): ConfigSourceMetadata {
  return Object.freeze({
    envKeys: Object.freeze([...(sources?.envKeys ?? [])]),
    envFiles: Object.freeze([...(sources?.envFiles ?? [])]),
    argvKeys: Object.freeze([...(sources?.argvKeys ?? [])]),
  });
}

function allStartupKeys(): ConfigKey[] {
  return keysByPhase().startup;
}

/**
 * 创建一次加载对应的上下文。
 *
 * 只接受对象参数，`configDir` 必须显式提供；startup 相位始终取 FIELDS 的完整集合，
 * 不允许调用方删减。每次调用都新建 accessor/context，context 内的快照、来源数组和
 * 警告数组都与输入脱钩。创建前会把 store 中标记为
 * path 的字段按 configDir 归一化，accessor 与冻结快照因此始终看到同一份绝对路径。
 */
export function createConfigContext(options: CreateConfigContextOptions): ConfigContext {
  const startupKeys = allStartupKeys();
  const normalized = resolveConfigPaths(options.store.getAll(), options.configDir);
  options.store.merge(normalized);
  const accessor = configAccessorFromStore(options.store);
  const config = Object.freeze(options.store.getAll());
  return Object.freeze({
    store: options.store,
    accessor,
    config,
    configDir: options.configDir,
    sources: copySources(options.sources),
    startupKeys: Object.freeze(startupKeys),
    warnings: Object.freeze([...(options.warnings ?? [])]),
  });
}
