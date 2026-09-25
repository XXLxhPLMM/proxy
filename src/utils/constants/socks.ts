/**
 * @fileoverview 协议常量中心 - SOCKS4/5 协议字节与预置应答 Buffer（socks.ts）
 *
 * 职责清单：
 * - 版本号、命令字、子协商版本、认证方法、地址类型、应答码等协议字节
 * - 预置应答 Buffer（选鉴 / 子协商 / 成功 / 失败），避免热路径重复 `Buffer.from`
 * - 固定长度字段的字节数，供按长度读满上游应答（可能跨 TCP 分段）
 *
 * 约束：零依赖纯值定义，禁止从其他模块 import；应答 Buffer 一律模块级常量，
 *       调用点不得就地 `Buffer.from` 字面量。
 */

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
/** SOCKS5 地址类型：`0x01` IPv4 */
export const SOCKS5_ATYP_IPV4 = 0x01;
/** SOCKS5 地址类型：`0x03` 域名 */
export const SOCKS5_ATYP_DOMAIN = 0x03;
/** SOCKS5 地址类型：`0x04` IPv6（16 字节 + 2 字节端口，由 `readSocks5Request` 解析） */
export const SOCKS5_ATYP_IPV6 = 0x04;
/** SOCKS5 应答：`0x00` 成功 */
export const SOCKS5_REP_SUCCESS = 0x00;
/** SOCKS4 应答 VN `0x00`（固定） */
export const SOCKS4_REPLY_VN = 0x00;
/** SOCKS4 应答 CD `0x5A` 允许 */
export const SOCKS4_REPLY_GRANTED = 0x5a;
/** SOCKS4a 伪 IP `0.0.0.1`（4 字节） */
export const SOCKS4A_FAKE_IP = [0x00, 0x00, 0x00, 0x01] as const;

// 预置应答 Buffer
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

// 固定长度字段的字节数
/**
 * SOCKS4 CONNECT 应答字节数（VN + CD + DSTPORT×2 + DSTIP×4）。
 * 上游应答须按此长度读满（可能跨 TCP 分段），余量回灌 socket。
 */
export const SOCKS4_REPLY_BYTES = 8;
/**
 * SOCKS5 方法协商应答字节数（VER + METHOD）。
 */
export const SOCKS5_METHOD_REPLY_BYTES = 2;
/**
 * SOCKS5 CONNECT 应答固定头字节数（VER + REP + RSV + ATYP），其后按 ATYP 追加地址与端口。
 */
export const SOCKS5_REPLY_HEAD_BYTES = 4;
