/**
 * SOCKS5 代理 - 明文 TCP 服 + SocksForwarder(version=5)
 * 职责：
 * - 建服：net.createServer，每连接走 onConn
 * - 鉴权：基类 authorize（空 headers + authority socks5），失败回 SOCKS5_AUTH_REJECT 并销毁
 * - 委派：通过 SocksForwarder.handle(socket, 5)，pipe 事件转抛
 * 与 socks4 差异：支持握手选鉴方法，版本号固定 5
 */
import net from "node:net";
import type { Duplex } from "node:stream";
import { BaseProxy } from "./base.js";
import type { ProxyOptions } from "@/core/types/proxy.js";
import { SocksForwarder } from "@/core/forward/socks.js";
import { SOCKS5_AUTH_REJECT } from "@/utils/constants.js";
import { get } from "@/config/store.js";
import { encodeBasicCredentials } from "@/core/proxy-helpers.js";
import { buildProxyAuthValue } from "@/utils/constants.js";

/**
 * SOCKS5 代理实现：BaseProxy 的明文 TCP 分支
 */
export class Socks5Proxy extends BaseProxy {
  /** 底层 TCP 服务实例，未启动为 null，stop 后置空 */
  protected server: net.Server | null = null;

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
   * 关服：close 当前 server 并置空
   * 无 server 时直接返回（幂等）
   */
  protected async doStop(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((r) => {
      this.server!.close(() => {
        r();
      });
    });

    this.server = null;
  }

  /**
   * 是否处于监听态
   * @returns server 非空且 listening 为 true
   */
  isRunning(): boolean {
    return !!this.server?.listening;
  }

  /**
   * 单连接处理：握手 + 鉴权（server 层）→ 成功后委派 forward 只做 CONNECT
   * @param socket - 客户端双工流（net.Socket as Duplex）
   */
  private async onConn(socket: Duplex): Promise<void> {
    socket.on("error", () => {
      socket.destroy();
    });

    const forwarder = new SocksForwarder((e) => {
      this.emit("pipe", e as never);
    });

    // 等首包握手：VER NMETHODS METHODS
    const first = await new Promise<Buffer | null>((res) => {
      socket.once("data", (d: Buffer) => res(d));
      socket.once("error", () => res(null));
    });
    if (!first || first.length < 2 || first[0] !== 0x05) {
      socket.destroy();
      return;
    }
    const nmethods = first[1];
    if (first.length < 2 + nmethods) {
      socket.destroy();
      return;
    }
    const methods = first.subarray(2, 2 + nmethods);
    const authEnabled = get("authEnabled") && get("authType") !== "none";
    const hasNoAuth = methods.includes(0x00);
    const hasUserPass = methods.includes(0x02);

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
        setTimeout(() => socket.destroy(), 100);
        return;
      }
      socket.write(Buffer.from([0x05, 0x02]));
      const authBuf = await new Promise<Buffer | null>((res) => {
        socket.once("data", (d: Buffer) => res(d));
        socket.once("error", () => res(null));
      });
      if (!authBuf || authBuf.length < 3 || authBuf[0] !== 0x01) {
        socket.write(Buffer.from([0x01, 0x01]));
        setTimeout(() => socket.destroy(), 100);
        return;
      }
      const ulen = authBuf[1];
      if (authBuf.length < 2 + ulen + 1) {
        socket.write(Buffer.from([0x01, 0x01]));
        setTimeout(() => socket.destroy(), 100);
        return;
      }
      const uname = authBuf.subarray(2, 2 + ulen).toString();
      const plen = authBuf[2 + ulen];
      if (authBuf.length < 3 + ulen + plen) {
        socket.write(Buffer.from([0x01, 0x01]));
        setTimeout(() => socket.destroy(), 100);
        return;
      }
      const passwd = authBuf.subarray(3 + ulen, 3 + ulen + plen).toString();
      const b64 = encodeBasicCredentials(uname, passwd);
      const ok = await this.authorize({
        protocol: this.protocol,
        req: { headers: { "proxy-authorization": buildProxyAuthValue(b64) }, socket } as unknown as import("node:http").IncomingMessage,
        socket,
        authority: "socks5",
      });
      if (!ok) {
        socket.write(Buffer.from([0x01, 0x01]));
        setTimeout(() => socket.destroy(), 100);
        return;
      }
      socket.write(Buffer.from([0x01, 0x00]));
      // 鉴权成功，等待 CONNECT 包，交 forward 处理
      forwarder.handleSocks5Connect(socket);
    } else {
      if (!hasNoAuth) {
        socket.write(SOCKS5_AUTH_REJECT);
        setTimeout(() => socket.destroy(), 100);
        return;
      }
      socket.write(Buffer.from([0x05, 0x00]));
      forwarder.handleSocks5Connect(socket);
    }
  }
}
