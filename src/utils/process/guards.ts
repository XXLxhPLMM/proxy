/**
 * 进程级容错守卫（lease 状态机）
 *
 * **日志出口由调用方注入**：物理 listener 是**全进程唯一一组**，此前它直接
 * import 模块级 `logger` 单例——那份单例已删（`utils/log/logger.ts` 现在只有
 * `createInstanceLogger` 与进程级门面 `getLogger`），且即便换成 `getLogger()` 也不对：
 * guard 记的是「本进程某处崩了」，用进程级 scope 兜底会让同进程多实例时，A 实例
 * 的未捕获异常按 B 实例（或进程级）的 `LOG_LEVEL`/`LOG_FILE` 落盘。
 * 因此这里显式收 `Logger`：装 listener 的那个 lease 用**自己的实例日志器**，
 * 物理 listener 随该 logger 一起记，多实例互相不串。
 *
 * 刻意**不用** `getLogger()`/`setProcessScope()` 那套进程级门面：那是给「天然属于
 * 进程而非某个实例」的日志用的，而 uncaughtException/未处理拒绝在多实例库里恰恰
 * 说不清归属（宿主进程自己的 bug 也会落到这里）。留出 logger 形参即调用方的选择。
 */

import type { Logger } from "@/utils/log/logger.js";

type ProcessGuardHandlers = {
  onUncaughtException: (error: Error) => void;
  onUnhandledRejection: (reason: unknown) => void;
  onWarning: (warning: Error) => void;
};

/** 已安装的物理 listener 组 + 它们的打印出口 */
type InstalledGuards = {
  handlers: ProcessGuardHandlers;
  /**
   * 该组物理 listener 的打印出口 = **装上它的那次 lease** 的实例日志器。
   * 同一进程只装一组，因此多实例并发时后到的 lease 复用先到者的出口（不覆盖）：
   * 覆盖会让「A 实例的 crash」在 A 自己的日志文件里查无此事。
   */
  log: Logger;
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
let installed: InstalledGuards | null = null;

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

function reportListenerCleanupErrors(log: Logger, scope: string, errors: unknown[]): void {
  if (errors.length === 0) {
    return;
  }
  try {
    log.error(`[process-guards] ${scope} failed:`, aggregateListenerErrors(errors));
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

/** 移除当前那组物理 listener；用组自己的 logger 记录逐项清理失败。 */
function removeInstalledHandlers(scope: string): unknown[] {
  const current = installed;
  if (!current) {
    pendingRemoval = false;
    return [];
  }
  const { handlers, log } = current;
  const errors = runListenerDisposers([
    () => process.removeListener("uncaughtException", handlers.onUncaughtException),
    () => process.removeListener("unhandledRejection", handlers.onUnhandledRejection),
    () => process.removeListener("warning", handlers.onWarning),
  ]);
  reportListenerCleanupErrors(log, scope, errors);
  if (errors.length === 0) {
    installed = null;
    pendingRemoval = false;
  } else {
    pendingRemoval = true;
  }
  return errors;
}

/** 安装唯一一组物理 listener；打印出口锁定为本次 lease 的实例日志器。 */
function installProcessGuards(log: Logger): void {
  const handlers: ProcessGuardHandlers = {
    onUncaughtException: (error) => {
      log.error("[uncaughtException] 代理进程捕获未处理异常，继续运行:", error);
    },
    onUnhandledRejection: (reason) => {
      log.error("[unhandledRejection] 代理进程捕获未处理拒绝，继续运行:", reason);
    },
    onWarning: (warning) => {
      log.warn("[warning]", warning.name, warning.message);
    },
  };

  try {
    process.on("uncaughtException", handlers.onUncaughtException);
    process.on("unhandledRejection", handlers.onUnhandledRejection);
    process.on("warning", handlers.onWarning);
    installed = { handlers, log };
  } catch (error) {
    // 安装中途失败时逐项回滚；即使某个 removeListener 抛错，也继续尝试剩余 listener。
    const cleanupErrors = runListenerDisposers([
      () => process.removeListener("uncaughtException", handlers.onUncaughtException),
      () => process.removeListener("unhandledRejection", handlers.onUnhandledRejection),
      () => process.removeListener("warning", handlers.onWarning),
    ]);
    reportListenerCleanupErrors(log, "install rollback", cleanupErrors);
    throw error;
  }
}

/**
 * 进程级容错：捕获未处理异常/rejection/warning，仅日志不退出（保活优先于 fail-fast，长连接代理忌因单请求崩全服）
 *
 * 返回一个幂等 disposer。多个调用方各自持有 lease，最后一个 lease 释放时才移除宿主
 * process listener；因此重复 start 不会重复注册，`ProxyInstance.stop()`（经
 * `ProxyServer.stop()` 归还 lease）也不会留下 handler。
 * `uncaughtException` 已由这里记录，不再另加 `uncaughtExceptionMonitor`。
 *
 * @param log - 该 lease 的**实例级**日志器；物理 listener 装上后即固定用它打印
 *   （同进程只有一组 listener，多 lease 时先到者为准）
 * @returns 释放本调用方 lease 的幂等 disposer
 */
export function setupProcessGuards(log: Logger): () => void {
  // 上一次最终 lease 清理失败时，先重试移除旧物理 listener，不能直接叠加新组。
  if (pendingRemoval && activeLeaseCount === 0) {
    const cleanupErrors = removeInstalledHandlers("pending lease retry");
    if (cleanupErrors.length > 0) {
      throw listenerCleanupError(cleanupErrors);
    }
  }
  if (!installed) {
    installProcessGuards(log);
  }
  pendingRemoval = false;
  activeLeaseCount += 1;

  let released = false;
  let cleanupPending = false;
  return () => {
    if (released) {
      return;
    }

    const current = installed;
    if (cleanupPending) {
      // 新 lease 已接管旧 handler 时，旧 disposer 只完成自身幂等收口。
      if (activeLeaseCount > 0 || !current || installed !== current) {
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
    if (!current) {
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
