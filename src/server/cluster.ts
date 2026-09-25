/**
 * Cluster 编排 - 多进程共享监听端口
 * 职责：
 * - master 进程按 clusterWorkers fork N 个 worker，worker 崩溃自动重启
 *   （存活 <5s 视为 rapid：带 1s 退避重启，连续 5 次即判定启动错误并 exit(1)）
 * - 收到 SIGINT/SIGTERM 时，master 通过 IPC 通知各 worker 优雅停机，排空存量连接后退出
 * - Windows 无法向子进程转发信号，故停机依赖 IPC（worker 侧见 ProxyServer.bindSignals）
 * 说明：
 * - 本仓库目标运行环境 Windows 的 Node 不支持 reusePort（listen 报 ENOTSUP），
 *   因此多进程采用 cluster（master 监听后共享句柄），而非独立进程 + SO_REUSEPORT
 * - worker 之间不共享内存，配置各自从 env 加载，运行时状态（缓存/统计）互相独立
 */

import cluster, { type Worker } from "node:cluster";
import os from "node:os";
import { get, getAll } from "@/config/store.js";
import { logger } from "@/utils/logger.js";
import { printBanner } from "@/utils/banner.js";
import { logConfig } from "./log/config-log.js";
import { resolveClusterStopGraceMs } from "./lifecycle-budget.js";

/** 解析生效的 worker 数：0 表示按 CPU 核数，其余按字面值 */
function resolveWorkers(): number {
  const n = get("clusterWorkers");
  if (n === 0) {
    return Math.max(1, os.cpus().length);
  }
  return n;
}

/** 当前进程是否应作为 cluster master 运行（需要 fork worker） */
export function shouldRunAsMaster(): boolean {
  return resolveWorkers() > 1 && !cluster.isWorker;
}

/** rapid 退出判定阈值：worker 存活短于该值视为「启动即崩」（配置错/端口占用等确定性错误） */
const RAPID_EXIT_MS = 5000;
/** 连续 rapid 退出上限：达到即判定为无法自愈的启动错误，放弃重启并快速失败 */
const MAX_RAPID_RESTARTS = 5;
/** rapid 退出的重启退避间隔，避免确定性错误引发 fork 风暴刷日志 */
const RAPID_RESTART_DELAY_MS = 1000;
/** 启动失败清理的最长等待；超过后强杀已创建 worker，原始 fork 错误仍由调用方接收。 */
const FAILURE_CLEANUP_GRACE_MS = 1000;
/** master 收尾时日志 flush 的上限，避免残留句柄把正常退出重新挂成无限等待。 */
const FLUSH_TIMEOUT_MS = 1000;

/** cluster master 的进程退出 ownership；默认由库调用方自行决定，不默认杀宿主。 */
export interface ClusterRunOptions {
  /** 与 `ProxyServerOptions.allowProcessExit` 同语义：gate master 的正常/二次 signal、rapid/full exit；worker IPC 不受 gate 影响。 */
  readonly allowProcessExit?: boolean;
}

type CleanupFailure = {
  operation: string;
  error: unknown;
};

type BoundedResult =
  { kind: "fulfilled" } | { kind: "rejected"; error: unknown } | { kind: "timeout" };

function aggregateCleanupErrors(failures: CleanupFailure[]): unknown {
  const errors = failures.map(({ error }) => error);
  return errors.length === 1 ? errors[0] : new AggregateError(errors, "multiple cleanup failures");
}

function reportCleanupFailures(scope: string, failures: CleanupFailure[]): void {
  if (failures.length === 0) {
    return;
  }
  for (const { operation, error } of failures) {
    try {
      logger.error(`[cluster] ${scope} cleanup ${operation} failed:`, error);
    } catch {
      // logger 契约是永不抛；记录失败不能阻断其它清理。
    }
  }
  if (failures.length > 1) {
    try {
      logger.error(`[cluster] ${scope} cleanup failures:`, aggregateCleanupErrors(failures));
    } catch {
      // 同上。
    }
  }
}

