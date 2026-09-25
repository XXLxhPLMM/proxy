/**
 * @fileoverview 协议常量中心 - 安全边界上限与字符白名单（limits.ts）
 *
 * 职责清单：
 * - 目标主机长度上限与字符白名单（主机名 / IPv4 / IPv6 / %zone）
 * - 等待上游响应头时的缓冲字节上限
 * - 日志文本控制字符净化正则
 *
 * 约束：这里的每个值都是**拒绝线**而非调优参数——改动前先确认对应拒绝路径
 *       （SOCKS 长度域截断、上游不发 `\r\n\r\n`、线数据伪造日志/注入终端转义）。
 */

/**
 * 目标主机长度上限（字节）：SOCKS5 域名地址由 1 字节长度域承载（RFC1928 §5），
 * 超过即拒绝——否则 `Buffer.from([...hostBuf.length])` 会按 256 取模截断（256 → 0）导致协议失步。
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
/**
 * 日志文本控制字符（C0 控制符 + DEL），落盘/控制台前转义：
 * 客户端可控字节（SOCKS 域名/USERID、Host 头、X-Forwarded-For）含 `\n` 可伪造日志条目，
 * 含 ESC 可注入终端转义序列。
 */
// eslint-disable-next-line no-control-regex
export const RE_LOG_CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
