import type { Context, Plugin } from "cordis";
import type { EventDispatchFailure, EventDispatcher } from "./event-dispatch.js";
import type { ErrorService, NormalizedError } from "./error-service.js";
import {
  ERROR_OBSERVED_EVENT,
  PROXY_LIFECYCLE_EVENT,
  type ErrorHandling,
  type ErrorImpact,
  type ErrorObservedEvent,
  type ErrorOrigin,
  type ProxyLifecycleEvent,
} from "./events.js";

function decideHandling(origin: ErrorOrigin, failure?: EventDispatchFailure): ErrorHandling {
  if (origin.source === "proxy/lifecycle") {
    return Object.freeze({
      logOwner: origin.operation === "start" ? "cli" : "proxy-server",
      level: "error" as const,
      propagation: "return-to-owner" as const,
    });
  }

  return Object.freeze({
    logOwner: "runtime" as const,
    level: failure?.reason === "deadline-exceeded" ? ("warn" as const) : ("error" as const),
    propagation: "isolated" as const,
  });
}

function lifecycleOrigin(event: Extract<ProxyLifecycleEvent, { phase: "failed" }>): ErrorOrigin {
  return Object.freeze({
    source: "proxy/lifecycle" as const,
    operation: event.operation,
  });
}

function dispatchOrigin(failure: EventDispatchFailure): ErrorOrigin {
  return Object.freeze({
    source: "runtime/event-dispatch" as const,
    operation: "dispatch" as const,
    event: failure.event,
  });
}

function createObservedEvent(
  error: NormalizedError,
  origin: ErrorOrigin,
  impact: ErrorImpact,
  sequence: number,
  failure?: EventDispatchFailure,
): ErrorObservedEvent {
  return Object.freeze({
    sequence,
    origin,
    handling: decideHandling(origin, failure),
    impact,
    error,
  });
}

function publishSafely(dispatcher: EventDispatcher, event: ErrorObservedEvent): void {
  try {
    void dispatcher.dispatch(ERROR_OBSERVED_EVENT, event).catch(() => {
      // 防御第三方 dispatcher 违反非拒绝契约；绝不递归发布 error/observed。
    });
  } catch {
    // 防御第三方 dispatcher 同步抛错；绝不递归发布 error/observed。
  }
}

/**
 * 错误策略只观察 runtime 控制面事实并集中决定 ownership/level/propagation。
 * 它不记录原始 source error，不调用 process.exit，也不接管 process guards。
 */
export function createErrorPolicyPlugin(
  service: ErrorService,
  dispatcher: EventDispatcher,
): Plugin.Object<void> {
  return {
    name: "error-policy",
    apply(ctx: Context) {
      let sequence = 0;

      const observe = (error: NormalizedError, origin: ErrorOrigin, impact: ErrorImpact): void => {
        sequence = sequence >= Number.MAX_SAFE_INTEGER ? 1 : sequence + 1;
        publishSafely(dispatcher, createObservedEvent(error, origin, impact, sequence));
      };

      ctx.on(PROXY_LIFECYCLE_EVENT, (event) => {
        if (event.phase !== "failed") {
          return;
        }
        const origin = lifecycleOrigin(event);
        const error = service.normalize(event.failure, {
          kind: event.operation === "start" ? "startup" : "shutdown",
          operation: event.operation,
          fields: { impact: event.impact },
        });
        observe(error, origin, event.impact);
      });

      const disposeFailureObserver = dispatcher.onFailure((failure) => {
        // error/observed 自身失败只向 failure observer 暴露，绝不再次发布观察事件。
        if (failure.event === ERROR_OBSERVED_EVENT) {
          return;
        }
        const origin = dispatchOrigin(failure);
        const error = service.normalize("Runtime event observation failed", {
          kind: "subscriber",
          operation: "dispatch",
          fields: { event: failure.event, reason: failure.reason },
        });
        observe(error, origin, "none");
      });
      ctx.effect(() => disposeFailureObserver, "error policy failure observer");
    },
  };
}

