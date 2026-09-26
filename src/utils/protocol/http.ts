/**
 * HTTP 协议常量中心 - 报文分隔符/状态行/头名/预拼响应的唯一收敛点
 * 职责：
 * - 收敛报文分隔符（CRLF）、版本、状态码、原因短语、头名/头值、鉴权 scheme
 * - 预拼完整响应报文（HTTP_*），调用方直接 socket.write，不手写状态行
 * - 目标主机校验白名单与缓冲/长度上限（安全边界）
 * 约束：零依赖纯值定义，禁止从其他模块 import；新增魔术值只加这里，
 *       不在 core/ 等调用点手写字面量。
 * 兄弟模块：SOCKS4/5 的字节常量与应答构造在 `socks.ts`（同为零依赖纯值）。
 * 非协议值不归这里：日志净化在 `log/text.ts`、CLI 参数归一在 `config/source/argv.ts`、
 * 终端色码清理在 `server/banner.ts`、JSONL 落盘在 `log/level.ts`。
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
 */
export const STATUS_LINE_PREFIX = `${HTTP_VERSION} `;

// ── 原因短语 ──

/**
 * 原因短语 `Connection Established`，用于 CONNECT 隧道建连成功（200）。
 */
export const REASON_CONNECTION_ESTABLISHED = "Connection Established";
export const REASON_BAD_REQUEST = "Bad Request";
/** 原因短语 `Forbidden`，访问控制（客户端 IP / 目标名单）拒绝时回写 */
export const REASON_FORBIDDEN = "Forbidden";
export const REASON_PROXY_AUTH_REQUIRED = "Proxy Authentication Required";
export const REASON_BAD_GATEWAY = "Bad Gateway";
export const REASON_GATEWAY_TIMEOUT = "Gateway Timeout";

// ── 状态码数字 ──

export const STATUS_OK = 200;
/** 101 Switching Protocols：websocket upgrade 成功判定（websocket.ts 自行拼报文，不预拼） */
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
/**
 * 拼装 `Proxy-Authorization` 请求头值。
 * @param b64 - `user:password` 的 base64 编码（不含 scheme 前缀）
 * @returns 完整头值，形如 `"Basic dXNlcjpwYXNz"`
 */
export function buildProxyAuthValue(b64: string): string {
  return `${AUTH_SCHEME_BASIC}${b64}`;
}

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

// ── 预编译正则 ──

/**
 * 绝对 URL 判定正则（`/^https?:\/\//i`，大小写不敏感）。
 * server 模式下判断请求行 target 是否为 absolute-form（`http://host/...`）；
 * client 模式不走此分支。注意仅匹配 http/https scheme。
 */
export const RE_ABSOLUTE_URL = /^https?:\/\//i;
/**
 * 上游 HTTP 状态行提取正则（`/HTTP\/\d\.\d\s+(\d+)/`）。
 * 隧道首包仅需状态码，body 交管道透传；捕获组 [1] 为三位码。
 * 用例：`HTTP/1.1 200 Connection Established` => `200`
 */
export const RE_HTTP_STATUS_LINE = /HTTP\/\d\.\d\s+(\d+)/;
/**
 * RFC7239 Forwarded 头 for 参数提取（`/for=([^;,\s]+)/i`，大小写不敏感）。
 * 取 `;` / `,` / 空白为止，去引号后即客户端 IP（含 quoted-string 兼容）。
 * 用例：`for=192.0.2.43, for="[2001:db8::1]"` => `192.0.2.43`
 */
export const RE_FORWARDED_FOR = /for=([^;,\s]+)/i;
/**
 * 双引号全局清理（`/"+/g`），供 Forwarded quoted-string 去引号用。
 */
export const RE_QUOTE_GLOBAL = /"/g;
/**
 * base64url 转 base64：横杠全局替换（`/-/g` => `"+"`），JWT payload 解码前归一用。
 */
export const RE_BASE64URL_DASH = /-/g;
/**
 * base64url 转 base64：下划线全局替换（`/_/g` => `"/"`），JWT payload 解码前归一用。
 */
export const RE_BASE64URL_UNDERSCORE = /_/g;
/**
 * 严格 base64 字符集校验（`/^[A-Za-z0-9+/=]+$/`）。
 * Basic 令牌先验字符集再解码，避免误解明文 `user:pass`。
 */
export const RE_BASE64_STRICT = /^[A-Za-z0-9+/=]+$/;
/**
 * 纯数字端口校验（`/^\d+$/`），Host 头端口段合法性判定用。
 * 用例：`example.com:8080` => `8080` 合法
 */
export const RE_DIGITS = /^\d+$/;

// ── 安全边界常量（目标主机校验 / 缓冲上限） ──

/**
 * 目标主机长度上限（字节）：SOCKS5 域名地址由 1 字节长度域承载（RFC1928 §5），
 * 超过即拒绝——否则 `Buffer.from([...hostBuf.length])` 会按 256 取模截断（256 → 0）导致协议失步。
 * 与 {@link RE_VALID_TARGET_HOST} 同属 `isValidTargetHost` 这一处判定，不许拆开用。
 */
export const MAX_TARGET_HOST_BYTES = 255;
/**
 * 目标主机字符白名单（主机名 / IPv4 / IPv6 含方括号与 %zone）。
 * 采用白名单而非黑名单：任何 CRLF、空白、控制字符、`/`、`@`、`?` 一律判非法，
 * 杜绝对 CONNECT 请求行/头、SOCKS 请求报文的注入（SOCKS 侧主机名不经过 HTTP 解析器）。
 */
export const RE_VALID_TARGET_HOST = /^[-A-Za-z0-9._:%[\]]+$/;
/**
 * 等待上游状态行（HTTP 响应头）时的缓冲上限（字节）。
 * 恶意/异常上游只发数据不发 `\r\n\r\n` 时，仅靠 upstreamTimeout 兜不住内存增长，按字节数封顶。
 */
export const MAX_STATUS_LINE_BYTES = 16 * 1024;
