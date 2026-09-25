/**
 * 生命周期跨层预算 - 只存常量与纯计算，避免 cluster 反向依赖 server 编排类。
 */

/** ProxyServer.stop() 的默认公开 grace。 */
export const DEFAULT_SERVER_STOP_GRACE_MS = 20_000;

/** hard-exit 前给 logger 的有界 flush 窗口。 */
export const STOP_HARD_EXIT_FLUSH_TIMEOUT_MS = 1_000;

/** worker stop 完成到 master 观察退出之间的调度/事件余量。 */
export const CLUSTER_STOP_GRACE_MARGIN_MS = 1_000;

/**
 * 计算 master shutdown/kill grace：必须大于 worker 的 stop grace + hard-exit flush。
 * upstreamTimeout 较大时再保留原有的 5s 收尾预算。
 */
export function resolveClusterStopGraceMs(upstreamTimeoutMs: number): number {
  const upstreamTimeout = Number.isFinite(upstreamTimeoutMs) && upstreamTimeoutMs > 0
    ? upstreamTimeoutMs
    : 0;
  return Math.max(
    DEFAULT_SERVER_STOP_GRACE_MS + STOP_HARD_EXIT_FLUSH_TIMEOUT_MS + CLUSTER_STOP_GRACE_MARGIN_MS,
    upstreamTimeout + 5_000,
  );
}
