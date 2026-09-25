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
 * - fields 仅在「非 undefined 且非空对象」时透传给 logger（避免把 undefined 参入 logger，
 *   其会被误判/噪化）；带 extra 的事件 fields 是**倒数第二**个参数，最后一个是 LevelOverride
 *   （缺省 undefined = 用事件自身等级），调用方不得靠传 undefined 抹字段
 */

/** 事件日志最小接口：Logger 结构满足，可直接传入 */
export interface EventLog {
  debug(...args: unknown[]): void;
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

/** 事件默认输出通道：warn（默认）/ error（配置类严重问题，如环路） */
type EventLevel = "warn" | "error";

/**
 * 调用点可覆盖的输出通道：缺省沿用事件自身的默认等级。
 * @description 只允许 `"debug"`，且仅限调用方**已判定为环境噪音**的场景（如 0 字节裸 TCP 探活）；
 * 事件不得被降级成 error，也不得借它删改结构化字段——降级只改等级。
 */
type LevelOverride = "debug";

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
): (log: EventLog, detail: D, fields?: Record<string, unknown>, override?: LevelOverride) => void {
  return (log, detail, fields, override) => {
    const msg = `[${code}] ${format(detail)}`;
    const out = override ?? level;
    if (hasFields(fields)) log[out](msg, fields);
    else log[out](msg);
  };
}

/**
 * 带 extra 的事件工厂（msg + extra + fields）：extra 为 undefined 时退化为简单事件，
 * 否则 `${msg}:` + extra [+ fields]
 * @param code - 事件码（取自 `LogEvent`）
 * @param format - detail → 消息正文，同 `makeEvent`
 * @param level - 输出通道，默认 warn
 */
function makeExtraEvent<D>(
  code: string,
  format: (detail: D) => string,
  level: EventLevel = "warn",
): (
  log: EventLog,
  detail: D,
  extra?: unknown,
  fields?: Record<string, unknown>,
  override?: LevelOverride,
) => void {
  const simple = makeEvent(code, format, level);
  return (log, detail, extra, fields, override) => {
    // 不带 extra：fields 直接顶到第二位（仍为最后一个参数，Logger 按结构化识别）
    if (extra === undefined) return simple(log, detail, fields, override);
    const msg = `[${code}] ${format(detail)}`;
    const out = override ?? level;
    if (hasFields(fields)) log[out](`${msg}:`, extra, fields);
    else log[out](`${msg}:`, extra);
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
 * @description 默认 warn；调用方判定「本次连接一个字节都没收到」（裸 TCP 探活/端口扫描）时可传
 * `override = "debug"` 降级——只降**等级**，msg 与结构化字段形状不变。
 * @param log - 事件日志接口
 * @param detail - 人类可读描述（含协议与来源）
 * @param extra - 原始异常（可选）
 * @param fields - 结构化字段（可选，如 code / authorizationError）
 * @param override - 等级覆盖（可选，见上）
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