/** 底层 Promise 始终安装 rejection handler，迟到错误不会变成 unhandledRejection。 */
async function runBounded(
  operation: () => Promise<unknown>,
  timeoutMs: number,
): Promise<BoundedResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BoundedResult>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const settled = Promise.resolve()
    .then(operation)
    .then(
      (): BoundedResult => ({ kind: "fulfilled" }),
      (error: unknown): BoundedResult => ({ kind: "rejected", error }),
    );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function runDisposers(disposers: Array<() => void>): unknown[] {
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

type WorkerErrorEntry = {
  child: Worker["process"];
  listener: (error: Error) => void;
};

/**
 * 以 master 身份运行：fork workers、监控退出、优雅停机。
 * 返回的 Promise 在所有 worker 退出后 resolve，供上层结束进程。
 */
export async function runAsMaster(options: ClusterRunOptions = {}): Promise<void> {
  const allowProcessExit = options.allowProcessExit === true;
  const count = resolveWorkers();
  // 显式设置 Round-Robin 调度策略，确保 Windows 上也能均匀分发连接到各 worker
  cluster.schedulingPolicy = cluster.SCHED_RR;
  logger.notice("info", `[cluster] master pid=${process.pid} forking ${count} workers`);

  let shuttingDown = false;
  let failureStarted = false;
  let terminalExitStarted = false;
  let exitCalled = false;
  let uncleanExit = false;
  let uncleanExitReason = "";
  let primaryFailure: unknown;
  let failureCleanup: Promise<void> | undefined;
  const readyPids = new Set<number>();
  /** 所有已经创建过的 worker；cluster.workers 在 fork 中途异常时可能来不及更新。 */
  const createdWorkers = new Set<Worker>();
  /** 各 worker 的 fork 时间戳，用于判定 rapid 退出。 */
  const forkedAt = new Map<Worker, number>();
  /** 连续 rapid 退出计数：健康退出后清零 */
  let rapidRestarts = 0;
  /** 所有待执行的 rapid-restart timer；shutdown/failure 时整体取消。 */
  const rapidRestartTimers = new Set<ReturnType<typeof setTimeout>>();
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  let shutdownSendFailures = 0;
  const workerErrorListeners = new Map<Worker, WorkerErrorEntry>();

  let resolveAllExited!: () => void;
  const allExited = new Promise<void>((resolve) => {
    resolveAllExited = resolve;
  });
  let rejectFailure!: (error: unknown) => void;
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });

  const currentWorkers = (): Worker[] => {
    const workers = new Set<Worker>(createdWorkers);
    for (const worker of Object.values(cluster.workers ?? {})) {
      if (worker) {
        workers.add(worker);
      }
    }
    return [...workers];
  };
  const isDead = (worker: Worker): boolean => {
    try {
      return worker.isDead();
    } catch {
      return false;
    }
  };
  const workerPid = (worker: Worker): number | string => {
    try {
      return worker.process?.pid ?? "?";
    } catch {
      return "?";
    }
  };
  const workerPidNumber = (worker: Worker): number => {
    const pid = workerPid(worker);
    return typeof pid === "number" ? pid : 0;
  };
  const liveCount = (): number => currentWorkers().filter((worker) => !isDead(worker)).length;
  const resolveIfNoWorkers = (): void => {
    if (liveCount() === 0) {
      resolveAllExited();
    }
  };
  const cancelRapidRestarts = (): void => {
    for (const timer of rapidRestartTimers) {
      clearTimeout(timer);
    }
    rapidRestartTimers.clear();
  };
  const clearShutdownTimer = (): void => {
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = undefined;
    }
  };

  const safeLog = (level: "info" | "warn" | "error", message: string, error?: unknown): void => {
    try {
      if (level === "info") {
        logger.info(message);
      } else if (level === "warn") {
        logger.warn(message);
      } else if (error === undefined) {
        logger.error(message);
      } else {
        logger.error(message, error);
      }
    } catch {
      // master cleanup 不依赖日志器成功。
    }
  };

  const exitOnce = (code: number): void => {
    if (exitCalled) {
      return;
    }
    exitCalled = true;
    if (!allowProcessExit) {
      safeLog("warn", `[cluster] process.exit(${code}) suppressed: allowProcessExit=false`);
      return;
    }
    try {
      process.exit(code);
    } catch (error) {
      safeLog("error", `[cluster] process.exit(${code}) failed`, error);
    }
  };

  const attachWorkerErrorListener = (worker: Worker): void => {
    if (workerErrorListeners.has(worker)) {
      return;
    }
    let child: Worker["process"];
    try {
      child = worker.process;
    } catch (error) {
      safeLog("error", `[cluster] unable to inspect worker ${workerPid(worker)}`, error);
      return;
    }
    const listener = (error: Error): void => {
      safeLog("error", `[cluster] worker pid=${child.pid ?? "?"} child process error`, error);
    };
    try {
      child.on("error", listener);
      workerErrorListeners.set(worker, { child, listener });
    } catch (error) {
      safeLog("error", `[cluster] unable to guard worker ${child.pid ?? "?"} error`, error);
    }
  };

  const detachWorkerErrorListener = (worker: Worker): CleanupFailure[] => {
    const entry = workerErrorListeners.get(worker);
    if (!entry) {
      return [];
    }
    const failures: CleanupFailure[] = [];
    try {
      entry.child.removeListener("error", entry.listener);
    } catch (error) {
      failures.push({ operation: `worker ${entry.child.pid ?? "?"} error listener`, error });
    }
    if (failures.length === 0) {
      workerErrorListeners.delete(worker);
    }
    return failures;
  };

  const detachAllWorkerErrorListeners = (): CleanupFailure[] => {
    const failures: CleanupFailure[] = [];
    for (const worker of [...workerErrorListeners.keys()]) {
      failures.push(...detachWorkerErrorListener(worker));
    }
    return failures;
  };

  const sendShutdown = (worker: Worker | undefined): void => {
    if (!worker) {
      return;
    }
    const pid = workerPid(worker);
    try {
      // 必须提供 callback：send 的错误可能异步到达，不能让 ChildProcess error 变成未处理异常。
      worker.send({ type: "shutdown" }, (error) => {
        if (error) {
          shutdownSendFailures++;
          safeLog("warn", `[cluster] failed to send shutdown to worker pid=${pid}`, error);
        }
      });
    } catch (error) {
      shutdownSendFailures++;
      safeLog("warn", `[cluster] failed to send shutdown to worker pid=${pid}`, error);
    }
  };

  const killWorkers = (signal: NodeJS.Signals, failures: CleanupFailure[]): void => {
    for (const worker of currentWorkers()) {
      try {
        worker.kill(signal);
      } catch (error) {
        failures.push({
          operation: `kill worker ${workerPid(worker)}`,
          error,
        });
      }
    }
  };

  const waitForWorkersExit = (workers: Worker[], timeoutMs: number): Promise<boolean> => {
    const pending = new Set(workers.filter((worker) => !isDead(worker)));
    if (pending.size === 0) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let listenerError = false;
      const listeners = new Map<Worker, () => void>();
      function finish(result: boolean): void {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        for (const [worker, listener] of listeners) {
          try {
            worker.removeListener("exit", listener);
          } catch {
            // 仅用于失败收尾；不能因为移除 listener 失败而跳过后续 worker。
          }
        }
        resolve(result);
      }
      const timer = setTimeout(() => finish(false), timeoutMs);
      const onWorkerExit = (worker: Worker): void => {
        if (pending.delete(worker) && pending.size === 0) {
          finish(!listenerError);
        }
      };
      for (const worker of pending) {
        const listener = (): void => onWorkerExit(worker);
        listeners.set(worker, listener);
        try {
          worker.once("exit", listener);
          if (isDead(worker)) {
            onWorkerExit(worker);
          }
        } catch {
          listenerError = true;
          pending.delete(worker);
        }
      }
      if (pending.size === 0) {
        finish(!listenerError);
      }
    });
  };

  const onFork = (worker: Worker): void => {
    createdWorkers.add(worker);
    forkedAt.set(worker, Date.now());
    attachWorkerErrorListener(worker);
    if (shuttingDown || failureStarted) {
      // fork 与 shutdown/failure 交错时，worker 可能错过主循环遍历到的对象。
      sendShutdown(worker);
    }
  };

  const onExit = (worker: Worker, code: number | null, signal: string | null): void => {
    createdWorkers.delete(worker);
    const pid = workerPid(worker);
    const exitFailures = detachWorkerErrorListener(worker);
    reportCleanupFailures("worker exit", exitFailures);
    const born = forkedAt.get(worker);
    forkedAt.delete(worker);
    const aliveMs = born === undefined ? Number.MAX_SAFE_INTEGER : Date.now() - born;
    readyPids.delete(typeof pid === "number" ? pid : 0);
    const abnormalExit = signal !== null || (code !== null && code !== 0);
    if (abnormalExit && shuttingDown) {
      uncleanExit = true;
      uncleanExitReason = uncleanExitReason || `worker pid=${pid} signal=${signal ?? "none"} code=${code ?? "none"}`;
      safeLog("warn", `[cluster] worker pid=${pid} exited uncleanly during shutdown`, { code, signal });
    }

    if (failureStarted) {
      safeLog(
        "info",
        `[cluster] worker pid=${pid} exited during failure cleanup (code=${code} signal=${signal})`,
      );
      return;
    }
    if (shuttingDown) {
      safeLog(
        abnormalExit ? "warn" : "info",
        `[cluster] worker pid=${pid} exited (code=${code} signal=${signal}), live=${liveCount()}`,
      );
      resolveIfNoWorkers();
      return;
    }

    // rapid：存活 <5s 视为启动即崩，带退避重启并累计；连续达上限说明确定性错误无法自愈
    if (aliveMs < RAPID_EXIT_MS) {
      rapidRestarts++;
      if (rapidRestarts >= MAX_RAPID_RESTARTS) {
        const reason = new Error(
          `[cluster] worker pid=${pid} crashed ${rapidRestarts} times in a row within ${RAPID_EXIT_MS}ms (code=${code} signal=${signal})`,
        );
        abortRapid(reason);
        return;
      }
      safeLog(
        "warn",
        `[cluster] worker pid=${pid} exited rapidly (alive=${aliveMs}ms, code=${code} signal=${signal}), restarting in ${RAPID_RESTART_DELAY_MS}ms (${rapidRestarts}/${MAX_RAPID_RESTARTS})`,
      );
      const timer = setTimeout(() => {
        rapidRestartTimers.delete(timer);
        // clearTimeout 不能撤回已经进入 timer 队列的 callback，故 callback 必须再次确认状态。
        if (shuttingDown || failureStarted) {
          return;
        }
        try {
          forkWorker();
        } catch (error) {
          failMaster(error);
        }
      }, RAPID_RESTART_DELAY_MS);
      rapidRestartTimers.add(timer);
      return;
    }

    // 健康退出（存活 >=5s）：立即补拉并清零连续 rapid 计数
    rapidRestarts = 0;
    safeLog(
      "warn",
      `[cluster] worker pid=${pid} exited unexpectedly (code=${code} signal=${signal}, alive=${aliveMs}ms), restarting`,
    );
    if (!shuttingDown && !failureStarted) {
      try {
        forkWorker();
      } catch (error) {
        failMaster(error);
      }
    }
  };

  // 收集 worker 就绪消息，全部就绪后输出汇总（只打一次）
  let readyAnnounced = false;
  const onMessage = (worker: Worker, msg: unknown): void => {
    // worker 可能尚未安装自己的 message listener 才收到第一次 shutdown；ready 是补发窗口。
    if (shuttingDown || failureStarted) {
      sendShutdown(worker);
      return;
    }
    if (typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "ready") {
      const pid = (msg as { pid?: number }).pid ?? workerPidNumber(worker);
      readyPids.add(pid);
      safeLog("info", `[cluster] worker pid=${pid} started (${readyPids.size}/${count})`);
      // 判据用「当前就绪的 pid 集合」而非单调计数：重启后集合大小不变，不会重复打印汇总/banner
      if (!readyAnnounced && readyPids.size >= count) {
        readyAnnounced = true;
        const all = getAll();
        logger.notice(
          "info",
          `[cluster] all ${count} workers ready, listening on port ${all.port} protocol=${all.proxyProtocol}`,
        );
        printBanner();
      }
    }
  };

  const removeMasterListeners = (): CleanupFailure[] => {
    const errors = runDisposers([
      () => cluster.removeListener("fork", onFork),
      () => cluster.removeListener("exit", onExit),
      () => cluster.removeListener("message", onMessage),
      () => process.removeListener("SIGINT", onSignal),
      () => process.removeListener("SIGTERM", onSignal),
    ]);
    return errors.map((error, index) => ({
      operation: `master listener ${index + 1}`,
      error,
    }));
  };

  const onSignal = (): void => {
    shutdown();
  };

  const shutdown = (): void => {
    if (failureStarted) {
      safeLog("warn", "[cluster] signal during failure cleanup ignored");
      return;
    }
    if (shuttingDown) {
      // 停机中再次收到信号：先尽力收掉 worker，再给日志一个有界 flush，最后强退。
      safeLog("warn", "[cluster] master second signal, force exit");
      const failures: CleanupFailure[] = [];
      killWorkers("SIGKILL", failures);
      reportCleanupFailures("second signal kill", failures);
      void runBounded(() => logger.flush(), FLUSH_TIMEOUT_MS).finally(() => exitOnce(1));
      return;
    }
    shuttingDown = true;
    cancelRapidRestarts();
    clearShutdownTimer();
    safeLog("info", `[cluster] master shutting down ${liveCount()} workers`);
    for (const worker of currentWorkers()) {
      sendShutdown(worker);
    }
    // 若信号早于首次 fork，不能等待一个永远不会发生的 exit 事件。
    resolveIfNoWorkers();

    // 兜底：超时仍未退出的 worker 强制 kill，避免停机挂死
    const graceMs = resolveClusterStopGraceMs(get("upstreamTimeout"));
    shutdownTimer = setTimeout(() => {
      safeLog(
        "warn",
        `[cluster] shutdown timeout ${graceMs}ms, force killing ${liveCount()} workers`,
      );
      const failures: CleanupFailure[] = [];
      killWorkers("SIGKILL", failures);
      reportCleanupFailures("shutdown kill", failures);
    }, graceMs);
    shutdownTimer.unref();
  };

  const forkWorker = (): Worker => {
    const worker = cluster.fork();
    createdWorkers.add(worker);
    return worker;
  };

  const cleanupAfterMasterFailure = async (primaryError: unknown): Promise<void> => {
    const failures: CleanupFailure[] = [];
    const workers = currentWorkers();
    for (const worker of workers) {
      sendShutdown(worker);
    }
    if (workers.length > 0) {
      try {
        const exited = await waitForWorkersExit(workers, FAILURE_CLEANUP_GRACE_MS);
        if (!exited) {
          failures.push({
            operation: "worker graceful exit",
            error: new Error("worker exit timeout"),
          });
          killWorkers("SIGKILL", failures);
          const killed = await waitForWorkersExit(workers, FAILURE_CLEANUP_GRACE_MS);
          if (!killed) {
            failures.push({
              operation: "worker force exit",
              error: new Error("worker kill timeout"),
            });
          }
        }
      } catch (error) {
        failures.push({ operation: "worker cleanup wait", error });
        killWorkers("SIGKILL", failures);
      }
    }

    failures.push(...detachAllWorkerErrorListeners());
    failures.push(...removeMasterListeners());
    const flushResult = await runBounded(() => logger.flush(), FLUSH_TIMEOUT_MS);
    if (flushResult.kind === "rejected") {
      failures.push({ operation: "logger.flush", error: flushResult.error });
    } else if (flushResult.kind === "timeout") {
      failures.push({ operation: "logger.flush", error: new Error("logger.flush timeout") });
    }
    reportCleanupFailures("master failure", failures);
    safeLog("error", "[cluster] master startup failed; primary error preserved", primaryError);
  };

  const abortRapid = (reason: Error): void => {
    if (terminalExitStarted || failureStarted) {
      return;
    }
    terminalExitStarted = true;
    failureStarted = true;
    shuttingDown = true;
    primaryFailure = reason;
    cancelRapidRestarts();
    clearShutdownTimer();
    safeLog("error", "[cluster] rapid restart limit reached", reason);
    failureCleanup = cleanupAfterMasterFailure(reason).catch((cleanupError) => {
      const failures: CleanupFailure[] = [
        { operation: "rapid abort cleanup", error: cleanupError },
      ];
      reportCleanupFailures("rapid abort", failures);
    });
    void failureCleanup.finally(() => {
      rejectFailure(reason);
      exitOnce(1);
    });
  };

  const failMaster = (error: unknown): void => {
    if (failureStarted) {
      return;
    }
    failureStarted = true;
    primaryFailure = error;
    shuttingDown = true;
    cancelRapidRestarts();
    clearShutdownTimer();
    failureCleanup = cleanupAfterMasterFailure(error).catch((cleanupError) => {
      const failures: CleanupFailure[] = [{ operation: "failure cleanup", error: cleanupError }];
      reportCleanupFailures("master failure", failures);
    });
    void failureCleanup.finally(() => rejectFailure(error));
  };

  const registerMasterListeners = (): void => {
    try {
      cluster.on("fork", onFork);
      cluster.on("exit", onExit);
      cluster.on("message", onMessage);
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
    } catch (error) {
      const cleanupFailures = removeMasterListeners();
      reportCleanupFailures("listener install rollback", cleanupFailures);
      throw error;
    }
  };

  // 所有 cluster listener 都要在首次 fork 前就位，避免启动窗口内丢 worker 事件。
  try {
    registerMasterListeners();
    logConfig();
    for (let i = 0; i < count && !shuttingDown && !failureStarted; i++) {
      forkWorker();
    }
  } catch (error) {
    failMaster(error);
  }

  await Promise.race([
    allExited.then(() => "all-exited" as const),
    failure.then(() => "failed" as const),
  ]);
  if (failureStarted) {
    if (failureCleanup) {
      await failureCleanup;
    }
    throw primaryFailure;
  }

  clearShutdownTimer();
  cancelRapidRestarts();
  const finalFailures: CleanupFailure[] = [];
  try {
    logger.notice("info", "[cluster] all workers exited, master finished");
  } catch (error) {
    finalFailures.push({ operation: "completion log", error });
  }
  finalFailures.push(...detachAllWorkerErrorListeners());
  finalFailures.push(...removeMasterListeners());
  const finalFlush = await runBounded(() => logger.flush(), FLUSH_TIMEOUT_MS);
  if (finalFlush.kind === "rejected") {
    finalFailures.push({ operation: "logger.flush", error: finalFlush.error });
  } else if (finalFlush.kind === "timeout") {
    finalFailures.push({ operation: "logger.flush", error: new Error("logger.flush timeout") });
  }
  if (shutdownSendFailures > 0) {
    finalFailures.push({
      operation: "worker shutdown IPC",
      error: new Error(`${shutdownSendFailures} shutdown IPC send operation(s) failed`),
    });
  }
  const uncleanError = uncleanExit
    ? new Error(`[cluster] worker exited uncleanly during shutdown: ${uncleanExitReason}`)
    : undefined;
  if (uncleanError) {
    finalFailures.push({ operation: "worker shutdown exit", error: uncleanError });
  }
  reportCleanupFailures("master completion", finalFailures);
  if (uncleanError) {
    // 强杀/非零退出的 shutdown 不能伪装成成功；gate=false 时 reject 给宿主处理。
    exitOnce(1);
    throw uncleanError;
  }
  // 显式退出：worker 已全部退出，master 仅剩可能残留的句柄，直接收尾避免挂死（先等齐落盘）
  exitOnce(0);
}
