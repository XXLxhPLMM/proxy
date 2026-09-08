export const CRLF = "\r\n";
export const DOUBLE_CRLF = `${CRLF}${CRLF}`;
export const DOUBLE_CRLF_BUF = Buffer.from(DOUBLE_CRLF);

export const HTTP_VERSION = "HTTP/1.1";
export const STATUS_LINE_PREFIX = `${HTTP_VERSION} `;

export const REASON_CONNECTION_ESTABLISHED = "Connection Established";
export const REASON_SWITCHING_PROTOCOLS = "Switching Protocols";
export const REASON_BAD_REQUEST = "Bad Request";
export const REASON_PROXY_AUTH_REQUIRED = "Proxy Authentication Required";
export const REASON_BAD_GATEWAY = "Bad Gateway";
export const REASON_GATEWAY_TIMEOUT = "Gateway Timeout";
export const REASON_INTERNAL_SERVER_ERROR = "Internal Server Error";

export const STATUS_SWITCHING_PROTOCOLS = 101;
export const STATUS_BAD_REQUEST = 400;
export const STATUS_PROXY_AUTH_REQUIRED = 407;
export const STATUS_BAD_GATEWAY = 502;
export const STATUS_GATEWAY_TIMEOUT = 504;
export const STATUS_INTERNAL_ERROR = 500;

export const DEFAULT_PORT_HTTP = 80;
export const DEFAULT_PORT_HTTPS = 443;

export const HEADER_NAME_PROXY_AUTHENTICATE = "Proxy-Authenticate";
export const HEADER_PROXY_AUTHENTICATE = 'Basic realm="Proxy"';
export const HEADER_NAME_PROXY_AUTHORIZATION = "Proxy-Authorization";
export const HEADER_NAME_PROXY_CONNECTION = "Proxy-Connection";
export const AUTH_SCHEME_BASIC = "Basic ";
export const AUTH_SCHEME_BEARER = "Bearer ";
export function buildProxyAuthValue(b64: string): string {
  return `${AUTH_SCHEME_BASIC}${b64}`;
}
export const BODY_BAD_REQUEST = `${REASON_BAD_REQUEST}: invalid target URL`;

export const HTTP_101_SWITCHING_PROTOCOLS = `${STATUS_LINE_PREFIX}${STATUS_SWITCHING_PROTOCOLS} ${REASON_SWITCHING_PROTOCOLS}${DOUBLE_CRLF}`;
export const HTTP_200_CONNECTION_ESTABLISHED = `${STATUS_LINE_PREFIX}200 ${REASON_CONNECTION_ESTABLISHED}${DOUBLE_CRLF}`;
export const HTTP_400_BAD_REQUEST = `${STATUS_LINE_PREFIX}${STATUS_BAD_REQUEST} ${REASON_BAD_REQUEST}${DOUBLE_CRLF}`;
export const HTTP_407_PROXY_AUTH_REQUIRED = `${STATUS_LINE_PREFIX}${STATUS_PROXY_AUTH_REQUIRED} ${REASON_PROXY_AUTH_REQUIRED}${CRLF}${HEADER_NAME_PROXY_AUTHENTICATE}: ${HEADER_PROXY_AUTHENTICATE}${DOUBLE_CRLF}`;
export const HTTP_504_GATEWAY_TIMEOUT = `${STATUS_LINE_PREFIX}${STATUS_GATEWAY_TIMEOUT} ${REASON_GATEWAY_TIMEOUT}${DOUBLE_CRLF}`;
export const HTTP_502_BAD_GATEWAY = `${STATUS_LINE_PREFIX}${STATUS_BAD_GATEWAY} ${REASON_BAD_GATEWAY}${DOUBLE_CRLF}`;
export const HTTP_500_INTERNAL_ERROR = `${STATUS_LINE_PREFIX}${STATUS_INTERNAL_ERROR} ${REASON_INTERNAL_SERVER_ERROR}${DOUBLE_CRLF}`;
export function build407Response(): string {
  return HTTP_407_PROXY_AUTH_REQUIRED;
}

export const RE_ABSOLUTE_URL = /^https?:\/\//i;

// ── SOCKS 协议常量（避免每次 Buffer.from 解析开销，常量复用） ──
export const SOCKS5_VERSION = 0x05;
export const SOCKS4_VERSION = 0x04;
export const SOCKS5_NO_AUTH = Buffer.from([0x05, 0x00]);
export const SOCKS5_HANDSHAKE_REQ = Buffer.from([0x05, 0x01, 0x00]);
export const SOCKS5_AUTH_REJECT = Buffer.from([0x05, 0xff]);
export const SOCKS5_REPLY_SUCCESS = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
export const SOCKS5_REPLY_FAILURE = Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
export const SOCKS4_REPLY_SUCCESS = Buffer.from([0x00, 0x5a, 0, 0, 0, 0, 0, 0]);
export const SOCKS4_REPLY_FAILURE = Buffer.from([0x00, 0x5b, 0, 0, 0, 0, 0, 0]);
