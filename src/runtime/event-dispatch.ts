import type { Context, Events } from "cordis";
import {
  CONFIG_FAILED_EVENT,
  CONFIG_LOADED_EVENT,
  CONFIG_RELOADED_EVENT,
  CONFIG_RESOURCE_EVENT,
  ERROR_OBSERVED_EVENT,
  PRESET_APPLIED_EVENT,
  PROXY_LIFECYCLE_EVENT,
  type ConfigFailedEvent,
  type ConfigLoadedEvent,
  type ConfigReloadedEvent,
  type ConfigResourceEvent,
  type ErrorObservedEvent,
  type PresetSelectedEvent,
  type ProxyLifecycleEvent,
  type RuntimeEventEnvelope,
  type RuntimeEventEnvelopeFor,
  type RuntimeEventName,
} from "./events.js";

export const DEFAULT_EVENT_OBSERVATION_DEADLINE_MS = 1_000;

export type EventPayload<K extends RuntimeEventName> = Parameters<Events[K]>[0];

export type EventDispatchOutcome =
  "completed" | "listener-failed" | "deadline-exceeded" | "invalid-payload" | "inactive";

export type EventDispatchFailureReason = Exclude<EventDispatchOutcome, "completed" | "inactive">;

export interface EventDispatchFailure {
  readonly event: RuntimeEventName;
  readonly sequence: number;
  readonly reason: EventDispatchFailureReason;
  readonly failureCount: number;
}

export interface EventDispatchResult {
  readonly event: RuntimeEventName;
  readonly sequence: number;
  readonly outcome: EventDispatchOutcome;
  readonly failureCount: number;
}

export type EventDispatchFailureListener = (failure: EventDispatchFailure) => void | Promise<void>;

/** 已通过 dispatcher 安全重建的事件观察旁路；不会参与 ctx.parallel 的等待。 */
export type EventDispatchEventListener = (envelope: RuntimeEventEnvelope) => void | Promise<void>;

export type EventDispatchDisposer = () => void;

export interface EventDispatcherOptions {
  readonly deadlineMs?: number;
}

export interface EventDispatchOptions {
  readonly deadlineMs?: number;
}

type DispatchRaceOutcome =
  "completed" | "listener-failed" | "deadline-exceeded" | "cancelled" | "inactive";

interface PendingDeadline {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly cancel: () => void;
}

export interface EventDispatcher {
  readonly active: boolean;
  dispatch<K extends RuntimeEventName>(
    event: K,
    payload: EventPayload<K>,
    options?: EventDispatchOptions,
  ): Promise<EventDispatchResult>;
  /** 观察已校验/冻结的事件；listener 抛错或 rejection 不会使 dispatch 失败。 */
  onEvent(listener: EventDispatchEventListener): EventDispatchDisposer;
  onFailure(listener: EventDispatchFailureListener): EventDispatchDisposer;
  dispose(): void;
}

const FORBIDDEN_EVENT_KEY_FRAGMENTS = [
  "authorization",
  "cookie",
  "header",
  "credential",
  "password",
  "passwd",
  "secret",
  "token",
  "jwt",
  "apikey",
  "privatekey",
  "tlskey",
  "user",
  "account",
  "acl",
  "allowlist",
  "denylist",
  "whitelist",
  "blacklist",
  "cause",
  "stack",
  "fatal",
  "reported",
] as const;

function canonicalKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isForbiddenKey(key: string): boolean {
  const canonical = canonicalKey(key);
  return FORBIDDEN_EVENT_KEY_FRAGMENTS.some((fragment) => canonical.includes(fragment));
}

