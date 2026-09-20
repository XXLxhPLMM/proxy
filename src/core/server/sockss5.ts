/**
 * SOCKSS5 代理 - TLS 加密 TCP 服 + SocksForwarder(version=5)
 * 职责：
 * - 建服：tls.createServer，每连接走 onConn；tlsClientError 忽略握手异常
 * - 证书：onBeforeStart/loadCerts 预加载，非 worker 打 lifecycle 日志；doStart 兜底加载并组装 passphrase/ca
 * - 握手：SocksHandshakeReader 先读 greeting（兼容分段/流水线），authEnabled 时回 0x05 0x02 走 RFC1929 子协商
 * - 鉴权：用 basic 头经 BaseProxy.authorize，成功回 0x05 0x00；失败回对应拒绝/失败应答并销毁
 * - 委派：成功交 SocksForwarder.serveSocks5Connect 读 CONNECT 建隧，pipe 事件转抛
 * - 关服：doStop 先 close 再销毁存量连接，避免 idle 连接导致 stop 挂起
 * 与 socks5 差异：仅传输层多了 TLS；与 sockss4 差异：版本号为 5
 */
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { BaseProxy } from "./base.js";
import type { ProxyOptions } from "@/core/types/proxy.js";
import { getLogger } from "@/utils/logger.js";
import { loadCerts, type LoadedTlsCerts } from "@/utils/cert.js";
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
 * SOCKSS5 代理实现：BaseProxy 的 TLS 加密分支
 */
export class Sockss5Proxy extends BaseProxy {
  /** 前缀日志器（Sockss5Proxy 通道） */
  protected readonly log = getLogger("Sockss5Proxy");

  /** 底层 TLS 服务实例，未启动为 null，stop 后置空 */
  protected server: tls.Server | null = null;

  /** 已加载证书（key/cert/ca），onBeforeStart 预载，doStart 兜底 */
  private certs?: LoadedTlsCerts;

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
   * 构造 SOCKSS5 代理
   * @param o - 监听地址/端口与 TLS/鉴权等选项，缺省由 BaseProxy 归一化
   */
  constructor(o: ProxyOptions = {}) {
    super("sockss5", o);
  }

  /**
   * 预加载证书：loadCerts 读 options.tls，非 worker 打 lifecycle 日志
   */
  async onBeforeStart(): Promise<void> {
    if (!this.options.isWorker) {
      this.log.info("[lifecycle] sockss5 loading certs");
    }
    this.certs = loadCerts(this.options.tls, this.log, "SOCKSS5");
  }

  /**
   * 建服：certs 兜底加载，组装 passphrase/ca 后创建 tls.Server 并 listen，每连接委派 onConn
   * @throws listen/证书失败时抛错，由基类转 error 态
   */
  protected async doStart(): Promise<void> {
    if (!this.certs) {
      this.certs = loadCerts(this.options.tls, this.log, "SOCKSS5");
    }

    const { key, cert, ca } = this.certs;
    const pp = (this.options.tls?.passphrase as string) || undefined;

    const s = tls.createServer(
      {
        key,
        cert,
        passphrase: pp,
        ca: ca ? [ca] : undefined,
      },
      (sock) => {
        this.onConn(sock as unknown as Duplex);
      },
    );

    await new Promise<void>((r, j) => {
      s.once("error", j);
      s.listen(this.options.port, this.options.host, () => {
        s.off("error", j);
        r();
      });
    });

    s.on("error", (e) => {
      this.setState("error");
      this.log.error("server error:", e);
    });

    s.on("tlsClientError", () => {
      // 忽略 TLS 握手异常
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
   * 单连接处理：读 greeting -> authEnabled 时回 0x05 0x02 走 RFC1929 -> basic 头鉴权 -> 成功回 0x05 0x00 -> 交 forwarder
   * @param socket - 客户端双工流（tls.Socket as Duplex）
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

    // 先读 greeting，禁止未读就回 0x05 0xFF
    const methods = await forwarder.readGreeting(reader);

    if (!methods) {
      reader.dispose();
      socket.destroy();
      return;
    }

    const authEnabled = !!this.auth.isEnabled && this.auth.authType !== "none";

    if (authEnabled) {
      if (!methods.includes(SOCKS5_METHOD_USER_PASS)) {
        socket.write(SOCKS5_AUTH_REJECT);
        // 经 BaseProxy.authorize 走统一 [auth] 审计（无 token → no-token）
        await this.authorize({
          protocol: this.protocol,
          req: { headers: {}, socket } as unknown as import("node:http").IncomingMessage,
          socket,
          authority: "sockss5",
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
        authority: "sockss5",
      });

      if (!ok) {
        socket.write(SOCKS5_AUTH_FAILURE);
        reader.dispose();
        setTimeout(() => socket.destroy(), 100);
        return;
      }

      socket.write(SOCKS5_AUTH_SUCCESS);
    } else {
      if (!methods.includes(SOCKS5_METHOD_NO_AUTH)) {
        socket.write(SOCKS5_AUTH_REJECT);
        reader.dispose();
        setTimeout(() => socket.destroy(), 100);
        return;
      }

      socket.write(SOCKS5_NO_AUTH);
    }

    await forwarder.serveSocks5Connect(socket, reader);
  }
}
