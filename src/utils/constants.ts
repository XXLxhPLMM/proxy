/**
 * 通用常量 - 跨层共享的纯值定义，零依赖
 * 职责：
 * - 协议分隔符、状态行前缀、原因短语、代理响应报文等硬编码字符串统一收敛，避免魔法字符串散落于 core
 * - 归属 utils 而非 core：core 聚焦状态机/ProxyCore 领域逻辑，utils 承载可被任意层复用的纯常量
 * 使用：import { HTTP_200_CONNECTION_ESTABLISHED } from "../utils/constants.js"
 */

// ── 协议分隔符常量（避免魔法字符串散落，置于最前供后续响应常量引用） ──
export const CRLF = "\r\n";
export const DOUBLE_CRLF = `${CRLF}${CRLF}`;
export const DOUBLE_CRLF_BUF = Buffer.from(DOUBLE_CRLF);

// ── HTTP 版本与状态行基础片段（所有手写报文共用） ──
export const HTTP_VERSION = "HTTP/1.1";
/** 状态行前缀，如 `HTTP/1.1 407 ...` */
export const STATUS_LINE_PREFIX = `${HTTP_VERSION} `;

// ── 状态原因短语（reason phrase，响应行与响应体共用） ──
export const REASON_CONNECTION_ESTABLISHED = "Connection Established";
export const REASON_BAD_REQUEST = "Bad Request";
export const REASON_PROXY_AUTH_REQUIRED = "Proxy Authentication Required";
export const REASON_BAD_GATEWAY = "Bad Gateway";
export const REASON_GATEWAY_TIMEOUT = "Gateway Timeout";
export const REASON_INTERNAL_SERVER_ERROR = "Internal Server Error";

// ── 状态码数值常量（供 res.writeHead 使用，避免魔法数字） ──
export const STATUS_BAD_REQUEST = 400;
export const STATUS_PROXY_AUTH_REQUIRED = 407;
export const STATUS_BAD_GATEWAY = 502;
export const STATUS_GATEWAY_TIMEOUT = 504;
export const STATUS_INTERNAL_ERROR = 500;
export const STATUS_FALLBACK_BAD_GATEWAY = 502;

// ── 响应头名 / 响应头值 / 响应体常量（供 res.writeHead / res.end 及手写报文复用） ──
export const HEADER_NAME_PROXY_AUTHENTICATE = "Proxy-Authenticate";
export const HEADER_PROXY_AUTHENTICATE = "Basic realm=\"Proxy\"";
export const BODY_BAD_REQUEST = `${REASON_BAD_REQUEST}: invalid target URL`;
export const BODY_PROXY_ERROR = "Proxy Error";

// ── 完整响应报文常量（由上述基础片段拼装） ──

/** 隧道建立成功：告知客户端可开始透传 */
export const HTTP_200_CONNECTION_ESTABLISHED = `${STATUS_LINE_PREFIX}200 ${REASON_CONNECTION_ESTABLISHED}${DOUBLE_CRLF}`;

/** 非法请求：authority 解析失败或 CONNECT 格式错误 */
export const HTTP_400_BAD_REQUEST = `${STATUS_LINE_PREFIX}${STATUS_BAD_REQUEST} ${REASON_BAD_REQUEST}${DOUBLE_CRLF}`;

/** 鉴权失败：Proxy-Authorization 缺失或校验未通过（隧道需带 Proxy-Authenticate 以触发浏览器弹窗） */
export const HTTP_407_PROXY_AUTH_REQUIRED = `${STATUS_LINE_PREFIX}${STATUS_PROXY_AUTH_REQUIRED} ${REASON_PROXY_AUTH_REQUIRED}${CRLF}${HEADER_NAME_PROXY_AUTHENTICATE}: ${HEADER_PROXY_AUTHENTICATE}${DOUBLE_CRLF}`;

/** 上游超时：CONNECT 拨号超时 */
export const HTTP_504_GATEWAY_TIMEOUT = `${STATUS_LINE_PREFIX}${STATUS_GATEWAY_TIMEOUT} ${REASON_GATEWAY_TIMEOUT}${DOUBLE_CRLF}`;

/** 上游不可达 */
export const HTTP_502_BAD_GATEWAY = `${STATUS_LINE_PREFIX}${STATUS_BAD_GATEWAY} ${REASON_BAD_GATEWAY}${DOUBLE_CRLF}`;

/** 代理内部错误 */
export const HTTP_500_INTERNAL_ERROR = `${STATUS_LINE_PREFIX}${STATUS_INTERNAL_ERROR} ${REASON_INTERNAL_SERVER_ERROR}${DOUBLE_CRLF}`;

/**
 * 构造完整 407 原始 HTTP 响应
 * - socket 场景：直接 socket.write(build407Response())
 * - res 场景：res.writeHead(407, headers) + res.end(body)，body 从响应中提取
 */
export function build407Response(): string {
  return HTTP_407_PROXY_AUTH_REQUIRED;
}

// ── 预编译正则（避免运行时重复编译） ──
export const RE_HTTP_STATUS = /HTTP\/\d\.\d\s+(\d+)/;
export const RE_CONNECT = /^CONNECT\s+(\S+)\s+HTTP\/\d/;
export const RE_HTTP_METHOD = /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|TRACE)\s+(\S+)\s+HTTP\/\d/;
export const RE_ABSOLUTE_URL = /^https?:\/\//i;
