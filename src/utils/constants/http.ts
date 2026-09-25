/**
 * @fileoverview 协议常量中心 - HTTP 报文相关的魔术字符串与数字（http.ts）
 *
 * 职责清单：
 * - 报文分隔符（`CRLF` / `DOUBLE_CRLF` / `DOUBLE_CRLF_BUF`）与 HTTP 版本
 * - 状态码、原因短语、默认端口
 * - 代理头与通用头的头名 / 头值常量，以及 Basic / Bearer 鉴权 scheme 前缀
 * - 预拼完整响应报文（`HTTP_*`），调用方直接 `socket.write`，不手写状态行
 *
 * 约束：零依赖纯值定义，禁止从其他模块 import；新增魔术值只加这里，
 *       不在 `core/` 等调用点手写字面量。仅供派生用的符号（状态行前缀、
 *       仅被预拼报文消费的原因短语）刻意不导出。
 */

// ── 行分隔符 ──

/**
 * CRLF 行分隔符（`\r\n`），HTTP 报文行尾（RFC 9112 §2.2）。
 * 状态行与每个头字段行均以此结尾；调用点禁止手写 `"\r\n"` 字面量。
 */
export const CRLF = "\r\n";
/**
 * 双 CRLF 空行（`\r\n\r\n`），HTTP 头部与消息体之间的分隔符。
 * 预拼响应报文（HTTP_*）均以此收尾，表示头部结束。
 */
export const DOUBLE_CRLF = `${CRLF}${CRLF}`;
/**
 * 双 CRLF 的 Buffer 形态，用于二进制拼接/判帧，避免热路径重复 Buffer.from。
 */
export const DOUBLE_CRLF_BUF = Buffer.from(DOUBLE_CRLF);

// ── HTTP 版本与状态行 ──

/**
 * HTTP 版本标识，本代理回写报文统一使用 `HTTP/1.1`。
 * 下游按 HTTP/1.1 语义解析（长连接/CONNECT 隧道均在此版本下承载）。
 */
export const HTTP_VERSION = "HTTP/1.1";
/**
 * 状态行前缀（`"HTTP/1.1 "`），预拼响应报文（HTTP_*）的统一开头。
 * 新响应应由此前缀 + 状态码 + 原因短语拼出，不手写版本字面量。
 * 仅本文件派生预拼报文使用，调用点拼状态行走 `HTTP_VERSION`。
 */
const STATUS_LINE_PREFIX = `${HTTP_VERSION} `;

// ── 原因短语 ──

/**
 * 原因短语 `Connection Established`，用于 CONNECT 隧道建连成功（200）。
 * 仅本文件派生 `HTTP_200_CONNECTION_ESTABLISHED` 用。
 */
const REASON_CONNECTION_ESTABLISHED = "Connection Established";
export const REASON_BAD_REQUEST = "Bad Request";
/** 原因短语 `Forbidden`，访问控制（客户端 IP / 目标名单）拒绝时回写 */
export const REASON_FORBIDDEN = "Forbidden";
export const REASON_PROXY_AUTH_REQUIRED = "Proxy Authentication Required";
export const REASON_BAD_GATEWAY = "Bad Gateway";
/** 仅本文件派生 `HTTP_504_GATEWAY_TIMEOUT` 用，504 本身由 `STATUS_GATEWAY_TIMEOUT` 表达。 */
const REASON_GATEWAY_TIMEOUT = "Gateway Timeout";

// ── 状态码数字 ──

export const STATUS_OK = 200;
export const STATUS_SWITCHING_PROTOCOLS = 101;
export const STATUS_BAD_REQUEST = 400;
/** 访问控制拒绝：客户端 IP 名单或目标名单命中（与 407「缺凭证」语义区分，客户端不应重试带凭证） */
export const STATUS_FORBIDDEN = 403;
export const STATUS_PROXY_AUTH_REQUIRED = 407;
export const STATUS_BAD_GATEWAY = 502;
export const STATUS_GATEWAY_TIMEOUT = 504;

// ── 默认端口 ──

export const DEFAULT_PORT_HTTP = 80;
export const DEFAULT_PORT_HTTPS = 443;

// ── 代理头与鉴权 scheme ──

/**
 * 响应头名 `Proxy-Authenticate`，407 挑战头字段名。
 * 与普通 `WWW-Authenticate` 区分：代理层专用。
 */
export const HEADER_NAME_PROXY_AUTHENTICATE = "Proxy-Authenticate";
/**
 * 407 挑战头值 `Basic realm="Proxy"`，告知客户端用 Basic 方案重带凭证。
 */
