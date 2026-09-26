import { logger } from "@/utils/log/logger.js";

type ProcessGuardHandlers = {
  onUncaughtException: (error: Error) => void;
  onUnhandledRejection: (reason: unknown) => void;
  onWarning: (warning: Error) => void;
};

/**
 * 同一进程只保留一组物理 listener；这里只数活跃 lease 份数。
 *
 * 刻意用计数器而不是按 label 分桶的 Map：曾经有个 `label` 形参用于区分
 * server/client 场景并改变日志前缀，但唯一调用方 `ProxyServer.start()` 从不传它，
 * 于是 `currentLabel()` 恒返回 undefined、`prefixFor()` 恒返回 `"["`——整条 label
 * 链是不可达分支。等真有第二种角色时再加回，不要预留。
 */
let activeLeaseCount = 0;
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

function installProcessGuards(): void {
  const handlers: ProcessGuardHandlers = {
    onUncaughtException: (error) => {
      logger.error("[uncaughtException] 代理进程捕获未处理异常，继续运行:", error);
    },
    onUnhandledRejection: (reason) => {
      logger.error("[unhandledRejection] 代理进程捕获未处理拒绝，继续运行:", reason);
    },
    onWarning: (warning) => {
      logger.warn("[warning]", warning.name, warning.message);
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
 * @returns 释放本调用方 lease 的幂等 disposer
 */
export function setupProcessGuards(): () => void {
  // 上一次最终 lease 清理失败时，先重试移除旧物理 listener，不能直接叠加新组。
  if (pendingRemoval && activeLeaseCount === 0) {
    const cleanupErrors = removeInstalledHandlers("pending lease retry");
    if (cleanupErrors.length > 0) {
      throw listenerCleanupError(cleanupErrors);
    }
  }
  if (!installedHandlers) {
    installProcessGuards();
  }
  pendingRemoval = false;
  activeLeaseCount += 1;

  let released = false;
  let cleanupPending = false;
  return () => {
    if (released) {
      return;
    }

    const handlers = installedHandlers;
    if (cleanupPending) {
      // 新 lease 已接管旧 handler 时，旧 disposer 只完成自身幂等收口。
      if (activeLeaseCount > 0 || !handlers || installedHandlers !== handlers) {
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

    if (activeLeaseCount === 0) {
      // 别人的 disposer 已经把最后一个 lease 收掉了。
      released = true;
      return;
    }
    if (activeLeaseCount > 1) {
      activeLeaseCount -= 1;
      return;
    }

    activeLeaseCount = 0;
    if (!handlers) {
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
