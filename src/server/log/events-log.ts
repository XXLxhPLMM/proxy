/**
 * 结构化日志事件 - 收敛散落在各处的 warn/error 调用点
 * 职责：
 * - 同一语义只写一次格式：code 稳定可 grep，改措辞/改等级只动这里
 * - 调用方只传字段，不拼字符串；可选的 fields 作为结构化字段透传给 Logger
 * 设计：
 * - 零运行时依赖：仅 type-only 引用 Logger，参数收敛为最小接口，单测可传假 logger
 * - debug 追踪行（带完整上下文的流水）留在调用方，不归拢，避免过度抽象
 * - fields 仅在「非 undefined 且非空对象」时作为最后一个参数透传，
 *   避免把 undefined 参入 logger（其会被误判/噪化），保持既有签名的向后兼容
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
  IpDenied: "ip-denied",
  TargetDenied: "target-denied",
} as const;

/**
 * 结构化字段是否应透传：非 undefined 且非空对象
 * @description 空对象透传无意义且会改变调用形态，统一在此判定；
 * 未通过判定时调用方必须走「不传 fields」的分支，绝不把 undefined 当参数传给 logger
 */
function hasFields(fields?: Record<string, unknown>): fields is Record<string, unknown> {
  return fields !== undefined && Object.keys(fields).length > 0;
}

/** 目标解析失败（客户端烂 URL / Host 缺失）：调用方已回 400/502，这里只记 */
export function logTargetUnresolved(
  log: EventLog,
  url: string | undefined,
  fields?: Record<string, unknown>,
): void {
  const msg = `[${LogEvent.TargetUnresolved}] cannot resolve target for ${url ?? "-"}`;
  if (hasFields(fields)) log.warn(msg, fields);
  else log.warn(msg);
}

/** 环路：目标指回自身，配置错误，记 error */
export function logLoopDetected(
  log: EventLog,
  detail: string,
  fields?: Record<string, unknown>,
): void {
  const msg = `[${LogEvent.LoopDetected}] loop detected: ${detail}`;
  if (hasFields(fields)) log.error(msg, fields);
  else log.error(msg);
}

/** 上游 CONNECT 非 200（如 407）：响应已原样 relay，这里只记 */
export function logUpstreamRefused(
  log: EventLog,
  statusLine: string,
  fields?: Record<string, unknown>,
): void {
  const msg = `[${LogEvent.UpstreamRefused}] upstream CONNECT refused: ${statusLine.trim()}`;
  if (hasFields(fields)) log.warn(msg, fields);
  else log.warn(msg);
}

/** 非法请求（烂请求行 / 解析不出目标 URL / 非法 authority）：调用方已回 4xx，这里只记 */
export function logBadRequest(
  log: EventLog,
  detail: string,
  fields?: Record<string, unknown>,
): void {
  const msg = `[${LogEvent.BadRequest}] ${detail}`;
  if (hasFields(fields)) log.warn(msg, fields);
  else log.warn(msg);
}

/** 客户端迟迟不发完整数据（首包超时）：已断开，这里只记 */
export function logClientTimeout(
  log: EventLog,
  detail: string,
  fields?: Record<string, unknown>,
): void {
  const msg = `[${LogEvent.ClientTimeout}] ${detail}`;
  if (hasFields(fields)) log.warn(msg, fields);
  else log.warn(msg);
}

/** 客户端 socket 出错：已销毁对端，这里只记 */
export function logClientError(
  log: EventLog,
  detail: string,
  extra?: unknown,
  fields?: Record<string, unknown>,
): void {
  const msg = `[${LogEvent.ClientError}] ${detail}`;
  if (extra === undefined) {
    // 不带 extra：fields 直接顶到第二位（仍为最后一个参数，Logger 按结构化识别）
    if (hasFields(fields)) log.warn(msg, fields);
    else log.warn(msg);
  } else if (hasFields(fields)) {
    log.warn(`${msg}:`, extra, fields);
  } else {
    log.warn(`${msg}:`, extra);
  }
}

/** 上游拨号/请求超时：已回 504 或断开，这里只记 */
export function logUpstreamTimeout(
  log: EventLog,
  detail: string,
  fields?: Record<string, unknown>,
): void {
  const msg = `[${LogEvent.UpstreamTimeout}] ${detail}`;
  if (hasFields(fields)) log.warn(msg, fields);
  else log.warn(msg);
}

/** 上游出错：已回 502 或断开，这里只记 */
export function logUpstreamError(
  log: EventLog,
  detail: string,
  extra?: unknown,
  fields?: Record<string, unknown>,
): void {
  const msg = `[${LogEvent.UpstreamError}] ${detail}`;
  if (extra === undefined) {
    if (hasFields(fields)) log.warn(msg, fields);
    else log.warn(msg);
  } else if (hasFields(fields)) {
    log.warn(`${msg}:`, extra, fields);
  } else {
    log.warn(`${msg}:`, extra);
  }
}

/** IP 命中拒绝名单：客户端 IP 被策略拒绝（已回 403/断开），这里只记 warn */
export function logIpDenied(
  log: EventLog,
  detail: string,
  fields?: Record<string, unknown>,
): void {
  const msg = `[${LogEvent.IpDenied}] ${detail}`;
  if (hasFields(fields)) log.warn(msg, fields);
  else log.warn(msg);
}

/** 目标命中拒绝名单：目标地址被策略拒绝（已回 403/断开），这里只记 warn */
export function logTargetDenied(
  log: EventLog,
  detail: string,
  fields?: Record<string, unknown>,
): void {
  const msg = `[${LogEvent.TargetDenied}] ${detail}`;
  if (hasFields(fields)) log.warn(msg, fields);
  else log.warn(msg);
}
