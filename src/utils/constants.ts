/**
 * 协议常量中心 - HTTP / SOCKS 魔术字符串与数字的唯一收敛点
 * 职责：
 * - 收敛报文分隔符（CRLF）、版本、状态码、原因短语、头名/头值、鉴权 scheme
 * - 预拼完整响应报文（HTTP_*），调用方直接 socket.write，不手写状态行
 * - 预置 SOCKS4/5 二进制应答 Buffer，避免热路径重复 Buffer.from
 * 约束：零依赖纯值定义，禁止从其他模块 import；新增魔术值只加这里，
 *       不在 core/ 等调用点手写字面量。
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
/**
 * 原因短语 `Switching Protocols`，用于 WebSocket upgrade 握手成功（101）。
 */
export const REASON_SWITCHING_PROTOCOLS = "Switching Protocols";
export const REASON_BAD_REQUEST = "Bad Request";
export const REASON_PROXY_AUTH_REQUIRED = "Proxy Authentication Required";
export const REASON_BAD_GATEWAY = "Bad Gateway";
export const REASON_GATEWAY_TIMEOUT = "Gateway Timeout";
export const REASON_INTERNAL_SERVER_ERROR = "Internal Server Error";

// ── 状态码数字 ──

export const STATUS_OK = 200;
export const STATUS_SWITCHING_PROTOCOLS = 101;
export const STATUS_BAD_REQUEST = 400;
export const STATUS_PROXY_AUTH_REQUIRED = 407;
export const STATUS_BAD_GATEWAY = 502;
export const STATUS_GATEWAY_TIMEOUT = 504;
export const STATUS_INTERNAL_ERROR = 500;

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
/**
 * 400 响应体 `Bad Request: invalid target URL`，目标 URL 非法时的说明正文。
 * 由 REASON_BAD_REQUEST 派生，保持原因短语与正文前缀一致。
 */
export const BODY_BAD_REQUEST = `${REASON_BAD_REQUEST}: invalid target URL`;

// ── 预拼完整响应报文（直接 socket.write） ──

/**
 * 完整 101 响应报文（状态行 + 空行，无消息体）。
 * WebSocket upgrade 握手成功时直接回写客户端。
 */
export const HTTP_101_SWITCHING_PROTOCOLS = `${STATUS_LINE_PREFIX}${STATUS_SWITCHING_PROTOCOLS} ${REASON_SWITCHING_PROTOCOLS}${DOUBLE_CRLF}`;
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
/**
 * 完整 500 响应报文，代理内部兜底错误时回写。
 */
export const HTTP_500_INTERNAL_ERROR = `${STATUS_LINE_PREFIX}${STATUS_INTERNAL_ERROR} ${REASON_INTERNAL_SERVER_ERROR}${DOUBLE_CRLF}`;
/** 包一层函数而非直引常量：隔离调用点与预拼串，留动态拼装余地。 */
export function build407Response(): string {
  return HTTP_407_PROXY_AUTH_REQUIRED;
}

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
 * CLI 键归一：去前导横杠（`/^-+/`），`--port` => `port` 用。
 * loader parseRawArgv 三处复用，收敛避免各写各的。
 */
export const RE_LEADING_DASHES = /^-+/;
/**
 * CLI 键归一：横杠转下划线全局替换（`/-/g` => `"_"`），`--proxy-protocol` => `PROXY_PROTOCOL` 用。
 */
export const RE_DASH_GLOBAL = /-/g;
/**
 * 纯数字端口校验（`/^\d+$/`），Host 头端口段合法性判定用。
 * 用例：`example.com:8080` => `8080` 合法
 */
export const RE_DIGITS = /^\d+$/;
/**
 * ANSI 转义序列全局清理（`/\x1b\[[0-9;]*m/g`），banner 非 TTY / NO_COLOR 时剥色用。
 * 显示层唯一正则，收敛至此避免 banner 内联编译。
 */
// eslint-disable-next-line no-control-regex
export const RE_ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

// ── SOCKS 协议常量（避免每次 Buffer.from 解析开销，常量复用） ──

// 版本号
/**
 * SOCKS5 协议版本号字节 `0x05`，握手与应答报文的 VER 字段。
 */
export const SOCKS5_VERSION = 0x05;
/**
 * SOCKS4 协议版本号字节 `0x04`，请求与应答报文的 VN 字段。
 */
