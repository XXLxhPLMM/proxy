import type { ConfigKey } from "@/config/types.js";
import type { PresetName } from "@/config/presets.js";
import type {
  ConfigResource,
  ConfigResourceOutcome,
  ConfigResourceTransition,
} from "@/config/resources/events.js";
import type { ErrorSummary, NormalizedError } from "./error-service.js";


export const PROXY_LIFECYCLE_EVENT = "proxy/lifecycle" as const;
export const CONFIG_LOADED_EVENT = "config/loaded" as const;
export const CONFIG_RELOADED_EVENT = "config/reloaded" as const;
export const CONFIG_FAILED_EVENT = "config/failed" as const;
export const CONFIG_RESOURCE_EVENT = "config/resource" as const;
export const PRESET_APPLIED_EVENT = "preset/applied" as const;
export const ERROR_OBSERVED_EVENT = "error/observed" as const;

/** dispatcher 可处理的进程内控制面事件白名单。 */
export type RuntimeEventName =
  | typeof PROXY_LIFECYCLE_EVENT
  | typeof CONFIG_LOADED_EVENT
  | typeof CONFIG_RELOADED_EVENT
  | typeof CONFIG_FAILED_EVENT
  | typeof CONFIG_RESOURCE_EVENT
  | typeof PRESET_APPLIED_EVENT
  | typeof ERROR_OBSERVED_EVENT;

export type ProxyLifecycleOperation = "start" | "stop";

/** fatal 只通过操作影响表达，不暗示 runtime 拥有进程退出权。 */
export type ProxyLifecycleImpact = "startup-aborted" | "shutdown-incomplete";

/** 代理生命周期事实事件；failed 通过 operation 与 impact 区分启动/停止失败。 */
export type ProxyLifecycleEvent =
  | {
      readonly operation: "start";
      readonly phase: "starting" | "running";
    }
  | {
      readonly operation: "stop";
      readonly phase: "stopping" | "stopped";
    }
  | {
      readonly operation: ProxyLifecycleOperation;
      readonly phase: "failed";
      readonly impact: ProxyLifecycleImpact;
      /** 仅安全摘要；原始 Error/cause 保持在本地调用栈并原样抛还。 */
      readonly failure: ErrorSummary;
    };

/** 配置错误只允许这些脱敏标量，不允许 Error、cause 或任意对象。 */
export interface ConfigErrorInfo {
  readonly name: string;
  readonly code?: string | number;
  readonly message: string;
}

export interface ConfigLoadedEvent {
  readonly operation: "load";
  readonly preset?: PresetName;
}

export interface ConfigReloadedEvent {
  readonly scope: "runtime";
  readonly changed: readonly ConfigKey[];
  /** preset 是 startup-only，runtime reload 不会改变它。 */
  readonly preset?: PresetName;
}

/** 安全的配置资源状态通知；不携带资源值、配置快照或原始异常。 */
export interface ConfigResourceEvent {
  readonly resource: ConfigResource;
  readonly path: string;
  readonly transition: ConfigResourceTransition;
  readonly outcome: ConfigResourceOutcome;
  /** 文件版本标量；missing 或无法 stat 时可省略。 */
  readonly mtimeMs?: number;
  readonly size?: number;
  /** 已由资源层去敏的纯文本，不是 Error/cause。 */
  readonly error?: string;
}

export interface ConfigFailedEvent {
  readonly operation: "load" | "reload";
  readonly error: ConfigErrorInfo;
  readonly retained: boolean;
}

/**
 * preset 事件的语义是启动时“选择了 catalog 中的定义”。
 * 事件名保留 applied 以描述当前 runtime 边界，但 plugins 只是目录元数据，
 * 不表示本次事件动态加载了插件；ConfigService.reload 也不会发布它。
 */
export interface PresetSelectedEvent {
  readonly name: PresetName;
  readonly keys: readonly ConfigKey[];
  readonly plugins: readonly string[];
}


/** logOwner 只列 ErrorPolicy 真正会产出的值；process guards 走 logger 单例、不经 ErrorPolicy，故不在此列。 */
export type ErrorLogOwner = "runtime" | "cli" | "proxy-server";
export type ErrorLevel = "debug" | "info" | "warn" | "error";
export type ErrorPropagation = "isolated" | "return-to-owner";
export type ErrorImpact = ProxyLifecycleImpact | "none";

