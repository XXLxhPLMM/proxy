/**
 * SOCKS 会话处理器 - 四个 SOCKS server 共用的 onConn 主体
 * 职责：
 * - 把 socks4/socks5/sockss4/sockss5 四份逐字重复的「握手解析 → 鉴权 → 委派转发」收敛为一处
 * - 以 SocksSessionHost 最小接口注入 server 能力（protocol/inbound/auth/authorize/replyAndClose），
 *   使会话逻辑不依赖具体 server 类，明文与 TLS 分支共用同一份逻辑
 * - 明文与 TLS 的差异只在 host.protocol（协议名）上体现，故 authority 由协议名拼装：
 *   socks4 系带 `${protocol} host:port` 后缀，socks5 系为裸协议名
 * 设计：
 * - 不持有连接状态（登记/销毁由 socks-base.ts 负责），纯编排
 * - **最小接口不含日志器**：会话层不打印也不定级，事实一律经 host 桥接的转发器事件槽上抛
 * - 失败收尾统一走 host.replyAndClose（桥接 writeReplyAndClose，写完延时销毁）
 * - socks5 的「无 token 审计」必须保留：客户端不支持 USER_PASS 时仍经 authorize 走 [auth] 审计
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { AuthContext, AuthResult, ProxyProtocol } from "@/core/types/proxy.js";
import type { AuthProvider } from "@/plugins/contracts.js";
import type { SocksInbound } from "@/core/forward/inbound/socks.js";
import type { SocksHandshakeReader } from "@/core/forward/inbound/socks-reader.js";
import { buildProxyAuthValue } from "@/utils/protocol/http.js";
import { getSocketAddress } from "@/utils/net/socket.js";
import {
  SOCKS4_REPLY_FAILURE,
  SOCKS5_AUTH_FAILURE,
  SOCKS5_AUTH_REJECT,
  SOCKS5_AUTH_SUCCESS,
  SOCKS5_METHOD_NO_AUTH,
  SOCKS5_METHOD_USER_PASS,
  SOCKS5_NO_AUTH,
  SOCKS5_SELECT_USERPASS,
} from "@/utils/protocol/socks.js";
import { encodeBasicCredentials } from "@/core/proxy-helpers.js";

/**
 * 会话宿主：把 server 骨架能力以最小接口注入会话处理器
 * @description 刻意**只给会话真正要用的四样能力 + 协议名**：会话不需要配置、日志、路由
 * 决策、访问控制（那些都已在入站适配器内部生效），更不需要生命周期句柄。多给一个字段就多一条
 * 绕过闸门的路，也把「会话逻辑不感知实例」这条边界稀释掉。
 * @param protocol - 本连接的协议标识（socks4/socks5/sockss4/sockss5），决定 authority 形态
 * @param inbound - 复用的 SOCKS 入站适配器（握手解析 + 路由编排 + SOCKS 二进制应答）
 * @param auth - 本实例那一个鉴权实现（`ProtocolDeps.auth`），读 isEnabled/kind 决定 SOCKS5 选鉴分支
 * @param authorize - 统一鉴权入口，桥接 BaseProxy.authorize（含 [auth] 审计转抛），返回含用户名的结果
 * @param replyAndClose - 回失败应答并延时销毁，桥接 writeReplyAndClose
 */
export interface SocksSessionHost {
  protocol: ProxyProtocol;
  inbound: SocksInbound;
  auth: AuthProvider;
  authorize(ctx: AuthContext): Promise<AuthResult>;
  /**
   * 账号级客户端名单闸门（**第二道**；第一道在 `socks-base.onConn` 握手前已判过全局名单）
   * @description 只能在鉴权之后调用——此刻才有身份。拒绝时**只能断链**：SOCKS5 的方法
   * 协商此刻已回过 `0x01 0x00`，再写 SOCKS reply 就是协议污染（客户端等的是 CONNECT 应答）。
   * 判定与 `ip-denied` 事实事件由基类 `BaseProxy.rejectByClientIp` 一处发出。
   * @param client - 客户端对端地址
   * @param user - 已鉴权用户名
   * @returns true 表示被拒（调用方应断链并 return）
   */
  rejectByClientIp(client: string, user: string | undefined): boolean;
  replyAndClose(socket: Duplex, reply: Buffer): void;
}

/**
 * 会话处理器：完成一次 SOCKS 会话（握手 → 鉴权 → 委派转发）
 */
export type SocksSessionRunner = (
  host: SocksSessionHost,
  socket: Duplex,
  reader: SocksHandshakeReader,
) => Promise<void>;

/**
 * SOCKS4/SOCKS4a 会话主体（socks4 与 sockss4 的 onConn 合并）
 * @description 解析请求（USERID 承载 token）→ 统一鉴权（authority 带 host:port）→
 * 解析/鉴权失败均回 SOCKS4_REPLY_FAILURE，成功交 inbound.serveSocks4 分派
 * @param host - 会话宿主
 * @param socket - 客户端双工流
 * @param reader - 共享握手读取器
 */
