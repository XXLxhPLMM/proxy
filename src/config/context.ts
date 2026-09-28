import path from "node:path";
import { keysByPhase } from "./schema/fields.js";
import { resolveConfigPaths } from "./normalize/paths.js";
import type { ConfigStore } from "./store.js";
import type { AppConfig, ConfigKey } from "./types.js";

export interface ConfigAccessor {
  get<K extends ConfigKey>(key: K): AppConfig[K];
}

export interface ConfigStoreReader {
  get(key: ConfigKey): AppConfig[ConfigKey];
}

export function configAccessorFromStore(store: ConfigStoreReader): ConfigAccessor {
  const accessor: ConfigAccessor = {
    get: <K extends ConfigKey>(key: K): AppConfig[K] => store.get(key) as AppConfig[K],
  };
  return Object.freeze(accessor);
}

/**
 * 这里故意只记录键名/路径，不记录任何值：日志、诊断和事件消费方可以知道配置来自
 * 哪些来源，但不会把密码或其它敏感配置复制到上下文里。
 */
export interface ConfigSourceMetadata {
  readonly envKeys: readonly string[];
  /** 已解析为绝对路径的 env 文件列表，包含调用方明确传入但可能不存在的文件。 */
  readonly envFiles: readonly string[];
  readonly argvKeys: readonly string[];
}

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
 * `startup` 相位恒取 FIELDS 的完整集合，不接受调用方删减；`path` 类字段在冻结
 * 快照前按 `configDir` 归一化，故 accessor 与快照恒见同一份绝对路径。
 */
export function createConfigContext(options: CreateConfigContextOptions): ConfigContext {
  const startupKeys = allStartupKeys();
  const configDir = path.resolve(options.configDir);
  const normalized = resolveConfigPaths(options.store.getAll(), configDir);
  options.store.merge(normalized);
  const accessor = configAccessorFromStore(options.store);
  const config = Object.freeze(options.store.getAll());
  return Object.freeze({
    store: options.store,
    accessor,
    config,
    configDir,
    sources: copySources(options.sources),
    startupKeys: Object.freeze(startupKeys),
    warnings: Object.freeze([...(options.warnings ?? [])]),
  });
}
