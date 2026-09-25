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

import cluster from "node:cluster";
import os from "node:os";
import type { ConfigContext } from "@/config/accessor.js";
import type { LoggerImpl } from "@/utils/logger.js";
import { printBanner } from "@/utils/banner.js";

/** 解析生效的 worker 数：0 表示按 CPU 核数，其余按字面值 */
function resolveWorkers(context: ConfigContext): number {
  const n = context.store.get("clusterWorkers");
  if (n === 0) {
    return Math.max(1, os.cpus().length);
  }
  return n;
}

/** 当前存活的 worker 数量 */
function liveCount(): number {
  return Object.keys(cluster.workers ?? {}).length;
}

/** 当前进程是否应作为 cluster master 运行（需要 fork worker） */
export function shouldRunAsMaster(context: ConfigContext): boolean {
  return resolveWorkers(context) > 1 && !cluster.isWorker;
}

/** rapid 退出判定阈值：worker 存活短于该值视为「启动即崩」（配置错/端口占用等确定性错误） */
const RAPID_EXIT_MS = 5000;
/** 连续 rapid 退出上限：达到即判定为无法自愈的启动错误，放弃重启并快速失败 */
const MAX_RAPID_RESTARTS = 5;
/** rapid 退出的重启退避间隔，避免确定性错误引发 fork 风暴刷日志 */
const RAPID_RESTART_DELAY_MS = 1000;

/**
 * 以 master 身份运行：fork workers、监控退出、优雅停机。
 * 返回的 Promise 在所有 worker 退出后 resolve，供上层结束进程。
 */
export async function runAsMaster(
  context: ConfigContext,
  logger: LoggerImpl,
  noColor = false,
): Promise<void> {
  const count = resolveWorkers(context);
  // 显式设置 Round-Robin 调度策略，确保 Windows 上也能均匀分发连接到各 worker
  cluster.schedulingPolicy = cluster.SCHED_RR;
  logger.notice("info", `[cluster] master pid=${process.pid} forking ${count} workers`);

  let shuttingDown = false;
  const readyPids = new Set<number>();
  /** 各 worker 的 fork 时间戳（pid -> ms），用于判定 rapid 退出 */
  const forkedAt = new Map<number, number>();
  /** 连续 rapid 退出计数：健康退出后清零 */
  let rapidRestarts = 0;

  // 记录每个 worker 的 fork 时刻，退出时据此算存活时长
  cluster.on("fork", (worker) => {
    const pid = worker.process.pid;
    if (pid) {
      forkedAt.set(pid, Date.now());
    }
  });

  const allExited = new Promise<void>((resolve) => {
    cluster.on("exit", (worker, code, signal) => {
      const pid = worker.process.pid ?? 0;
      readyPids.delete(pid);
      const born = forkedAt.get(pid);
      forkedAt.delete(pid);
      const aliveMs = born === undefined ? Number.MAX_SAFE_INTEGER : Date.now() - born;

      if (shuttingDown) {
        logger.info(
          `[cluster] worker pid=${pid} exited (code=${code} signal=${signal}), live=${liveCount()}`,
        );
        if (liveCount() === 0) {
          resolve();
        }
        return;
      }

      // rapid：存活 <5s 视为启动即崩，带退避重启并累计；连续达上限说明确定性错误无法自愈
      if (aliveMs < RAPID_EXIT_MS) {
        rapidRestarts++;
        if (rapidRestarts >= MAX_RAPID_RESTARTS) {
          logger.error(
            `[cluster] worker pid=${pid} crashed ${rapidRestarts} times in a row within ${RAPID_EXIT_MS}ms (code=${code} signal=${signal}), aborting`,
          );
          // 显式退出前等齐 aborted 行落盘；return 防止继续落到下方的重启分支
          void logger.flush().finally(() => process.exit(1));
          return;
        }
        logger.notice(
          "warn",
          `[cluster] worker pid=${pid} exited rapidly (alive=${aliveMs}ms, code=${code} signal=${signal}), restarting in ${RAPID_RESTART_DELAY_MS}ms (${rapidRestarts}/${MAX_RAPID_RESTARTS})`,
        );
        setTimeout(() => cluster.fork(), RAPID_RESTART_DELAY_MS);
        return;
      }

      // 健康退出（存活 >=5s）：立即补拉并清零连续 rapid 计数
      rapidRestarts = 0;
      logger.notice(
        "warn",
        `[cluster] worker pid=${pid} exited unexpectedly (code=${code} signal=${signal}, alive=${aliveMs}ms), restarting`,
      );
      cluster.fork();
    });
  });

  // 收集 worker 就绪消息，全部就绪后输出汇总（只打一次）
  let readyAnnounced = false;
  cluster.on("message", (worker, msg) => {
    if (typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "ready") {
      const pid = (msg as { pid?: number }).pid ?? worker.process.pid ?? 0;
      readyPids.add(pid);
      logger.info(`[cluster] worker pid=${pid} started (${readyPids.size}/${count})`);
      // 判据用「当前就绪的 pid 集合」而非单调计数：重启后集合大小不变，不会重复打印汇总/banner
      if (!readyAnnounced && readyPids.size >= count) {
        readyAnnounced = true;
        const all = context.config;
        logger.notice(
          "info",
          `[cluster] all ${count} workers ready, listening on port ${all.port} protocol=${all.proxyProtocol}`,
        );
        printBanner(logger, noColor);
      }
    }
  });

  // 配置日志依赖 runServer() 已显式完成 CLI 初始化，必须等到真正进入 master 生命周期后才加载。
  const { logConfig } = await import("./log/config-log.js");
  logConfig(context, logger);

  for (let i = 0; i < count; i++) {
    cluster.fork();
  }

  const shutdown = (): void => {
    if (shuttingDown) {
      // 停机中再次收到信号：放弃排空，立即强退
      logger.warn("[cluster] master second signal, force exit");
      process.exit(0);
    }
    shuttingDown = true;
    logger.notice("info", `[cluster] master shutting down ${liveCount()} workers`);
    for (const worker of Object.values(cluster.workers ?? {})) {
      try {
        worker?.send({ type: "shutdown" });
      } catch {
        void 0;
      }
    }
    // 兜底：超时仍未退出的 worker 强制 kill，避免停机挂死
    const graceMs = context.store.get("upstreamTimeout") + 5000;
    const timer = setTimeout(() => {
      logger.warn(`[cluster] shutdown timeout ${graceMs}ms, force killing ${liveCount()} workers`);
      for (const worker of Object.values(cluster.workers ?? {})) {
        worker?.kill("SIGKILL");
      }
    }, graceMs);
    timer.unref();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await allExited;
  logger.notice("info", "[cluster] all workers exited, master finished");
  // 显式退出：worker 已全部退出，master 仅剩可能残留的句柄，直接收尾避免挂死（先等齐落盘）
  await logger.flush();
  process.exit(0);
}