/** 错误来源是封闭联合，不允许插件塞入任意字符串或 Error 对象。 */
export type ErrorOrigin =
  | {
      readonly source: "proxy/lifecycle";
      readonly operation: ProxyLifecycleOperation;
    }
  | {
      readonly source: "runtime/event-dispatch";
      readonly operation: "dispatch";
      readonly event: RuntimeEventName;
    };

/** ErrorPolicy 的集中决策；ownership 与传播方式不可由事件生产者伪造。 */
export interface ErrorHandling {
  readonly logOwner: ErrorLogOwner;
  readonly level: ErrorLevel;
  readonly propagation: ErrorPropagation;
}

/** 安全错误观察事实；不表示 runtime 已处理、记录或退出进程。 */
export interface ErrorObservedEvent {
  readonly sequence: number;
  readonly origin: ErrorOrigin;
  readonly handling: ErrorHandling;
  readonly impact: ErrorImpact;
  readonly error: NormalizedError;
}

/** 已由 dispatcher 重建并冻结的公开事件信封；不携带 Context 或原始异常引用。 */
interface RuntimeEventPayloadMap {
  [PROXY_LIFECYCLE_EVENT]: ProxyLifecycleEvent;
  [CONFIG_LOADED_EVENT]: ConfigLoadedEvent;
  [CONFIG_RELOADED_EVENT]: ConfigReloadedEvent;
  [CONFIG_FAILED_EVENT]: ConfigFailedEvent;
  [CONFIG_RESOURCE_EVENT]: ConfigResourceEvent;
  [PRESET_APPLIED_EVENT]: PresetSelectedEvent;
  [ERROR_OBSERVED_EVENT]: ErrorObservedEvent;
}

export type RuntimeEventPayload<K extends RuntimeEventName> = RuntimeEventPayloadMap[K];

/** 单个事件的只读信封；RuntimeEventEnvelope 是它的按事件名展开的联合。 */
export interface RuntimeEventEnvelopeFor<K extends RuntimeEventName> {
  readonly event: K;
  readonly sequence: number;
  readonly payload: RuntimeEventPayload<K>;
}

/** eventObserver 只能看到安全 DTO，不能通过闭包参数取得 runtime service。 */
export type RuntimeEventObserver = (envelope: RuntimeEventEnvelope) => void | Promise<void>;

export type RuntimeEventEnvelope =
  | RuntimeEventEnvelopeFor<typeof PROXY_LIFECYCLE_EVENT>
  | RuntimeEventEnvelopeFor<typeof CONFIG_LOADED_EVENT>
  | RuntimeEventEnvelopeFor<typeof CONFIG_RELOADED_EVENT>
  | RuntimeEventEnvelopeFor<typeof CONFIG_FAILED_EVENT>
  | RuntimeEventEnvelopeFor<typeof CONFIG_RESOURCE_EVENT>
  | RuntimeEventEnvelopeFor<typeof PRESET_APPLIED_EVENT>
  | RuntimeEventEnvelopeFor<typeof ERROR_OBSERVED_EVENT>;

export type StartupLifecycleEvent = Extract<
  ProxyLifecycleEvent,
  { readonly operation: "start"; readonly phase: "starting" | "running" }
>;

/** startupFacts 只保留启动关键事实；资源、reload、错误和停止噪声不会进入此类型。 */
export type StartupFact =
  | RuntimeEventEnvelopeFor<typeof CONFIG_LOADED_EVENT>
  | RuntimeEventEnvelopeFor<typeof PRESET_APPLIED_EVENT>
  | {
      readonly event: typeof PROXY_LIFECYCLE_EVENT;
      readonly sequence: number;
      readonly payload: StartupLifecycleEvent;
    };

declare module "cordis" {
  interface Events {
    "proxy/lifecycle": (event: ProxyLifecycleEvent) => void | Promise<void>;
    "config/loaded": (event: ConfigLoadedEvent) => void | Promise<void>;
    "config/reloaded": (event: ConfigReloadedEvent) => void | Promise<void>;
    "config/failed": (event: ConfigFailedEvent) => void | Promise<void>;
    "config/resource": (event: ConfigResourceEvent) => void | Promise<void>;
    "preset/applied": (event: PresetSelectedEvent) => void | Promise<void>;
    "error/observed": (event: ErrorObservedEvent) => void | Promise<void>;
  }
}
