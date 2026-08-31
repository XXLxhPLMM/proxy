/**
 * 通用常量 - 跨层共享的纯值定义，零依赖
 * 职责：
 * - 代理响应行（CONNECT 隧道手写报文）等硬编码字符串统一收敛，避免魔法字符串散落于 core
 * - 归属 utils 而非 core：core 聚焦状态机/ProxyCore 领域逻辑，utils 承载可被任意层复用的纯常量
 * 使用：import { HTTP_200_CONNECTION_ESTABLISHED } from "../utils/constants.js"
 */

/** 隧道建立成功：告知客户端可开始透传 */
export const HTTP_200_CONNECTION_ESTABLISHED = "HTTP/1.1 200 Connection Established\r\n\r\n";

/** 非法请求：authority 解析失败或 CONNECT 格式错误 */
export const HTTP_400_BAD_REQUEST = "HTTP/1.1 400 Bad Request\r\n\r\n";

/** 鉴权失败：Proxy-Authorization 缺失或校验未通过（隧道需带 Proxy-Authenticate 以触发浏览器弹窗） */
export const HTTP_407_PROXY_AUTH_REQUIRED =
  'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Proxy"\r\n\r\n';

/** 上游超时：CONNECT 拨号超时 */
export const HTTP_504_GATEWAY_TIMEOUT = "HTTP/1.1 504 Gateway Timeout\r\n\r\n";

/** 上游不可达 */
export const HTTP_502_BAD_GATEWAY = "HTTP/1.1 502 Bad Gateway\r\n\r\n";

/** 代理内部错误 */
export const HTTP_500_INTERNAL_ERROR = "HTTP/1.1 500 Internal Server Error\r\n\r\n";

// ── 状态码数值常量（供 res.writeHead 使用，避免魔法数字） ──
export const STATUS_BAD_REQUEST = 400;
export const STATUS_PROXY_AUTH_REQUIRED = 407;
export const STATUS_BAD_GATEWAY = 502;
export const STATUS_GATEWAY_TIMEOUT = 504;
export const STATUS_INTERNAL_ERROR = 500;
export const STATUS_FALLBACK_BAD_GATEWAY = 502;

// ── 响应体常量（供 res.end 使用） ──
export const BODY_BAD_REQUEST = "Bad Request: invalid target URL";
export const BODY_PROXY_AUTH_REQUIRED = "Proxy Authentication Required";
export const BODY_BAD_GATEWAY = "Bad Gateway";
export const BODY_GATEWAY_TIMEOUT = "Gateway Timeout";
export const BODY_PROXY_ERROR = "Proxy Error";
export const HEADER_PROXY_AUTHENTICATE = 'Basic realm="Proxy"';

/**
 * 按状态码获取对应常量（便于按需扩展）
 * 若无匹配则回退为通用 500
 */
export function httpStatusLine(status: number): string {
  switch (status) {
    case 200:
      return HTTP_200_CONNECTION_ESTABLISHED;
    case 400:
      return HTTP_400_BAD_REQUEST;
    case 407:
      return HTTP_407_PROXY_AUTH_REQUIRED;
    case 504:
      return HTTP_504_GATEWAY_TIMEOUT;
    default:
      return `HTTP/1.1 ${status} \r\n\r\n`;
  }
}
