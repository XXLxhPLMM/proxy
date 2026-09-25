import type { LifecycleState, ProxyProtocol } from "@/core/types/proxy.js";
import type { ConfigKey } from "@/config/store.js";

/** 事件关联上下文：runtime 必填，connection/request 作用域可选 */
export interface EventContext {
  runtimeId: string;
  connectionId?: string;
  requestId?: string;
  protocol?: ProxyProtocol;
  client?: string;
  user?: string;
  target?: string;
}

/** 从事件参数元组取出的实际 payload 类型；无参数事件为 undefined。 */
export type EventData<K extends keyof AppEventMap> = AppEventMap[K] extends [data: infer Data]
  ? Data
  : undefined;

/** 事件信封：事件名、关联上下文、事实数据和发布时间。 */
export interface EventEnvelope<K extends keyof AppEventMap = keyof AppEventMap> {
  readonly name: K;
  readonly context: EventContext;
  readonly data: EventData<K>;
  readonly timestamp: number;
}

export type EventListener<K extends keyof AppEventMap> = (e: EventEnvelope<K>) => void;

/** 事件名联合 */
export type EventName = keyof AppEventMap;

export interface AppEventMap {
  "runtime.starting": [data: { host: string; port: number; protocol: ProxyProtocol }];
  "runtime.started": [data: { host: string; port: number; protocol: ProxyProtocol }];
  "runtime.stopping": [];
  "runtime.stopped": [];
  "runtime.error": [data: { error: unknown }];
  "lifecycle.changed": [data: { next: LifecycleState; prev: LifecycleState }];
  "config.loaded": [data: { source: string }];
  "config.changed": [data: { keys: ConfigKey[] }];
  "config.restart-required": [data: { keys: ConfigKey[] }];
  "config.file-error": [data: { path: string; error: unknown }];
  "config.file-recovered": [data: { path: string }];
  "auth.decided": [data: { passed: boolean; user?: string; attempted?: string; reason?: string }];
  "access.client-denied": [data: { client: string; reason: AclReason }];
  "access.target-denied": [data: { host: string; target: string; reason: AclReason }];
  "route.selected": [
    data: { mode: "server" | "client"; route: "direct" | "upstream"; reason?: string },
  ];
  "request.completed": [data: { status?: number }];
  "request.rejected": [data: { stage: RequestStage; status?: number; reason?: string }];
  "request.failed": [data: { stage: RequestStage; error: unknown }];
}

export type AclReason = "whitelist" | "blacklist";
export type RequestStage = "parse" | "auth" | "access" | "route" | "dial" | "forward" | "stream";