export const HEADER_PROXY_AUTHENTICATE = 'Basic realm="Proxy"';
/**
 * 请求头名 `Proxy-Authorization`，客户端携带代理凭证的首选头（RFC 7235）。
 * Token 提取器优先读此头，`Authorization` 仅作回退。
 */
export const HEADER_NAME_PROXY_AUTHORIZATION = "Proxy-Authorization";
/**
 * 请求头名 `Proxy-Connection`，代理逐跳头，转发前必须剥离，不透传上游。
 */
export const HEADER_NAME_PROXY_CONNECTION = "Proxy-Connection";
/**
 * 代理头名前缀小写形态 `"proxy-"`，供 `toLowerCase().startsWith` 剥离代理头用。
 * websocket 透传与通用净化均走此前缀，避免手写字面量。
 */
export const HEADER_PREFIX_PROXY = "proxy-";
/**
 * 通用头名小写形态 `"host"`，供转小写后比对用（websocket Host 透传）。
 */
export const HEADER_NAME_HOST_LOWER = "host";
/**
 * 通用头名标题形态 `"Host"`，供拼装 CONNECT / upgrade 报文用。
 */
export const HEADER_NAME_HOST_TITLE = "Host";
/**
 * 通用头名小写形态 `"connection"`，出站净化强制 `close` 用。
 */
export const HEADER_NAME_CONNECTION = "connection";
/**
 * 通用头值 `"close"`，禁用上游长连接时写入 `connection` 头。
 */
export const HEADER_VALUE_CLOSE = "close";
/**
 * Basic 鉴权 scheme 前缀（含尾空格 `"Basic "`），供 startsWith/slice 切分凭证用。
 * 注意尾空格是语义的一部分，改动会破坏解析。
 */
export const AUTH_SCHEME_BASIC = "Basic ";
/**
 * Bearer 鉴权 scheme 前缀（含尾空格 `"Bearer "`），供 startsWith/slice 切分 token 用。
 * 注意尾空格是语义的一部分，改动会破坏解析。
 */
export const AUTH_SCHEME_BEARER = "Bearer ";

// ── 预拼完整响应报文（直接 socket.write） ──

/**
 * 完整 200 响应报文（`HTTP/1.1 200 Connection Established` + 空行）。
 * CONNECT 隧道建连成功时回写，由 STATUS_OK 派生，不手写 200 字面量。
 */
export const HTTP_200_CONNECTION_ESTABLISHED = `${STATUS_LINE_PREFIX}${STATUS_OK} ${REASON_CONNECTION_ESTABLISHED}${DOUBLE_CRLF}`;
/**
 * 完整 400 响应报文，目标 URL 非法等畸形请求时回写。
 */
export const HTTP_400_BAD_REQUEST = `${STATUS_LINE_PREFIX}${STATUS_BAD_REQUEST} ${REASON_BAD_REQUEST}${DOUBLE_CRLF}`;
/**
 * 完整 403 响应报文，访问控制拒绝（客户端 IP 名单 / 目标名单）时回写。
 * 用 403 而非 407：名单拒绝与「缺凭证」语义无关，回 407 会诱导客户端重试带凭证。
 */
export const HTTP_403_FORBIDDEN = `${STATUS_LINE_PREFIX}${STATUS_FORBIDDEN} ${REASON_FORBIDDEN}${DOUBLE_CRLF}`;
/**
 * 完整 407 响应报文，唯一带头字段的预拼报文。
 * 结构：状态行 + `Proxy-Authenticate: Basic realm="Proxy"` + 空行；
 * 鉴权失败时回写（http 通道经 writeHead 另行组装，tunnel/upgrade 通道直接写本串）。
 */
export const HTTP_407_PROXY_AUTH_REQUIRED = `${STATUS_LINE_PREFIX}${STATUS_PROXY_AUTH_REQUIRED} ${REASON_PROXY_AUTH_REQUIRED}${CRLF}${HEADER_NAME_PROXY_AUTHENTICATE}: ${HEADER_PROXY_AUTHENTICATE}${DOUBLE_CRLF}`;
/**
 * 完整 504 响应报文，上游拨号/响应超时（upstreamTimeout）时回写。
 */
export const HTTP_504_GATEWAY_TIMEOUT = `${STATUS_LINE_PREFIX}${STATUS_GATEWAY_TIMEOUT} ${REASON_GATEWAY_TIMEOUT}${DOUBLE_CRLF}`;
/**
 * 完整 502 响应报文，上游不可达或返回异常时回写。
 */
export const HTTP_502_BAD_GATEWAY = `${STATUS_LINE_PREFIX}${STATUS_BAD_GATEWAY} ${REASON_BAD_GATEWAY}${DOUBLE_CRLF}`;
