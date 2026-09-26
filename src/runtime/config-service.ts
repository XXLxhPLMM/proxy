/**
 * ConfigService - 配置加载、事务式 runtime reload 与资源 pull 端口
 *
 * 这里不读取环境变量、不维护第二份字段表或长期配置快照；外部 startup
 * 配置由 `config/load.ts` 编排，`config/store.ts` 负责保存，`config/schema/fields.ts`
 * 负责提供 phase/校验规则，资源 pull 委托 `config/resources/pull.ts`。
 * reload/refresh 共用一条串行队列，成功提交前不会改变 store。
 */
import { initConfig, prepareRuntimeConfig } from "@/config/load.js";
import {
  refreshConfigResource,
  type ConfigResourceReadResult,
} from "@/config/resources/pull.js";
import { commitConfig, get, getAll } from "@/config/store.js";
import type { AppConfig, ConfigKey } from "@/config/types.js";
import { keysByPhase } from "@/config/schema/fields.js";
import { sanitizeJsonFileErrorText } from "@/utils/file/json.js";
import { type ConfigResource } from "@/config/resources/events.js";
import type { PresetName } from "@/config/presets.js";

export type ConfigServiceState = "unloaded" | "loading" | "ready" | "failed";
export type ConfigPhase = "startup" | "runtime";
export type ConfigOperation = "load" | "reload";
/** Resource refresh API 的显式资源身份别名。 */
export type ConfigResourceId = ConfigResource;

/** 对外可见的安全失败描述；绝不保存或发布原始 Error/cause。 */
export interface ConfigFailure {
  readonly operation: ConfigOperation;
  readonly name: string;
  readonly code?: string | number;
  readonly message: string;
  /** reload 失败时旧 store 快照仍保留；load 失败为 false。 */
  readonly retained: boolean;
}

export interface ConfigReloadResult {
  readonly changed: readonly ConfigKey[];
}

/** force pull 的结果只含资源身份、路径和状态元数据，不含 users/ACL 内容。 */
export type ConfigResourceRefreshResult = ConfigResourceReadResult;

export type ConfigServiceEvent =
  | {
      readonly type: "loaded";
      readonly operation: "load";
    }
  | {
      readonly type: "reloaded";
      readonly operation: "reload";
      readonly changed: readonly ConfigKey[];
    }
  | {
      readonly type: "failed";
      readonly operation: ConfigOperation;
      readonly failure: ConfigFailure;
    };

export type ConfigServiceEventListener = (event: ConfigServiceEvent) => void | Promise<void>;

export interface ConfigService {
  /** 当前加载状态。 */
  readonly state: ConfigServiceState;
  /** 最近一次失败的安全描述；成功或尚未操作时为 undefined。 */
  readonly lastFailure: ConfigFailure | undefined;

  /** 显式执行一次现有 loader 初始化；load/reload/refresh 共用串行队列。 */
  load(): Promise<AppConfig>;

  /**
   * 事务式更新 runtime 字段。startup 字段整批拒绝；成功后只报告实际变化。
   * 失败时保留旧快照并重新抛出原始错误给直接调用者，但公开事件只使用安全字段。
   */
  reload(patch: Partial<AppConfig>): Promise<ConfigReloadResult>;

  /** 强制 pull 一个 users/ACL 资源；不新增 watcher，不返回资源内容。 */
  refreshResource(resource: ConfigResourceId): Promise<ConfigResourceRefreshResult>;

  /** 订阅安全的服务事实；disposer 幂等，监听器异常与 rejection 均隔离。 */
  subscribe(listener: ConfigServiceEventListener): () => void;

  /** 读取已加载配置中的单个字段。 */
  get<K extends ConfigKey>(key: K): AppConfig[K];

  /** 获取已加载配置快照。 */
  getAll(): AppConfig;

  /** getAll 的语义别名。 */
  snapshot(): AppConfig;

  /** 查询字段生效阶段，直接委托 fields.keysByPhase。 */
  phaseOf(key: ConfigKey): ConfigPhase;

  /** 读取当前启用的预设名称；未启用时为空串。 */
  activePreset(): PresetName | "";
}

function readObjectProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeText(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  return sanitizeJsonFileErrorText(value);
}

function safeErrorParts(error: unknown): { name: string; code?: string | number; message: string } {
  const rawName = readObjectProperty(error, "name");
  const rawCode = readObjectProperty(error, "code");
  const rawMessage = readObjectProperty(error, "message");
  const name = typeof rawName === "string" ? safeText(rawName, "Error") : "Error";
  const message =
    typeof rawMessage === "string"
      ? safeText(rawMessage, "未知错误")
      : typeof error === "string"
        ? safeText(error, "未知错误")
        : "未知错误";
  const code =
    typeof rawCode === "number" && Number.isFinite(rawCode)
      ? rawCode
      : typeof rawCode === "string"
        ? safeText(rawCode, "unknown")
        : undefined;
  return {
    name,
    ...(code === undefined ? {} : { code }),
    message,
  };
}

