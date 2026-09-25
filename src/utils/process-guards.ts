import { logger } from "./logger.js";

type ProcessGuardHandlers = {
  onUncaughtException: (error: Error) => void;
  onUnhandledRejection: (reason: unknown) => void;
  onWarning: (warning: Error) => void;
};

/** 同一进程只保留一组物理 listener；label 仅作为当前 lease 的日志前缀。 */
const activeLabels = new Map<string, number>();
let installedHandlers: ProcessGuardHandlers | null = null;

function aggregateListenerErrors(errors: unknown[]): unknown {
  return errors.length === 1
    ? errors[0]
    : new AggregateError(errors, "multiple listener cleanup failures");
}

function listenerCleanupError(errors: unknown[]): Error {
  const normalized = errors.map((error) =>
    error instanceof Error ? error : new Error(`listener cleanup failed: ${String(error)}`),
  );
  return normalized.length === 1
    ? normalized[0]
    : new AggregateError(normalized, "multiple listener cleanup failures");
}

function reportListenerCleanupErrors(scope: string, errors: unknown[]): void {
  if (errors.length === 0) {
    return;
  }
  try {
    logger.error(`[process-guards] ${scope} failed:`, aggregateListenerErrors(errors));
  } catch {
    // logger 契约是永不抛；真正错误仍由 disposer 抛出给资源所有者。
  }
}

/** 每个 disposer 独立执行，后一个不会因前一个抛错而被跳过。 */
function runListenerDisposers(disposers: Array<() => void>): unknown[] {
  const errors: unknown[] = [];
  for (const dispose of disposers) {
    try {
      dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

let pendingRemoval = false;

function removeInstalledHandlers(scope: string): unknown[] {
  const handlers = installedHandlers;
  if (!handlers) {
    pendingRemoval = false;
    return [];
  }
  const errors = runListenerDisposers([
    () => process.removeListener("uncaughtException", handlers.onUncaughtException),
    () => process.removeListener("unhandledRejection", handlers.onUnhandledRejection),
    () => process.removeListener("warning", handlers.onWarning),
  ]);
  reportListenerCleanupErrors(scope, errors);
  if (errors.length === 0) {
    installedHandlers = null;
    pendingRemoval = false;
  } else {
    pendingRemoval = true;
  }
  return errors;
}

function currentLabel(): string | undefined {
  for (const label of activeLabels.keys()) {
    return label || undefined;
  }
  return undefined;
}

function prefixFor(label: string | undefined): string {
  return label ? `[${label} ` : "[";
}

function installProcessGuards(): void {
  const handlers: ProcessGuardHandlers = {
    onUncaughtException: (error) => {
      const label = currentLabel();
      logger.error(
        `${prefixFor(label)}uncaughtException] ${label ? "" : "代理进程"}捕获未处理异常，继续运行:`,
        error,
      );
    },
    onUnhandledRejection: (reason) => {
      const label = currentLabel();
      logger.error(
        `${prefixFor(label)}unhandledRejection] ${label ? "" : "代理进程"}捕获未处理拒绝，继续运行:`,
        reason,
      );
    },
    onWarning: (warning) => {
      const label = currentLabel();
      logger.warn(`${prefixFor(label)}warning]`, warning.name, warning.message);
    },
  };

  try {
    process.on("uncaughtException", handlers.onUncaughtException);
    process.on("unhandledRejection", handlers.onUnhandledRejection);
    process.on("warning", handlers.onWarning);
    installedHandlers = handlers;
  } catch (error) {
    // 安装中途失败时逐项回滚；即使某个 removeListener 抛错，也继续尝试剩余 listener。
    const cleanupErrors = runListenerDisposers([
      () => process.removeListener("uncaughtException", handlers.onUncaughtException),
      () => process.removeListener("unhandledRejection", handlers.onUnhandledRejection),
      () => process.removeListener("warning", handlers.onWarning),
    ]);
    reportListenerCleanupErrors("install rollback", cleanupErrors);
    throw error;
  }
}

/**
 * 进程级容错：捕获未处理异常/rejection/warning，仅日志不退出（保活优先于 fail-fast，长连接代理忌因单请求崩全服）
 *
 * 返回一个幂等 disposer。多个调用方各自持有 lease，最后一个 lease 释放时才移除宿主
 * process listener；因此重复 start 不会重复注册，RuntimeHandle.stop() 也不会留下 handler。
 * `uncaughtException` 已由这里记录，不再另加 `uncaughtExceptionMonitor`。
 *
 * @param label 日志前缀，用于区分 server/client 场景，如 "client"
 * @returns 释放本调用方 lease 的幂等 disposer
 */
export function setupProcessGuards(label?: string): () => void {
  const key = label ?? "";

  // 上一次最终 lease 清理失败时，先重试移除旧物理 listener，不能直接叠加新组。
  if (pendingRemoval && activeLabels.size === 0) {
    const cleanupErrors = removeInstalledHandlers("pending lease retry");
    if (cleanupErrors.length > 0) {
      throw listenerCleanupError(cleanupErrors);
    }
  }
  if (!installedHandlers) {
    installProcessGuards();
  }
  pendingRemoval = false;
  activeLabels.set(key, (activeLabels.get(key) ?? 0) + 1);

  let released = false;
  let cleanupPending = false;
  return () => {
    if (released) {
      return;
    }

    const handlers = installedHandlers;
    if (cleanupPending) {
      // 新 lease 已接管旧 handler 时，旧 disposer 只完成自身幂等收口。
      if (activeLabels.size > 0 || !handlers || installedHandlers !== handlers) {
        released = true;
        return;
      }
      const retryErrors = removeInstalledHandlers("lease release retry");
      if (retryErrors.length > 0) {
        throw listenerCleanupError(retryErrors);
      }
      released = true;
      return;
    }

    const count = activeLabels.get(key);
    if (count === undefined) {
      released = true;
      return;
    }
    if (count > 1) {
      activeLabels.set(key, count - 1);
      return;
    }

    activeLabels.delete(key);
    if (activeLabels.size > 0 || !handlers) {
      released = true;
      return;
    }

    const cleanupErrors = removeInstalledHandlers("lease release");
    if (cleanupErrors.length > 0) {
      cleanupPending = true;
      throw listenerCleanupError(cleanupErrors);
    }
    released = true;
  };
}