export async function runSocks4Session(
  host: SocksSessionHost,
  socket: Duplex,
  reader: SocksHandshakeReader,
): Promise<void> {
  /** 失败收尾：解绑读取器并回指定失败应答（桥接 writeReplyAndClose，写完延时销毁） */
  const fail = (reply: Buffer): void => {
    reader.dispose();
    host.replyAndClose(socket, reply);
  };

  const parsed = await host.inbound.parseSocks4(reader);

  if (!parsed) {
    fail(SOCKS4_REPLY_FAILURE);
    return;
  }

  const ok = await host.authorize({
    protocol: host.protocol,
    req: {
      headers: { "proxy-authorization": parsed.userid },
      socket,
    } as unknown as IncomingMessage,
    socket,
    authority: `${host.protocol} ${parsed.host}:${parsed.port}`,
  });

  if (!ok.passed) {
    fail(SOCKS4_REPLY_FAILURE);
    return;
  }

  // 账号级 clientIp 名单（第二道）：此刻才有身份。被拒只能断链（见 SocksSessionHost 的说明）
  if (host.rejectByClientIp(getSocketAddress(socket), ok.username)) {
    reader.dispose();
    socket.destroy();
    return;
  }

  host.inbound.serveSocks4(socket, parsed, reader, ok.username);
}

/**
 * SOCKS5 会话主体（socks5 与 sockss5 的 onConn 合并）
 * @description 先读 greeting（兼容分段/流水线）→ 依 authEnabled 走选鉴分支：
 * - authEnabled 且不支持 USER_PASS：回 0xFF 后经 authorize 走 no-token 审计再销毁（审计不可省）
 * - authEnabled 且支持：回 0x02 走 RFC1929 子协商，失败回 0x01 0x01，成功回 0x01 0x00
 * - 非 authEnabled：不支持 NO_AUTH 则回 0xFF，否则回 0x05 0x00
 * 成功后委派 inbound.serveSocks5Connect 读 CONNECT 并分派
 * @param host - 会话宿主
 * @param socket - 客户端双工流
 * @param reader - 共享握手读取器
 */
export async function runSocks5Session(
  host: SocksSessionHost,
  socket: Duplex,
  reader: SocksHandshakeReader,
): Promise<void> {
  /** 失败收尾：解绑读取器并回指定失败应答（桥接 writeReplyAndClose，写完延时销毁） */
  const fail = (reply: Buffer): void => {
    reader.dispose();
    host.replyAndClose(socket, reply);
  };

  // 先读 greeting，禁止未读就回 0x05 0xFF
  const methods = await host.inbound.readGreeting(reader);

  if (!methods) {
    reader.dispose();
    socket.destroy();
    return;
  }

  // 「开不开鉴权」由组合根选哪个实现表达：`NoneAuthProvider.isEnabled` 恒 false。
  // 两个判据都留：isEnabled 管开关、kind 管实现身份（缺一个都可能让「本该要凭证」的会话
  // 静默走 NO_AUTH 分支）。鉴权类型本身在 basic/uid/jwt 之间怎么判，是 provider 内部的事。
  const authEnabled = !!host.auth.isEnabled && host.auth.kind !== "none";
  const hasNoAuth = methods.includes(SOCKS5_METHOD_NO_AUTH);
  const hasUserPass = methods.includes(SOCKS5_METHOD_USER_PASS);
  /** 已鉴权用户名：仅走过 RFC1929 子协商时才有值，无鉴权模式恒为 undefined */
  let authUser: string | undefined;

  if (authEnabled) {
    if (!hasUserPass) {
      // 经 authorize 走统一 [auth] 审计（无 token → no-token），req 带 socket 才能取客户端地址
      await host.authorize({
        protocol: host.protocol,
        req: { headers: {}, socket } as unknown as IncomingMessage,
        socket,
        authority: host.protocol,
      });
      fail(SOCKS5_AUTH_REJECT);
      return;
    }

    socket.write(SOCKS5_SELECT_USERPASS);

    const creds = await host.inbound.readUserPass(reader);

    if (!creds) {
      fail(SOCKS5_AUTH_FAILURE);
      return;
    }

    const b64 = encodeBasicCredentials(creds.user, creds.pass);
    const ok = await host.authorize({
      protocol: host.protocol,
      req: {
        headers: { "proxy-authorization": buildProxyAuthValue(b64) },
        socket,
      } as unknown as IncomingMessage,
      socket,
      authority: host.protocol,
    });

    if (!ok.passed) {
      fail(SOCKS5_AUTH_FAILURE);
      return;
    }

    authUser = ok.username;
    socket.write(SOCKS5_AUTH_SUCCESS);
  } else {    if (!hasNoAuth) {
      fail(SOCKS5_AUTH_REJECT);
      return;
    }

    socket.write(SOCKS5_NO_AUTH);
  }

  // 账号级 clientIp 名单（第二道）：只在走过鉴权时有身份可判；无鉴权模式（authUser 为
  // undefined）不重复判第一道（onConn 握手前已判过全局名单）
  if (host.rejectByClientIp(getSocketAddress(socket), authUser)) {
    fail(SOCKS5_AUTH_FAILURE);
    return;
  }

  // 鉴权成功，读 CONNECT 包（复用同一 reader 承接流水线/分段）
  await host.inbound.serveSocks5Connect(socket, reader, authUser);
}