function makeFailure(error: unknown, operation: ConfigOperation, retained: boolean): ConfigFailure {
  const parts = safeErrorParts(error);
  return Object.freeze({
    operation,
    ...parts,
    retained,
  });
}

function isConfigResource(value: string): value is ConfigResource {
  return value === "authUsers" || value === "acl";
}

/** 创建配置服务；所有改变配置的入口都经过同一条 Promise 队列。 */
export function createConfigService(): ConfigService {
  let state: ConfigServiceState = "unloaded";
  let lastFailure: ConfigFailure | undefined;
  let tail: Promise<void> = Promise.resolve();
  const listeners = new Set<ConfigServiceEventListener>();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation);
    // 无论本次操作成功还是失败，后续操作都必须继续执行。
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function emit(event: ConfigServiceEvent): void {
    for (const listener of [...listeners]) {
      try {
        const result = listener(event);
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => {
            // 观察者失败不得改变配置操作结果。
          });
        }
      } catch {
        // 观察者失败不得改变配置操作结果。
      }
    }
  }

  function requireReady(operation: string): void {
    if (state !== "ready") {
      throw new Error(`配置服务尚未就绪（state=${state}），请先调用 load() ${operation}`);
    }
  }

  function readSnapshot(): AppConfig {
    requireReady("读取配置");
    return getAll();
  }

  function load(): Promise<AppConfig> {
    return enqueue(async () => {
      if (state === "ready") {
        return getAll();
      }

      state = "loading";
      try {
        const loaded = initConfig();
        state = "ready";
        lastFailure = undefined;
        emit({ type: "loaded", operation: "load" });
        return loaded;
      } catch (error) {
        const failure = makeFailure(error, "load", false);
        state = "failed";
        lastFailure = failure;
        emit({ type: "failed", operation: "load", failure });
        throw error;
      }
    });
  }

  function reload(patch: Partial<AppConfig>): Promise<ConfigReloadResult> {
    return enqueue(async () => {
      const retained = state === "ready";
      try {
        requireReady("重载配置");
        if (
          typeof patch === "object" &&
          patch !== null &&
          !Array.isArray(patch) &&
          Object.keys(patch).length === 0
        ) {
          lastFailure = undefined;
          return { changed: Object.freeze([]) as readonly ConfigKey[] };
        }
        const current = getAll();
        const candidate = prepareRuntimeConfig(current, patch);
        const changed = (Object.keys(candidate) as ConfigKey[]).filter(
          (key) => !Object.is(candidate[key], current[key]),
        );
        const safeChanged = Object.freeze(changed);
        if (safeChanged.length === 0) {
          lastFailure = undefined;
          return { changed: safeChanged };
        }

        // candidate 已通过 loader 的所有检查；这是唯一的批量写边界。
        commitConfig(candidate);
        lastFailure = undefined;
        emit({ type: "reloaded", operation: "reload", changed: safeChanged });
        return { changed: safeChanged };
      } catch (error) {
        const failure = makeFailure(error, "reload", retained);
        lastFailure = failure;
        // state 在 reload 失败时仍为 ready，旧快照未被 commit。
        emit({ type: "failed", operation: "reload", failure });
        throw error;
      }
    });
  }

  function refreshResource(resource: ConfigResourceId): Promise<ConfigResourceRefreshResult> {
    return enqueue(async () => {
      requireReady("刷新配置资源");
      if (!isConfigResource(resource)) {
        throw new Error(`配置服务: 未知资源 ${String(resource)}`);
      }
      const path = resource === "authUsers" ? get("authUsersFile") : get("aclFile");
      return refreshConfigResource(resource, path);
    });
  }

  function getValue<K extends ConfigKey>(key: K): AppConfig[K] {
    requireReady("读取配置");
    return get(key);
  }

  function phaseOf(key: ConfigKey): ConfigPhase {
    const phases = keysByPhase();
    if (phases.startup.includes(key)) {
      return "startup";
    }
    if (phases.runtime.includes(key)) {
      return "runtime";
    }
    throw new Error(`配置服务: 未知配置字段 ${String(key)}`);
  }

  return {
    get state(): ConfigServiceState {
      return state;
    },
    get lastFailure(): ConfigFailure | undefined {
      return lastFailure;
    },
    load,
    reload,
    refreshResource,
    subscribe(listener: ConfigServiceEventListener): () => void {
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        listeners.delete(listener);
      };
    },
    get: getValue,
    getAll: readSnapshot,
    snapshot: readSnapshot,
    phaseOf,
    activePreset(): PresetName | "" {
      requireReady("读取当前预设");
      return get("preset");
    },
  };
}