function readEventProperty(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

/**
 * 从白名单标量重新构建事件，而不是冻结调用方原对象。
 * 共享子对象会被复制；循环引用、类实例与非有限数字均拒绝发布。
 */
function rebuildEventValue(
  value: unknown,
  ancestors: WeakSet<object>,
  rebuilt: WeakMap<object, unknown>,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("event payload contains a non-finite number");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("event payload contains a non-scalar value");
  }
  if (ancestors.has(value)) {
    throw new TypeError("event payload contains a cycle");
  }

  const known = rebuilt.get(value);
  if (known !== undefined) {
    return known;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError("event payload contains an unsupported array");
      }
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        throw new TypeError("event payload contains a sparse or augmented array");
      }

      const copy: unknown[] = new Array<unknown>(value.length);
      rebuilt.set(value, copy);
      for (let index = 0; index < value.length; index += 1) {
        copy[index] = rebuildEventValue(value[index], ancestors, rebuilt);
      }
      return Object.freeze(copy);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("event payload contains a class instance");
    }

    const copy = Object.create(null) as Record<string, unknown>;
    rebuilt.set(value, copy);
    for (const key of Object.keys(value)) {
      if (isForbiddenKey(key)) {
        throw new TypeError("event payload contains a forbidden field");
      }
      copy[key] = rebuildEventValue(readEventProperty(value, key), ancestors, rebuilt);
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
}

function rebuildEventPayload<T>(payload: T): T {
  return rebuildEventValue(payload, new WeakSet<object>(), new WeakMap<object, unknown>()) as T;
}

const EVENT_PAYLOAD_KEYS: Readonly<Record<RuntimeEventName, readonly string[]>> = {
  [PROXY_LIFECYCLE_EVENT]: ["operation", "phase", "impact", "failure"],
  [CONFIG_LOADED_EVENT]: ["operation", "preset"],
  [CONFIG_RELOADED_EVENT]: ["scope", "changed", "preset"],
  [CONFIG_FAILED_EVENT]: ["operation", "error", "retained"],
  [CONFIG_RESOURCE_EVENT]: [
    "resource",
    "path",
    "transition",
    "outcome",
    "mtimeMs",
    "size",
    "error",
  ],
  [PRESET_APPLIED_EVENT]: ["name", "keys", "plugins"],
  [ERROR_OBSERVED_EVENT]: ["sequence", "origin", "handling", "impact", "error"],
};

const RUNTIME_EVENT_NAMES = [
  PROXY_LIFECYCLE_EVENT,
  CONFIG_LOADED_EVENT,
  CONFIG_RELOADED_EVENT,
  CONFIG_FAILED_EVENT,
  CONFIG_RESOURCE_EVENT,
  PRESET_APPLIED_EVENT,
  ERROR_OBSERVED_EVENT,
] as const satisfies readonly RuntimeEventName[];

const RESOURCE_TRANSITIONS = ["error", "missing", "recovered", "reloaded"] as const;
const RESOURCE_OUTCOMES = ["adopted", "retained", "fallback"] as const;
const ERROR_KINDS = [
  "config",
  "request",
  "upstream",
  "protocol",
  "subscriber",
  "process",
  "startup",
  "shutdown",
  "unknown",
] as const;
const ERROR_LOG_OWNERS = ["runtime", "cli", "proxy-server", "process-guards"] as const;
const ERROR_LEVELS = ["debug", "info", "warn", "error"] as const;
const ERROR_PROPAGATIONS = ["isolated", "return-to-owner"] as const;
const ERROR_IMPACTS = ["startup-aborted", "shutdown-incomplete", "none"] as const;

function asEventRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`${label} contains an unsupported field`);
    }
  }
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new TypeError(`${label}.${key} must be a string`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${label}.${key} must be a string`);
  }
  return value;
}

function requiredBoolean(record: Record<string, unknown>, key: string, label: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new TypeError(`${label}.${key} must be a boolean`);
  }
  return value;
}

function requiredFiniteNumber(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label}.${key} must be a finite number`);
  }
  return value;
}

