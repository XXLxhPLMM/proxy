/**
 * SOCKS 会话处理器 - 四个 SOCKS server 共用的 onConn 主体
 * 职责：
 * - 把 socks4/socks5/sockss4/sockss5 四份逐字重复的「握手解析 → 鉴权 → 委派转发」收敛为一处
 * - 以 SocksSessionHost 最小接口注入 server 能力（protocol/forwarder/auth/log/authorize/replyAndClose），
 *   使会话逻辑不依赖具体 server 类，明文与 TLS 分支共用同一份逻辑
 * - 明文与 TLS 的差异只在 host.protocol（协议名）上体现，故 authority 由协议名拼装：
 *   socks4 系带 `${protocol} host:port` 后缀，socks5 系为裸协议名
 * 设计：
 * - 不持有连接状态（登记/销毁由 socks-base.ts 负责），纯编排
 * - 失败收尾统一走 host.replyAndClose（桥接 writeReplyAndClose，写完延时销毁）
 * - socks5 的「无 token 审计」必须保留：客户端不支持 USER_PASS 时仍经 authorize 走 [auth] 审计
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { AuthContext, AuthProvider, AuthResult, ProxyProtocol } from "@/core/types/proxy.js";
import type { Logger } from "@/utils/logger.js";
import type { SocksForwarder } from "@/core/forward/socks.js";
import type { SocksHandshakeReader } from "@/core/forward/socks-reader.js";
import {
  SOCKS4_REPLY_FAILURE,
  SOCKS5_AUTH_FAILURE,
  SOCKS5_AUTH_REJECT,
  SOCKS5_AUTH_SUCCESS,
  SOCKS5_METHOD_NO_AUTH,
  SOCKS5_METHOD_USER_PASS,
  SOCKS5_NO_AUTH,
  SOCKS5_SELECT_USERPASS,
  buildProxyAuthValue,
} from "@/utils/constants.js";
import { encodeBasicCredentials } from "@/core/proxy-helpers.js";

/**
 * 会话宿主：把 server 骨架能力以最小接口注入会话处理器
 * @param protocol - 本连接的协议标识（socks4/socks5/sockss4/sockss5），决定 authority 形态
 * @param forwarder - 复用的 SOCKS 转发器（握手解析 + 拨号建隧）
 * @param auth - 鉴权提供者，读取 isEnabled/authType 决定 SOCKS5 选鉴方法分支
 * @param log - 会话日志器（协议名前缀）
 * @param authorize - 统一鉴权入口，桥接 BaseProxy.authorize（含 [auth] 审计转抛），返回含用户名的结果
 * @param replyAndClose - 回失败应答并延时销毁，桥接 writeReplyAndClose
 */
export interface SocksSessionHost {
  protocol: ProxyProtocol;
  forwarder: SocksForwarder;
  auth: AuthProvider;
  log: Logger;
  authorize(ctx: AuthContext): Promise<AuthResult>;
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
 * 解析/鉴权失败均回 SOCKS4_REPLY_FAILURE，成功交 forwarder.serveSocks4 建隧
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

  const parsed = await host.forwarder.parseSocks4(reader);

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

  host.forwarder.serveSocks4(socket, parsed, reader, ok.username);
}

/**
 * SOCKS5 会话主体（socks5 与 sockss5 的 onConn 合并）
 * @description 先读 greeting（兼容分段/流水线）→ 依 authEnabled 走选鉴分支：
 * - authEnabled 且不支持 USER_PASS：回 0xFF 后经 authorize 走 no-token 审计再销毁（审计不可省）
 * - authEnabled 且支持：回 0x02 走 RFC1929 子协商，失败回 0x01 0x01，成功回 0x01 0x00
 * - 非 authEnabled：不支持 NO_AUTH 则回 0xFF，否则回 0x05 0x00
 * 成功后委派 forwarder.serveSocks5Connect 读 CONNECT 建隧
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
  const methods = await host.forwarder.readGreeting(reader);

  if (!methods) {
    reader.dispose();
    socket.destroy();
    return;
  }

  const authEnabled = !!host.auth.isEnabled && host.auth.authType !== "none";
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

    const creds = await host.forwarder.readUserPass(reader);

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
  } else {
    if (!hasNoAuth) {
      fail(SOCKS5_AUTH_REJECT);
      return;
    }

    socket.write(SOCKS5_NO_AUTH);
  }

  // 鉴权成功，读 CONNECT 包（复用同一 reader 承接流水线/分段）
  await host.forwarder.serveSocks5Connect(socket, reader, authUser);
}