export const SOCKS4_VERSION = 0x04;
/** SOCKS4 空字节 `0x00`（USERID/DOMAIN 终止） */
export const SOCKS4_NULL = 0x00;
/** SOCKS4/5 CONNECT 命令 `0x01` */
export const SOCKS_CMD_CONNECT = 0x01;
/** SOCKS5 子协商版本 `0x01`（用户名/密码） */
export const SOCKS5_AUTH_VERSION = 0x01;
/** SOCKS5 方法：`0x00` 无需认证 */
export const SOCKS5_METHOD_NO_AUTH = 0x00;
/** SOCKS5 方法：`0x02` 用户名/密码 */
export const SOCKS5_METHOD_USER_PASS = 0x02;
/** SOCKS5 方法：`0xFF` 无可接受方法 */
export const SOCKS5_METHOD_REJECT = 0xff;
/** SOCKS5 地址类型：`0x01` IPv4 */
export const SOCKS5_ATYP_IPV4 = 0x01;
/** SOCKS5 地址类型：`0x03` 域名 */
export const SOCKS5_ATYP_DOMAIN = 0x03;
/** SOCKS5 地址类型：`0x04` IPv6（暂不支持） */
export const SOCKS5_ATYP_IPV6 = 0x04;
/** SOCKS5 应答：`0x00` 成功 */
export const SOCKS5_REP_SUCCESS = 0x00;
/** SOCKS5 应答：`0x01` 通用失败 */
export const SOCKS5_REP_FAILURE = 0x01;
/** SOCKS4 应答 VN `0x00`（固定） */
export const SOCKS4_REPLY_VN = 0x00;
/** SOCKS4 应答 CD `0x5A` 允许 */
export const SOCKS4_REPLY_GRANTED = 0x5a;
/** SOCKS4a 伪 IP `0.0.0.1`（4 字节） */
export const SOCKS4A_FAKE_IP = [0x00, 0x00, 0x00, 0x01] as const;
/**
 * SOCKS5 服务端选鉴响应 `[0x05, 0x00]`（VER=5，METHOD=0x00 无需认证）。
 * 无认证放行时回写客户端。
 */
export const SOCKS5_NO_AUTH = Buffer.from([0x05, 0x00]);
/**
 * SOCKS5 客户端握手请求模板 `[0x05, 0x01, 0x00]`
 * （VER=5，NMETHODS=1，METHODS=0x00 无需认证），按需构造/回放用。
 */
export const SOCKS5_HANDSHAKE_REQ = Buffer.from([0x05, 0x01, 0x00]);
/**
 * SOCKS5 选鉴拒绝 `[0x05, 0xFF]`（无可接受的认证方法）。
 * 鉴权失败时回写并销毁连接。
 */
export const SOCKS5_AUTH_REJECT = Buffer.from([0x05, 0xff]);
/**
 * SOCKS5 服务端选鉴响应 `[0x05, 0x02]`（VER=5，METHOD=0x02 用户名/密码）。
 * 鉴权启用时回写，要求客户端走 RFC1929 子协商。
 */
export const SOCKS5_SELECT_USERPASS = Buffer.from([0x05, 0x02]);
/**
 * SOCKS5 子协商成功 `[0x01, 0x00]`（VER=1，STATUS=0x00 成功）。
 * 用户名/密码校验通过时回写。
 */
export const SOCKS5_AUTH_SUCCESS = Buffer.from([0x01, 0x00]);
/**
 * SOCKS5 子协商失败 `[0x01, 0x01]`（VER=1，STATUS=0x01 失败）。
 * 用户名/密码校验失败或报文非法时回写。
 */
export const SOCKS5_AUTH_FAILURE = Buffer.from([0x01, 0x01]);
/**
 * SOCKS5 成功应答（10 字节 IPv4 形态）：
 * `[VER=0x05, REP=0x00 成功, RSV, ATYP=0x01 IPv4, BND.ADDR×4 全零, BND.PORT×2 全零]`。
 * BND 字段填零表示不回传真实绑定地址。
 */
export const SOCKS5_REPLY_SUCCESS = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
/**
 * SOCKS5 失败应答（10 字节 IPv4 形态）：
 * `[VER=0x05, REP=0x01 通用失败, RSV, ATYP=0x01 IPv4, BND.ADDR×4 全零, BND.PORT×2 全零]`。
 */
export const SOCKS5_REPLY_FAILURE = Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
/**
 * SOCKS4 成功应答（8 字节）：`[VN=0x00, CD=0x5A 请求允许, DSTPORT×2, DSTIP×4]`。
 * 端口/IP 填零（本代理不回传真实绑定地址）。
 */
export const SOCKS4_REPLY_SUCCESS = Buffer.from([0x00, 0x5a, 0, 0, 0, 0, 0, 0]);
/**
 * SOCKS4 失败应答（8 字节）：`[VN=0x00, CD=0x5B 请求拒绝, DSTPORT×2, DSTIP×4]`。
 * 鉴权失败时回写并销毁连接。
 */
export const SOCKS4_REPLY_FAILURE = Buffer.from([0x00, 0x5b, 0, 0, 0, 0, 0, 0]);
