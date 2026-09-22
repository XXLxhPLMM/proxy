/**
 * 结构化日志事件 - 收敛散落在各处的 warn/error 调用点
 * 职责：
 * - 同一语义只写一次格式：code 稳定可 grep，改措辞/改等级只动这里
 * - 调用方只传字段，不拼字符串；可选的 fields 作为结构化字段透传给 Logger
 * 设计：
 * - 零运行时依赖：仅 type-only 引用 Logger，参数收敛为最小接口，单测可传假 logger
 * - debug 追踪行（带完整上下文的流水）留在调用方，不归拢，避免过度抽象
 * - 导出由两个私有工厂生成（makeEvent / makeExtraEvent）：新增事件 = LogEvent 一行 +
 *   工厂调用一行；`hasFields` 分支只存在于工厂里，各事件只保留自己的消息格式
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
  TlsClientError: "tls-client-error",
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

/** 事件输出通道：warn（默认）/ error（配置类严重问题，如环路） */
type EventLevel = "warn" | "error";

/**
 * 简单事件工厂（msg + fields）：新增事件 = `LogEvent` 一行 + 这里一行工厂调用
 * @param code - 事件码（取自 `LogEvent`）
 * @param format - detail → 消息正文（`[code] ` 前缀由工厂补）；各事件格式不一
 *   （upstream-refused 要 trim、target-unresolved 兜底 `-`），故留在调用点
 * @param level - 输出通道，默认 warn；环路这类配置错误传 "error"
 */
function makeEvent<D>(
  code: string,
  format: (detail: D) => string,
  level: EventLevel = "warn",
): (log: EventLog, detail: D, fields?: Record<string, unknown>) => void {
  return (log, detail, fields) => {
    const msg = `[${code}] ${format(detail)}`;
    if (hasFields(fields)) log[level](msg, fields);
    else log[level](msg);
  };
}

/**
 * 带 extra 的事件工厂（msg + extra + fields）：extra 为 undefined 时退化为简单事件，
 * 否则 `${msg}:` + extra [+ fields]；三个 extra 事件当前均为 warn 级
 * @param code - 事件码（取自 `LogEvent`）
 * @param format - detail → 消息正文，同 `makeEvent`
 */
function makeExtraEvent<D>(
  code: string,
  format: (detail: D) => string,
): (log: EventLog, detail: D, extra?: unknown, fields?: Record<string, unknown>) => void {
  const simple = makeEvent(code, format);
  return (log, detail, extra, fields) => {
    // 不带 extra：fields 直接顶到第二位（仍为最后一个参数，Logger 按结构化识别）
    if (extra === undefined) return simple(log, detail, fields);
    const msg = `[${code}] ${format(detail)}`;
    if (hasFields(fields)) log.warn(`${msg}:`, extra, fields);
    else log.warn(`${msg}:`, extra);
  };
}

/** 目标解析失败（客户端烂 URL / Host 缺失）：调用方已回 400/502，这里只记 */
export const logTargetUnresolved = makeEvent(
  LogEvent.TargetUnresolved,
  (url: string | undefined) => `cannot resolve target for ${url ?? "-"}`,
);

/** 环路：目标指回自身，配置错误，记 error */
export const logLoopDetected = makeEvent(
  LogEvent.LoopDetected,
  (detail: string) => `loop detected: ${detail}`,
  "error",
);

/** 上游 CONNECT 非 200（如 407）：响应已原样 relay，这里只记 */
export const logUpstreamRefused = makeEvent(
  LogEvent.UpstreamRefused,
  (statusLine: string) => `upstream CONNECT refused: ${statusLine.trim()}`,
);

/** 非法请求（烂请求行 / 解析不出目标 URL / 非法 authority）：调用方已回 4xx，这里只记 */
export const logBadRequest = makeEvent(LogEvent.BadRequest, (detail: string) => detail);

/** 客户端迟迟不发完整数据（首包超时）：已断开，这里只记 */
export const logClientTimeout = makeEvent(LogEvent.ClientTimeout, (detail: string) => detail);

/** 客户端 socket 出错：已销毁对端，这里只记 */
export const logClientError = makeExtraEvent(LogEvent.ClientError, (detail: string) => detail);

/**
 * TLS 握手失败：含 mTLS 拒绝客户端证书、非 TLS 客户端打到 TLS 端口等，连接已丢弃，这里只记
 * @param log - 事件日志接口
 * @param detail - 人类可读描述（含协议与来源）
 * @param extra - 原始异常（可选）
 * @param fields - 结构化字段（可选，如 code / authorizationError）
 */
export const logTlsClientError = makeExtraEvent(
  LogEvent.TlsClientError,
  (detail: string) => detail,
);

/** 上游拨号/请求超时：已回 504 或断开，这里只记 */
export const logUpstreamTimeout = makeEvent(LogEvent.UpstreamTimeout, (detail: string) => detail);

/** 上游出错：已回 502 或断开，这里只记 */
export const logUpstreamError = makeExtraEvent(LogEvent.UpstreamError, (detail: string) => detail);

/** IP 命中拒绝名单：客户端 IP 被策略拒绝（已回 403/断开），这里只记 warn */
export const logIpDenied = makeEvent(LogEvent.IpDenied, (detail: string) => detail);

/** 目标命中拒绝名单：目标地址被策略拒绝（已回 403/断开），这里只记 warn */
export const logTargetDenied = makeEvent(LogEvent.TargetDenied, (detail: string) => detail);
