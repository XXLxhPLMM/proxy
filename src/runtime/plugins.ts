import type { Context, Plugin } from "cordis";
import type { EventDispatcher } from "./event-dispatch.js";
import type { ErrorService, ErrorSummary } from "./error-service.js";
import {
  PROXY_LIFECYCLE_EVENT,
  type ProxyLifecycleEvent,
  type ProxyLifecycleImpact,
  type ProxyLifecycleOperation,
} from "./events.js";
import type { ProxyService } from "./proxy-service.js";
import type { ProxyLifecycleErrorCode } from "@/core/types/proxy.js";

const DEFAULT_SERVICE_OPERATION_DEADLINE_MS = 15_000;

class ProxyServiceOperationTimeoutError extends Error {
  readonly code = "ERR_PROXY_SERVICE_OPERATION_TIMEOUT" satisfies ProxyLifecycleErrorCode;

  constructor(operation: ProxyLifecycleOperation, deadlineMs: number) {
    super(`Proxy service ${operation} timed out after ${deadlineMs}ms`);
    this.name = "ProxyServiceOperationTimeoutError";
  }
}

function normalizeServiceOperationDeadlineMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.trunc(value))
    : DEFAULT_SERVICE_OPERATION_DEADLINE_MS;
}

/**
 * 每次服务调用使用独立 deadline。超时只拒绝等待方；底层 Promise 永久保留 rejection
 * handler，迟到的 rejection 不会变成 unhandledRejection，迟到 fulfill 也不会发布成功事实。
 */
function runBoundedServiceOperation(
  operation: () => Promise<void>,
  operationName: ProxyLifecycleOperation,
  deadlineMs: number,
): Promise<void> {
  const operationPromise = Promise.resolve().then(operation);
  void operationPromise.then(undefined, () => {
    // race 可能已经超时；这里仍永久消费底层操作的迟到 rejection。
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ProxyServiceOperationTimeoutError(operationName, deadlineMs));
    }, deadlineMs);
  });

  return Promise.race([operationPromise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

function createFailureSummary(
  service: ErrorService,
  error: unknown,
  operation: ProxyLifecycleOperation,
): ErrorSummary {
  try {
    const normalized = service.normalize(error, {
      kind: operation === "start" ? "startup" : "shutdown",
      operation,
    });
    return Object.freeze({
      name: normalized.name,
      message: normalized.message,
      ...(normalized.code === undefined ? {} : { code: normalized.code }),
    });
  } catch {
    // 自定义 ErrorService 也不能盖住 lifecycle 原始错误；事件退化为固定安全摘要。
    return Object.freeze({
      name: "Error",
      message: operation === "start" ? "Proxy start failed" : "Proxy stop failed",
    });
  }
}

function lifecycleImpact(operation: ProxyLifecycleOperation): ProxyLifecycleImpact {
  return operation === "start" ? "startup-aborted" : "shutdown-incomplete";
}

function freezeLifecycleEvent(event: ProxyLifecycleEvent): ProxyLifecycleEvent {
  if (event.phase === "failed") {
    Object.freeze(event.failure);
  }
  return Object.freeze(event);
}

/** 发布有界生命周期事实；观察者故障不得改变业务操作的原始结果。 */
async function emitLifecycle(
  dispatcher: EventDispatcher,
  event: ProxyLifecycleEvent,
): Promise<void> {
  try {
    await dispatcher.dispatch(PROXY_LIFECYCLE_EVENT, freezeLifecycleEvent(event));
  } catch {
    // dispatcher 契约本身不拒绝；这层只防御第三方替换实现破坏生命周期。
  }
}

async function startService(
  dispatcher: EventDispatcher,
  errors: ErrorService,
  service: ProxyService,
  operationDeadlineMs: number,
): Promise<void> {
  await emitLifecycle(dispatcher, { operation: "start", phase: "starting" });
  try {
    await runBoundedServiceOperation(() => service.start(), "start", operationDeadlineMs);
  } catch (error) {
    await emitLifecycle(dispatcher, {
      operation: "start",
      phase: "failed",
      impact: lifecycleImpact("start"),
      failure: createFailureSummary(errors, error, "start"),
    });
    throw error;
  }
  await emitLifecycle(dispatcher, { operation: "start", phase: "running" });
}

async function stopService(
  dispatcher: EventDispatcher,
  errors: ErrorService,
  service: ProxyService,
  operationDeadlineMs: number,
): Promise<void> {
  await emitLifecycle(dispatcher, { operation: "stop", phase: "stopping" });
  try {
    await runBoundedServiceOperation(() => service.stop(), "stop", operationDeadlineMs);
  } catch (error) {
    await emitLifecycle(dispatcher, {
      operation: "stop",
      phase: "failed",
      impact: lifecycleImpact("stop"),
      failure: createFailureSummary(errors, error, "stop"),
    });
    throw error;
  }
  await emitLifecycle(dispatcher, { operation: "stop", phase: "stopped" });
}

/** 服务 provider object plugin。 */
export function createProxyServicePlugin(service: ProxyService): Plugin.Object<void> {
  return {
    name: "proxy-service",
    apply(ctx: Context) {
      ctx.provide("proxy", service);
    },
  };
}

/**
 * 生命周期 object plugin。
 * effect disposer 等待 stop 完成但向 Cordis 返回 fulfilled promise；原始错误由
 * tracker 显式保存，避免 rc.10 `_unload()` 吞错后只写内部 logger。
 */
export function createProxyLifecyclePlugin(
  errors: ErrorService,
  dispatcher: EventDispatcher,
  onDisposalError: (error: unknown) => void,
  serviceOperationDeadlineMs?: number,
): Plugin.Object<void> {
  const operationDeadlineMs = normalizeServiceOperationDeadlineMs(serviceOperationDeadlineMs);
  return {
    name: "proxy-lifecycle",
    inject: ["proxy"],
    async apply(ctx: Context) {
      const service = ctx.get("proxy");
      if (service === undefined) {
        throw new Error("proxy service is not available");
      }

      let stopPromise: Promise<void> | undefined;
      ctx.effect(() => {
        return () => {
          stopPromise ??= stopService(dispatcher, errors, service, operationDeadlineMs);
          return stopPromise.then(
            () => undefined,
            (error: unknown) => {
              try {
                onDisposalError(error);
              } catch {
                // tracker 自身异常也不能让 Cordis 越过显式错误传播边界。
              }
            },
          );
        };
      }, "proxy lifecycle");
      await startService(dispatcher, errors, service, operationDeadlineMs);
    },
  };
}
