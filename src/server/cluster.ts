/**
 * Cluster 编排 - 多进程共享监听端口
 * 职责：
 * - master 进程按 clusterWorkers fork N 个 worker，worker 崩溃自动重启
 * - 收到 SIGINT/SIGTERM 时，master 通过 IPC 通知各 worker 优雅停机，排空存量连接后退出
 * - Windows 无法向子进程转发信号，故停机依赖 IPC（worker 侧见 ProxyServer.bindClusterShutdown）
 * 说明：
 * - 本仓库目标运行环境 Windows 的 Node 不支持 reusePort（listen 报 ENOTSUP），
 *   因此多进程采用 cluster（master 监听后共享句柄），而非独立进程 + SO_REUSEPORT
 * - worker 之间不共享内存，配置各自从 env 加载，运行时状态（缓存/统计）互相独立
 */

import cluster from "node:cluster";
import os from "node:os";
import { get, getAll } from "@/config/store.js";
import { logger } from "@/utils/logger.js";
import { printBanner } from "@/utils/banner.js";
import { logConfig } from "./log/config-log.js";

/** 解析生效的 worker 数：0 表示按 CPU 核数，其余按字面值 */
function resolveWorkers(): number {
  const n = get("clusterWorkers");
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
export function shouldRunAsMaster(): boolean {
  return resolveWorkers() > 1 && !cluster.isWorker;
}

/**
 * 以 master 身份运行：fork workers、监控退出、优雅停机。
 * 返回的 Promise 在所有 worker 退出后 resolve，供上层结束进程。
 */
export async function runAsMaster(): Promise<void> {
  const count = resolveWorkers();
  // 显式设置 Round-Robin 调度策略，确保 Windows 上也能均匀分发连接到各 worker
  cluster.schedulingPolicy = cluster.SCHED_RR;
  logger.info(`[cluster] master pid=${process.pid} forking ${count} workers`);

  let shuttingDown = false;
  const readyPids = new Set<number>();

  const allExited = new Promise<void>((resolve) => {
    cluster.on("exit", (worker, code, signal) => {
      const pid = worker.process.pid ?? 0;
      readyPids.delete(pid);
      if (shuttingDown) {
        logger.info(
          `[cluster] worker pid=${pid} exited (code=${code} signal=${signal}), live=${liveCount()}`,
        );
        if (liveCount() === 0) {
          resolve();
        }
        return;
      }
      // 运行期非停机退出：记录并补拉，维持目标并发
      logger.warn(
        `[cluster] worker pid=${pid} exited unexpectedly (code=${code} signal=${signal}), restarting`,
      );
      cluster.fork();
    });
  });

  // 收集 worker 就绪消息，全部就绪后输出汇总
  let readyCount = 0;
  cluster.on("message", (worker, msg) => {
    if (typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "ready") {
      const pid = (msg as { pid?: number }).pid ?? worker.process.pid ?? 0;
      readyPids.add(pid);
      readyCount++;
      logger.info(`[cluster] worker pid=${pid} started (${readyCount}/${count})`);
      if (readyCount >= count) {
        const all = getAll();
        logger.info(
          `[cluster] all ${count} workers ready, listening on port ${all.port} protocol=${all.proxyProtocol}`,
        );
        printBanner();
      }
    }
  });

  logConfig();

  for (let i = 0; i < count; i++) {
    cluster.fork();
  }

  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`[cluster] master shutting down ${liveCount()} workers`);
    for (const worker of Object.values(cluster.workers ?? {})) {
      try {
        worker?.send({ type: "shutdown" });
      } catch {
        void 0;
      }
    }
    // 兜底：超时仍未退出的 worker 强制 kill，避免停机挂死
    const graceMs = get("upstreamTimeout") + 5000;
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
  logger.info("[cluster] all workers exited, master finished");
}
