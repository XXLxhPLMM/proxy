import type { Context, Plugin } from "cordis";
import type { ConfigKey } from "@/config/types.js";
import { PRESET_NAMES } from "@/config/presets.js";
import type { EventDispatcher } from "./event-dispatch.js";
import {
  CONFIG_LOADED_EVENT,
  PRESET_APPLIED_EVENT,
  PROXY_LIFECYCLE_EVENT,
  type ConfigLoadedEvent,
  type PresetSelectedEvent,
  type RuntimeEventEnvelope,
  type RuntimeEventObserver,
  type StartupFact,
  type StartupLifecycleEvent,
} from "./events.js";

/** startupFacts 的默认上限；达到上限后只保留最新的启动事实。 */
export const DEFAULT_STARTUP_FACT_LIMIT = 32;
const MAX_STARTUP_FACT_LIMIT = 128;

export interface StartupJournal {
  readonly active: boolean;
  record(envelope: RuntimeEventEnvelope): void;
  snapshot(): readonly StartupFact[];
  dispose(): void;
}

function normalizedLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_STARTUP_FACT_LIMIT;
  }
  return Math.min(MAX_STARTUP_FACT_LIMIT, Math.max(1, Math.trunc(limit)));
}

function isStringArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string") {
      return false;
    }
  }
  return true;
}

function isPresetName(value: unknown): boolean {
  return typeof value === "string" && (PRESET_NAMES as readonly string[]).includes(value);
}

function isConfigLoadedFact(payload: unknown): payload is ConfigLoadedEvent {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const candidate = payload as { readonly operation?: unknown; readonly preset?: unknown };
  return (
    candidate.operation === "load" &&
    (candidate.preset === undefined || isPresetName(candidate.preset))
  );
}

function isPresetFact(payload: unknown): payload is PresetSelectedEvent {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const candidate = payload as {
    readonly name?: unknown;
    readonly keys?: unknown;
    readonly plugins?: unknown;
  };
  return (
    isPresetName(candidate.name) &&
    isStringArray(candidate.keys) &&
    isStringArray(candidate.plugins)
  );
}

function isStartupLifecycle(payload: unknown): payload is StartupLifecycleEvent {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const candidate = payload as { readonly operation?: unknown; readonly phase?: unknown };
  return (
    candidate.operation === "start" &&
    (candidate.phase === "starting" || candidate.phase === "running")
  );
}

function cloneConfigLoadedPayload(payload: ConfigLoadedEvent): ConfigLoadedEvent {
  const preset = payload.preset;
  return Object.freeze({
    operation: "load",
    ...(preset === undefined ? {} : { preset }),
  });
}

function clonePresetPayload(payload: PresetSelectedEvent): PresetSelectedEvent {
  const keys = new Array<ConfigKey>(payload.keys.length);
  const plugins = new Array<string>(payload.plugins.length);
  for (let index = 0; index < payload.keys.length; index += 1) {
    keys[index] = payload.keys[index];
  }
  for (let index = 0; index < payload.plugins.length; index += 1) {
    plugins[index] = payload.plugins[index];
  }
  return Object.freeze({
    name: payload.name,
    keys: Object.freeze(keys),
    plugins: Object.freeze(plugins),
  });
}

function cloneStartupLifecyclePayload(payload: StartupLifecycleEvent): StartupLifecycleEvent {
  return Object.freeze({
    operation: "start",
    phase: payload.phase,
  });
}

