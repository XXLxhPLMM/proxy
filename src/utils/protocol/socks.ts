/**
 * SOCKS4/4a/5 协议常量中心 - 字节值与应答构造的唯一收敛点
 * 职责：
 * - 版本号、方法、地址类型、应答码等字节常量（预置 Buffer，避免热路径重复 Buffer.from）
 * - 预拼失败应答；成功应答按「逐连接取实际绑定地址」逐条构造
 * 约束：零依赖纯值定义，禁止从其他模块 import；core 不手写偏移与字节布局。
 * 兄弟模块：HTTP 侧的报文常量在 `http.ts`。
 */

// ── 版本号 ──

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

// ── 预置应答 Buffer ──

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
 * SOCKS5 选鉴拒绝 `[0x05, 0xFF]`（METHOD=`0xFF` 无可接受的认证方法，RFC1928 §3）。
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
 * SOCKS5 失败应答（10 字节 IPv4 形态）：
 * `[VER=0x05, REP=0x01 通用失败, RSV, ATYP=0x01 IPv4, BND.ADDR×4 全零, BND.PORT×2 全零]`。
 * 失败应答按 RFC1928 §6 不要求 BND 字段，恒为全零。
 */
export const SOCKS5_REPLY_FAILURE = Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
/**
 * SOCKS4 失败应答（8 字节）：`[VN=0x00, CD=0x5B 请求拒绝, DSTPORT×2, DSTIP×4]`。
 * 鉴权失败时回写并销毁连接。
 */
export const SOCKS4_REPLY_FAILURE = Buffer.from([0x00, 0x5b, 0, 0, 0, 0, 0, 0]);

/**
 * SOCKS5 成功应答固定头（4 字节）：`[VER, REP=0x00, RSV, ATYP=0x01]`；其后紧跟 4 字节 BND.ADDR + 2 字节大端 BND.PORT。
 * 成功应答不再预拼成常量：BND 字段逐连接取实际绑定地址，见 {@link buildSocks5ReplySuccess}。
 */
const SOCKS5_REPLY_SUCCESS_HEAD = Buffer.from([0x05, 0x00, 0x00, 0x01]);

/**
 * 构造 SOCKS5 成功应答，BND 字段填服务端实际绑定地址（RFC1928 §6 / RFC1925 §3）
 * @description ATYP **恒为 0x01（IPv4）**，BND.ADDR 因此恒 4 字节、BND.PORT 恒 2 字节大端，
 * 总长恒 10 字节（字段偏移：地址 4..7、端口 8..9）——ATYP 改 IPv6 会变成 22 字节，客户端按 10 字节
 * 定长读取时会把隧道首个字节当成应答尾巴，因此不引入 IPv6 应答形态。
 * 真 IPv6 绑定地址由调用方归一/回退后传 undefined（回退 `0.0.0.0:0`）。
 * @param boundAddress - 4 字节 IPv4 绑定地址；缺省/长度不符则回退全零
 * @param boundPort - 绑定端口（0..65535）；缺省/非法则回退 0
 */
export function buildSocks5ReplySuccess(boundAddress?: Buffer, boundPort?: number): Buffer {
  return Buffer.concat([
    SOCKS5_REPLY_SUCCESS_HEAD,
    boundAddress?.length === 4 ? boundAddress : Buffer.alloc(4),
    boundPortBytes(boundPort),
  ]);
}

/**
 * 构造 SOCKS4 成功应答，地址/端口字段填服务端实际绑定地址
 * @description 布局与既有 8 字节形态严格一致：`[VN=0x00, CD=0x5A, DSTPORT×2, DSTIP×4]`
 * （字段偏移：端口 2..3、地址 4..7）。SOCKS4 无地址族字段，真 IPv6 绑定地址无处可填，
 * 由调用方回退 `0.0.0.0:0`。
 * @param boundAddress - 4 字节 IPv4 绑定地址；缺省/长度不符则回退全零
 * @param boundPort - 绑定端口（0..65535）；缺省/非法则回退 0
 */
export function buildSocks4ReplySuccess(boundAddress?: Buffer, boundPort?: number): Buffer {
  return Buffer.concat([
    Buffer.from([SOCKS4_REPLY_VN, SOCKS4_REPLY_GRANTED]),
    boundPortBytes(boundPort),
    boundAddress?.length === 4 ? boundAddress : Buffer.alloc(4),
  ]);
}

/** 端口 → 2 字节大端；非整数/越界一律回退 0（应答字段永不抛错） */
function boundPortBytes(boundPort?: number): Buffer {
  return Number.isInteger(boundPort) && boundPort! >= 0 && boundPort! <= 0xffff
    ? Buffer.from([(boundPort! >> 8) & 0xff, boundPort! & 0xff])
    : Buffer.from([0, 0]);
}

// ── 报文长度常量 ──

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