function optionalFiniteNumber(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label}.${key} must be a finite number`);
  }
  return value;
}

function assertStringArray(record: Record<string, unknown>, key: string, label: string): void {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`${label}.${key} must be a string array`);
  }
}

function assertOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`${label} has an unsupported value`);
  }
}

function assertErrorSummary(value: unknown, label: string): void {
  const summary = asEventRecord(value, label);
  assertAllowedKeys(summary, ["name", "code", "message"], label);
  requiredString(summary, "name", label);
  requiredString(summary, "message", label);
  const code = summary.code;
  if (
    code !== undefined &&
    typeof code !== "string" &&
    !(typeof code === "number" && Number.isFinite(code))
  ) {
    throw new TypeError(`${label}.code must be a safe scalar`);
  }
}

function assertErrorOrigin(value: unknown, label: string): void {
  const origin = asEventRecord(value, label);
  const source = requiredString(origin, "source", label);
  if (source === "proxy/lifecycle") {
    assertAllowedKeys(origin, ["source", "operation"], label);
    assertOneOf(
      requiredString(origin, "operation", label),
      ["start", "stop"],
      `${label}.operation`,
    );
    return;
  }
  if (source === "runtime/event-dispatch") {
    assertAllowedKeys(origin, ["source", "operation", "event"], label);
    assertOneOf(requiredString(origin, "operation", label), ["dispatch"], `${label}.operation`);
    assertOneOf(requiredString(origin, "event", label), RUNTIME_EVENT_NAMES, `${label}.event`);
    return;
  }
  throw new TypeError(`${label}.source has an unsupported value`);
}

function assertErrorHandling(value: unknown, label: string): void {
  const handling = asEventRecord(value, label);
  assertAllowedKeys(handling, ["logOwner", "level", "propagation"], label);
  assertOneOf(requiredString(handling, "logOwner", label), ERROR_LOG_OWNERS, `${label}.logOwner`);
  assertOneOf(requiredString(handling, "level", label), ERROR_LEVELS, `${label}.level`);
  assertOneOf(
    requiredString(handling, "propagation", label),
    ERROR_PROPAGATIONS,
    `${label}.propagation`,
  );
}

function assertNormalizedError(value: unknown, label: string): void {
  const error = asEventRecord(value, label);
  assertAllowedKeys(
    error,
    ["kind", "name", "message", "code", "fields", "httpStatus", "target", "client", "operation"],
    label,
  );
  assertOneOf(requiredString(error, "kind", label), ERROR_KINDS, `${label}.kind`);
  requiredString(error, "name", label);
  requiredString(error, "message", label);
  const code = error.code;
  if (
    code !== undefined &&
    typeof code !== "string" &&
    !(typeof code === "number" && Number.isFinite(code))
  ) {
    throw new TypeError(`${label}.code must be a safe scalar`);
  }
  const fields = asEventRecord(error.fields, `${label}.fields`);
  for (const [key, field] of Object.entries(fields)) {
    if (
      key.length === 0 ||
      (typeof field !== "string" && typeof field !== "number" && typeof field !== "boolean")
    ) {
      throw new TypeError(`${label}.fields contains a non-scalar value`);
    }
  }
  optionalFiniteNumber(error, "httpStatus", label);
  optionalString(error, "target", label);
  optionalString(error, "client", label);
  optionalString(error, "operation", label);
}

function assertRuntimeEventShape(event: RuntimeEventName, payload: unknown): void {
  const record = asEventRecord(payload, `${event} payload`);
  assertAllowedKeys(record, EVENT_PAYLOAD_KEYS[event], `${event} payload`);

  switch (event) {
    case PROXY_LIFECYCLE_EVENT: {
      const operation = requiredString(record, "operation", "proxy/lifecycle");
      const phase = requiredString(record, "phase", "proxy/lifecycle");
      if (operation !== "start" && operation !== "stop") {
        throw new TypeError("proxy/lifecycle.operation has an unsupported value");
      }
      if (
        phase !== "starting" &&
        phase !== "running" &&
        phase !== "stopping" &&
        phase !== "stopped" &&
        phase !== "failed"
      ) {
        throw new TypeError("proxy/lifecycle.phase has an unsupported value");
      }
      if (
        (operation === "start" && (phase === "stopping" || phase === "stopped")) ||
        (operation === "stop" && (phase === "starting" || phase === "running"))
      ) {
        throw new TypeError("proxy/lifecycle phase does not match operation");
      }
      if (phase === "failed") {
        assertOneOf(
          requiredString(record, "impact", "proxy/lifecycle"),
          operation === "start" ? ["startup-aborted"] : ["shutdown-incomplete"],
          "proxy/lifecycle.impact",
        );
        assertErrorSummary(record.failure, "proxy/lifecycle.failure");
      } else if (record.impact !== undefined || record.failure !== undefined) {
        throw new TypeError("proxy/lifecycle success phase cannot contain failure fields");
      }
      return;
    }
    case CONFIG_LOADED_EVENT:
      if (requiredString(record, "operation", "config/loaded") !== "load") {
        throw new TypeError("config/loaded.operation has an unsupported value");
      }
      optionalString(record, "preset", "config/loaded");
      return;
    case CONFIG_RELOADED_EVENT:
      if (requiredString(record, "scope", "config/reloaded") !== "runtime") {
        throw new TypeError("config/reloaded.scope has an unsupported value");
      }
      assertStringArray(record, "changed", "config/reloaded");
      optionalString(record, "preset", "config/reloaded");
      return;
    case CONFIG_FAILED_EVENT: {
      const operation = requiredString(record, "operation", "config/failed");
      assertOneOf(operation, ["load", "reload"], "config/failed.operation");
      assertErrorSummary(record.error, "config/failed.error");
      requiredBoolean(record, "retained", "config/failed");
      return;
    }
    case CONFIG_RESOURCE_EVENT:
      assertOneOf(
        requiredString(record, "resource", "config/resource"),
        ["authUsers", "acl"],
        "config/resource.resource",
      );
      requiredString(record, "path", "config/resource");
      assertOneOf(
        requiredString(record, "transition", "config/resource"),
        RESOURCE_TRANSITIONS,
        "config/resource.transition",
      );
      assertOneOf(
        requiredString(record, "outcome", "config/resource"),
        RESOURCE_OUTCOMES,
        "config/resource.outcome",
      );
      optionalFiniteNumber(record, "mtimeMs", "config/resource");
      optionalFiniteNumber(record, "size", "config/resource");
      optionalString(record, "error", "config/resource");
      return;
    case PRESET_APPLIED_EVENT:
      requiredString(record, "name", "preset/applied");
      assertStringArray(record, "keys", "preset/applied");
      assertStringArray(record, "plugins", "preset/applied");
      return;
    case ERROR_OBSERVED_EVENT:
      requiredFiniteNumber(record, "sequence", "error/observed");
      assertErrorOrigin(record.origin, "error/observed.origin");
      assertErrorHandling(record.handling, "error/observed.handling");
      assertOneOf(
        requiredString(record, "impact", "error/observed"),
        ERROR_IMPACTS,
        "error/observed.impact",
      );
      assertNormalizedError(record.error, "error/observed.error");
      return;
  }
}

function normalizedDeadline(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.trunc(value))
    : DEFAULT_EVENT_OBSERVATION_DEADLINE_MS;
}

function rejectionCount(error: unknown): number {
  try {
    if (error instanceof AggregateError) {
      return Math.max(1, error.errors.length);
    }
  } catch {
    return 1;
  }
  return 1;
}

function nextSequence(previous: number): number {
  return previous >= Number.MAX_SAFE_INTEGER ? 1 : previous + 1;
}

function result(
  event: RuntimeEventName,
  sequence: number,
  outcome: EventDispatchOutcome,
  failureCount = 0,
): EventDispatchResult {
  return Object.freeze({ event, sequence, outcome, failureCount });
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

/** Cordis 的 parallel 重载无法保留 K 与 payload 的关联；按白名单显式收窄。 */
function publishRuntimeEvent<K extends RuntimeEventName>(
  ctx: Context,
  event: K,
  payload: EventPayload<K>,
): Promise<void> {
  switch (event) {
    case PROXY_LIFECYCLE_EVENT:
      return ctx.parallel(PROXY_LIFECYCLE_EVENT, payload as ProxyLifecycleEvent);
    case CONFIG_LOADED_EVENT:
      return ctx.parallel(CONFIG_LOADED_EVENT, payload as ConfigLoadedEvent);
    case CONFIG_RELOADED_EVENT:
      return ctx.parallel(CONFIG_RELOADED_EVENT, payload as ConfigReloadedEvent);
    case CONFIG_FAILED_EVENT:
      return ctx.parallel(CONFIG_FAILED_EVENT, payload as ConfigFailedEvent);
    case CONFIG_RESOURCE_EVENT:
      return ctx.parallel(CONFIG_RESOURCE_EVENT, payload as ConfigResourceEvent);
    case PRESET_APPLIED_EVENT:
      return ctx.parallel(PRESET_APPLIED_EVENT, payload as PresetSelectedEvent);
    case ERROR_OBSERVED_EVENT:
      return ctx.parallel(ERROR_OBSERVED_EVENT, payload as ErrorObservedEvent);
  }
}

/**
 * 安全事件 dispatcher。
 *
 * - `ctx.parallel` 仍负责并行调用，但同步异常与异步 rejection 统一折叠为结果；
 * - deadline 到期后调用方继续，迟到的 rejection 仍被已安装的 handler 消费；
 * - payload 在发布前重建并冻结，监听器无法互相修改或夹带对象引用；
 * - `error/observed` 的失败仍会通知 failure observer，但上层禁止再次发布观察事件。
 */
export function createEventDispatcher(
  ctx: Context,
  options: EventDispatcherOptions = {},
): EventDispatcher {
  const defaultDeadlineMs = normalizedDeadline(options.deadlineMs);
  const eventListeners = new Set<EventDispatchEventListener>();
  const failureListeners = new Set<EventDispatchFailureListener>();
  const pendingDeadlines = new Set<PendingDeadline>();
  let active = true;
  let sequence = 0;

  function consumeAsyncListener(value: void | Promise<void>): void {
    if (!isPromiseLike(value)) {
      return;
    }
    try {
      void Promise.resolve(value).catch(() => {
        // 观察旁路的异步失败不能制造 unhandled rejection 或递归观察事件。
      });
    } catch {
      // 防御病态 thenable；同步异常同样不能影响已发布事实。
    }
  }

  function notifyEvent(envelope: RuntimeEventEnvelope): void {
    if (!active) {
      return;
    }
    for (const listener of [...eventListeners]) {
      if (!active) {
        return;
      }
      try {
        consumeAsyncListener(listener(envelope));
      } catch {
        // 外部 observer 旁路失败不能改变 dispatcher 或业务操作的结果。
      }
    }
  }

  function notifyFailure(failure: EventDispatchFailure): void {
    if (!active) {
      return;
    }
    for (const listener of [...failureListeners]) {
      if (!active) {
        return;
      }
      try {
        consumeAsyncListener(listener(failure));
      } catch {
        // failure observer 自身失败不能改变已完成/已超时的业务操作。
      }
    }
  }

  async function dispatch<K extends RuntimeEventName>(
    event: K,
    payload: EventPayload<K>,
    dispatchOptions: EventDispatchOptions = {},
  ): Promise<EventDispatchResult> {
    const currentSequence = nextSequence(sequence);
    sequence = currentSequence;
    if (!active) {
      return result(event, currentSequence, "inactive");
    }

    let safePayload: EventPayload<K>;
    try {
      safePayload = rebuildEventPayload(payload);
      assertRuntimeEventShape(event, safePayload);
    } catch {
      const invalid = Object.freeze({
        event,
        sequence: currentSequence,
        reason: "invalid-payload" as const,
        failureCount: 1,
      });
      notifyFailure(invalid);
      return result(event, currentSequence, "invalid-payload", 1);
    }

    const deadlineMs = normalizedDeadline(dispatchOptions.deadlineMs ?? defaultDeadlineMs);
    if (!active) {
      return result(event, currentSequence, "inactive");
    }

    // 事件已经过 rebuild + freeze；journal/外部 observer 从此只能看到安全副本。
    // 这里刻意不等待 listener，避免 startup observer 阻塞 startRuntime 返回。
    const envelope = Object.freeze({
      event,
      sequence: currentSequence,
      payload: safePayload,
    }) as RuntimeEventEnvelopeFor<K>;
    notifyEvent(envelope as RuntimeEventEnvelope);
    if (!active) {
      return result(event, currentSequence, "inactive");
    }

    let rejectionTotal = 0;
    const observed: Promise<"completed" | "listener-failed" | "inactive"> = (async (): Promise<
      "completed" | "listener-failed" | "inactive"
    > => {
      if (!active) {
        return "inactive";
      }
      try {
        await publishRuntimeEvent(ctx, event, safePayload);
        return "completed";
      } catch (error: unknown) {
        rejectionTotal = rejectionCount(error);
        return "listener-failed";
      }
    })();

    let deadline: PendingDeadline | undefined;
    const timeout = new Promise<"deadline-exceeded" | "cancelled">((resolve) => {
      const finish = (outcome: "deadline-exceeded" | "cancelled"): void => {
        if (deadline === undefined) {
          return;
        }
        pendingDeadlines.delete(deadline);
        deadline = undefined;
        resolve(outcome);
      };
      const timer = setTimeout(() => finish("deadline-exceeded"), deadlineMs);
      deadline = {
        timer,
        cancel: () => {
          clearTimeout(timer);
          finish("cancelled");
        },
      };
      pendingDeadlines.add(deadline);
    });
    const outcome: DispatchRaceOutcome = await Promise.race([observed, timeout]);
    if (deadline !== undefined) {
      pendingDeadlines.delete(deadline);
      clearTimeout(deadline.timer);
      deadline = undefined;
    }

    if (!active || outcome === "cancelled" || outcome === "inactive") {
      return result(event, currentSequence, "inactive");
    }
    if (outcome === "completed") {
      return result(event, currentSequence, outcome);
    }
    if (outcome === "deadline-exceeded") {
      const failure = Object.freeze({
        event,
        sequence: currentSequence,
        reason: outcome,
        failureCount: 1,
      });
      notifyFailure(failure);
      return result(event, currentSequence, outcome, 1);
    }

    const failure = Object.freeze({
      event,
      sequence: currentSequence,
      reason: outcome,
      failureCount: rejectionTotal,
    });
    notifyFailure(failure);
    return result(event, currentSequence, outcome, rejectionTotal);
  }

  return {
    get active(): boolean {
      return active;
    },
    dispatch,
    onEvent(listener: EventDispatchEventListener): EventDispatchDisposer {
      if (!active) {
        return () => {
          // inactive dispatcher 的 event observer disposer 仍保持幂等
        };
      }
      eventListeners.add(listener);
      let listenerActive = true;
      return () => {
        if (!listenerActive) {
          return;
        }
        listenerActive = false;
        eventListeners.delete(listener);
      };
    },
    onFailure(listener: EventDispatchFailureListener): EventDispatchDisposer {
      if (!active) {
        return () => {
          // inactive dispatcher 的 disposer 仍保持幂等
        };
      }
      failureListeners.add(listener);
      let listenerActive = true;
      return () => {
        if (!listenerActive) {
          return;
        }
        listenerActive = false;
        failureListeners.delete(listener);
      };
    },
    dispose(): void {
      if (!active) {
        return;
      }
      active = false;
      eventListeners.clear();
      failureListeners.clear();
      for (const pending of [...pendingDeadlines]) {
        pending.cancel();
      }
      pendingDeadlines.clear();
    },
  };
}
