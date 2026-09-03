/**
 * 结构化日志事件 - 收敛散落在各处的 warn/error 调用点
 * 职责：
 * - 同一语义只写一次格式：code 稳定可 grep，改措辞/改等级只动这里
 * - 调用方只传字段，不拼字符串
 * 设计：
 * - 零运行时依赖：仅 type-only 引用 Logger，参数收敛为最小接口，单测可传假 logger
 * - debug 追踪行（带完整上下文的流水）留在调用方，不归拢，避免过度抽象
 */

/** 事件日志最小接口：Logger 结构满足，可直接传入 */
export interface EventLog {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** 事件码：稳定可 grep，重命名即 breaking change */
export const LogEvent = {
  TargetUnresolved: "target-unresolved",
  LoopDetected: "loop-detected",
  UpstreamRefused: "upstream-refused",
  BadRequest: "bad-request",
  ClientTimeout: "client-timeout",
  ClientError: "client-error",
  UpstreamTimeout: "upstream-timeout",
  UpstreamError: "upstream-error",
} as const;

/** 目标解析失败（客户端烂 URL / Host 缺失）：调用方已回 400/502，这里只记 */
export function logTargetUnresolved(log: EventLog, url: string | undefined): void {
  log.warn(`[${LogEvent.TargetUnresolved}] cannot resolve target for ${url ?? "-"}`);
}

/** 环路：目标指回自身，配置错误，记 error */
export function logLoopDetected(log: EventLog, detail: string): void {
  log.error(`[${LogEvent.LoopDetected}] loop detected: ${detail}`);
}

/** 上游 CONNECT 非 200（如 407）：响应已原样 relay，这里只记 */
export function logUpstreamRefused(log: EventLog, statusLine: string): void {
  log.warn(`[${LogEvent.UpstreamRefused}] upstream CONNECT refused: ${statusLine.trim()}`);
}

/** 非法请求（烂请求行 / 解析不出目标 URL / 非法 authority）：调用方已回 4xx，这里只记 */
export function logBadRequest(log: EventLog, detail: string): void {
  log.warn(`[${LogEvent.BadRequest}] ${detail}`);
}

/** 客户端迟迟不发完整数据（首包超时）：已断开，这里只记 */
export function logClientTimeout(log: EventLog, detail: string): void {
  log.warn(`[${LogEvent.ClientTimeout}] ${detail}`);
}

/** 客户端 socket 出错：已销毁对端，这里只记 */
export function logClientError(log: EventLog, detail: string, extra?: unknown): void {
  if (extra === undefined) log.warn(`[${LogEvent.ClientError}] ${detail}`);
  else log.warn(`[${LogEvent.ClientError}] ${detail}:`, extra);
}

/** 上游拨号/请求超时：已回 504 或断开，这里只记 */
export function logUpstreamTimeout(log: EventLog, detail: string): void {
  log.warn(`[${LogEvent.UpstreamTimeout}] ${detail}`);
}

/** 上游出错：已回 502 或断开，这里只记 */
export function logUpstreamError(log: EventLog, detail: string, extra?: unknown): void {
  if (extra === undefined) log.warn(`[${LogEvent.UpstreamError}] ${detail}`);
  else log.warn(`[${LogEvent.UpstreamError}] ${detail}:`, extra);
}
