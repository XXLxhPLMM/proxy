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
  /**
   * **哪个 env 文件带来了哪个 env 键**（值为该文件的绝对路径）。
   * @description
   * 只含**文件带来的**键：宿主 env 与 CLI 已经给出的键不在其中（那个键的生效值由那两侧
   * 决定，归到文件头上会把诊断指到一个不决定结果的地方）。多个文件给同一键时记**后写入**
   * 的那个，与合并优先级一致。
   *
   * 键名是 **env 名**（`FIELDS[].env`），不是 store 键名 —— 与 `envKeys` / `argvKeys`
   * 以及 `readEnvFiles` 的返回值同源，三份元数据因此可以逐字互查。
   *
   * ⚠️ **本字段不是「值来自哪里」的完整答案**：不在本表里的键可能来自宿主 env、CLI
   * **或缺省值**，这三者在 `loadConfig` 之后已不可区分。消费方必须把「不在本表」读成
   * 「不是文件带来的」，而不是「一定来自缺省」。
   */
  readonly fileOrigins: ReadonlyMap<string, string>;
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
    // 只复制不冻结：Map 的内容是只读的语义（消费方只查不改），而 Object.freeze 对 Map
    // **不生效**（它冻结的是那个 Map 对象，set() 仍能改内容）——冻结一个防不住的东西，
    // 只会让人以为防住了。故这里给一份**新** Map，调用方拿到的与 `readEnvFiles` 那份无关联。
    fileOrigins: new Map(sources?.fileOrigins ?? []),
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