function toStartupFact(envelope: RuntimeEventEnvelope): StartupFact | undefined {
  switch (envelope.event) {
    case CONFIG_LOADED_EVENT:
      if (!isConfigLoadedFact(envelope.payload)) {
        return undefined;
      }
      return Object.freeze({
        event: envelope.event,
        sequence: envelope.sequence,
        payload: cloneConfigLoadedPayload(envelope.payload),
      }) as StartupFact;
    case PRESET_APPLIED_EVENT:
      if (!isPresetFact(envelope.payload)) {
        return undefined;
      }
      return Object.freeze({
        event: envelope.event,
        sequence: envelope.sequence,
        payload: clonePresetPayload(envelope.payload),
      }) as StartupFact;
    case PROXY_LIFECYCLE_EVENT:
      if (!isStartupLifecycle(envelope.payload)) {
        return undefined;
      }
      return Object.freeze({
        event: envelope.event,
        sequence: envelope.sequence,
        payload: cloneStartupLifecyclePayload(envelope.payload),
      }) as StartupFact;
    default:
      // resource/reload/error/stopping/stopped/failed 都不是 startupFacts。
      return undefined;
  }
}

/** 创建一个有界、只读且不持有原始 payload 引用的启动事实 journal。 */
export function createStartupJournal(limit: number = DEFAULT_STARTUP_FACT_LIMIT): StartupJournal {
  const maxFacts = normalizedLimit(limit);
  const facts: Array<StartupFact | undefined> = new Array<StartupFact | undefined>(maxFacts);
  let first = 0;
  let size = 0;
  let active = true;

  return {
    get active(): boolean {
      return active;
    },
    record(envelope: RuntimeEventEnvelope): void {
      if (!active) {
        return;
      }
      let fact: StartupFact | undefined;
      try {
        if (!Number.isSafeInteger(envelope.sequence)) {
          return;
        }
        fact = toStartupFact(envelope);
      } catch {
        return;
      }
      if (!fact) {
        return;
      }
      const index = (first + size) % maxFacts;
      facts[index] = fact;
      if (size < maxFacts) {
        size += 1;
      } else {
        first = (first + 1) % maxFacts;
      }
    },
    snapshot(): readonly StartupFact[] {
      const result: StartupFact[] = [];
      for (let offset = 0; offset < size; offset += 1) {
        const fact = facts[(first + offset) % maxFacts];
        if (fact !== undefined) {
          result.push(fact);
        }
      }
      return Object.freeze(result);
    },
    dispose(): void {
      active = false;
    },
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return false;
  }
  try {
    return typeof Reflect.get(value, "then") === "function";
  } catch {
    return false;
  }
}

function notifyObserver(
  observer: RuntimeEventObserver | undefined,
  envelope: RuntimeEventEnvelope,
  isActive: () => boolean,
): void {
  if (observer === undefined || !isActive()) {
    return;
  }
  try {
    queueMicrotask(() => {
      if (!isActive()) {
        return;
      }
      try {
        const observed = observer(envelope);
        if (isPromiseLike(observed)) {
          void Promise.resolve(observed).catch(() => {
            // observer rejection 不得反噬启动/停止，也不得变成 unhandled rejection。
          });
        }
      } catch {
        // observer throw 与 dispatcher listener throw 一样只能被隔离。
      }
    });
  } catch {
    // 防御宿主不提供可用 microtask 调度器；旁路仍不能影响业务操作。
  }
}

/**
 * 挂载无 inject 的 runtime observer。
 *
 * 它不订阅或读取 Context，而是使用 dispatcher 的安全发布旁路；因此不会取得
 * ConfigService/AppConfig，也不会让外部 callback 进入 ctx.parallel 的 deadline。
 */
export function createObserverPlugin(
  dispatcher: EventDispatcher,
  observer: RuntimeEventObserver | undefined,
  journal: StartupJournal,
): Plugin.Object<void> {
  return {
    name: "runtime-event-observer",
    apply(ctx: Context) {
      let active = true;
      ctx.effect(() => {
        const disposeEvent = dispatcher.onEvent((envelope) => {
          if (!active) {
            return;
          }
          try {
            journal.record(envelope);
          } catch {
            // journal 自身异常也不能阻断外部 observer 或业务操作。
          }
          notifyObserver(observer, envelope, () => active);
        });
        return () => {
          active = false;
          disposeEvent();
          journal.dispose();
        };
      }, "runtime event observer");
    },
  };
}
