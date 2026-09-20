/**
 * SOCKS5 代理 - 明文 TCP 服 + SocksForwarder(version=5)
 * 职责：
 * - 建服：net.createServer，每连接走 onConn
 * - 握手：SocksHandshakeReader 逐阶段读满 greeting / RFC1929 子协商 / CONNECT，兼容分段与流水线
 * - 鉴权：基类 authorize（basic 用 header，uid/jwt 亦经同一入口），失败回对应应答并销毁
 * - 委派：鉴权成功后交 SocksForwarder.serveSocks5Connect 读 CONNECT 建隧
 * - 关服：doStop 先 close 再销毁存量连接，避免 idle 连接导致 stop 挂起
 * 与 socks4 差异：支持握手选鉴方法，版本号固定 5
 */
import net from "node:net";
import type { Duplex } from "node:stream";
import { BaseProxy } from "./base.js";
import type { ProxyOptions } from "@/core/types/proxy.js";
import { SocksForwarder, SocksHandshakeReader } from "@/core/forward/socks.js";
import {
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
import { logBadRequest, logClientTimeout } from "@/server/log/events-log.js";

/**
 * SOCKS5 代理实现：BaseProxy 的明文 TCP 分支
 */
export class Socks5Proxy extends BaseProxy {
  /** 底层 TCP 服务实例，未启动为 null，stop 后置空 */
  protected server: net.Server | null = null;

  /** 存量连接登记：创建时加入、close 时移除，doStop 据此强制销毁避免 stop 挂起 */
  private readonly conns = new Set<Duplex>();

  /**
   * 转发器单例：SocksForwarder/Dialer 均无连接态，每连接 new 纯属浪费，
   * 提到 server 级复用。行为不变，仅省分配与闭包。
   */
  private readonly forwarder = new SocksForwarder((e) => {
    this.emit("pipe", e as never);
  });

  /**
   * 构造 SOCKS5 代理
   * @param options - 监听地址/端口与鉴权等选项，缺省由 BaseProxy 归一化
   */
  constructor(options: ProxyOptions = {}) {
    super("socks5", options);
  }

  /**
   * 建服：创建 net.Server 并 listen，每连接委派 onConn
   * @throws listen 失败（如 EADDRINUSE）时抛错，由基类转 error 态
   */
  protected async doStart(): Promise<void> {
    const s = net.createServer((sock) => {
      this.onConn(sock as unknown as Duplex);
    });

    await new Promise<void>((res, rej) => {
      s.once("error", rej);
      s.listen(this.options.port, this.options.host, () => {
        s.off("error", rej);
        res();
      });
    });

    s.on("error", (e) => {
      this.setState("error");
      this.log.error("server error:", e);
    });

    this.server = s;
  }

  /**
   * 关服：先 close 拒绝新连接，再强制销毁存量连接（idle 连接会导致 close 回调迟迟不触发）
   * 无 server 时直接返回（幂等）
   */
  protected async doStop(): Promise<void> {
    const s = this.server;

    if (!s) {
      return;
    }

    this.server = null;

    await new Promise<void>((r) => {
      s.close(() => {
        r();
      });
      for (const c of this.conns) {
        if (!c.destroyed) {
          c.destroy();
        }
      }
      this.conns.clear();
    });
  }

  /**
   * 是否处于监听态
   * @returns server 非空且 listening 为 true
   */
  isRunning(): boolean {
    return !!this.server?.listening;
  }

  /**
   * 单连接处理：握手选鉴（server 层）→ 鉴权成功后委派 forward 只做 CONNECT
   * @param socket - 客户端双工流（net.Socket as Duplex）
   */
  private async onConn(socket: Duplex): Promise<void> {
    this.conns.add(socket);
    socket.once("close", () => {
      this.conns.delete(socket);
    });
    socket.on("error", () => {
      socket.destroy();
    });

    const forwarder = this.forwarder;
    const reader = new SocksHandshakeReader(socket, {
      timeout: this.options.upstreamTimeout,
      onTimeout: (d) => logClientTimeout(this.log, d),
      onInvalid: (d) => logBadRequest(this.log, d),
    });

    // 等 greeting：VER NMETHODS METHODS（缓冲读取，兼容分段/流水线）
    const methods = await forwarder.readGreeting(reader);

    if (!methods) {
      reader.dispose();
      socket.destroy();
      return;
    }

    const authEnabled = !!this.auth.isEnabled && this.auth.authType !== "none";
    const hasNoAuth = methods.includes(SOCKS5_METHOD_NO_AUTH);
    const hasUserPass = methods.includes(SOCKS5_METHOD_USER_PASS);

    if (authEnabled) {
      if (!hasUserPass) {
        socket.write(SOCKS5_AUTH_REJECT);
        // 经 BaseProxy.authorize 走统一 [auth] 审计（无 token → no-token），req 带 socket 才能取 127.0.0.1
        await this.authorize({
          protocol: this.protocol,
          req: { headers: {}, socket } as unknown as import("node:http").IncomingMessage,
          socket,
          authority: "socks5",
        });
        reader.dispose();
        setTimeout(() => socket.destroy(), 100);
        return;
      }

      socket.write(SOCKS5_SELECT_USERPASS);

      const creds = await forwarder.readUserPass(reader);

      if (!creds) {
        socket.write(SOCKS5_AUTH_FAILURE);
        reader.dispose();
        setTimeout(() => socket.destroy(), 100);
        return;
      }

      const b64 = encodeBasicCredentials(creds.user, creds.pass);
      const ok = await this.authorize({
        protocol: this.protocol,
        req: { headers: { "proxy-authorization": buildProxyAuthValue(b64) }, socket } as unknown as import("node:http").IncomingMessage,
        socket,
        authority: "socks5",
      });

      if (!ok) {
        socket.write(SOCKS5_AUTH_FAILURE);
        reader.dispose();
        setTimeout(() => socket.destroy(), 100);
        return;
      }

      socket.write(SOCKS5_AUTH_SUCCESS);
    } else {
      if (!hasNoAuth) {
        socket.write(SOCKS5_AUTH_REJECT);
        reader.dispose();
        setTimeout(() => socket.destroy(), 100);
        return;
      }

      socket.write(SOCKS5_NO_AUTH);
    }

    // 鉴权成功，读 CONNECT 包（复用同一 reader 承接流水线/分段）
    await forwarder.serveSocks5Connect(socket, reader);
  }
}
