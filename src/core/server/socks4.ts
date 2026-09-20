/**
 * SOCKS4 代理 - 明文 TCP 服 + SocksForwarder(version=4)
 * 职责：
 * - 建服：net.createServer，每连接走 onConn
 * - 握手：SocksHandshakeReader 逐阶段读满/读至 NUL，兼容分段与流水线
 * - 鉴权：基类 authorize（USERID 承载凭证 + authority socks4），失败回 SOCKS4_REPLY_FAILURE 并销毁
 * - 委派：解析成功后交 SocksForwarder.serveSocks4，pipe 事件转抛
 * - 关服：doStop 先 close 再销毁存量连接，避免 idle 连接导致 stop 挂起
 * 与 socks5 差异：无握手选鉴方法，版本号固定 4
 */
import net from "node:net";
import type { Duplex } from "node:stream";
import { BaseProxy } from "./base.js";
import type { ProxyOptions } from "@/core/types/proxy.js";
import { SocksForwarder, SocksHandshakeReader } from "@/core/forward/socks.js";
import { SOCKS4_REPLY_FAILURE } from "@/utils/constants.js";
import { logBadRequest, logClientTimeout } from "@/server/log/events-log.js";

/**
 * SOCKS4 代理实现：BaseProxy 的明文 TCP 分支
 */
export class Socks4Proxy extends BaseProxy {
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
   * 构造 SOCKS4 代理
   * @param o - 监听地址/端口与鉴权等选项，缺省由 BaseProxy 归一化
   */
  constructor(o: ProxyOptions = {}) {
    super("socks4", o);
  }

  /**
   * 建服：创建 net.Server 并 listen，每连接委派 onConn
   * @throws listen 失败（如 EADDRINUSE）时抛错，由基类转 error 态
   */
  protected async doStart(): Promise<void> {
    const s = net.createServer((sock) => {
      this.onConn(sock as unknown as Duplex);
    });

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
   * 单连接处理：缓冲读满 SOCKS4 请求（USERID 承载 uid）→ 公共 Auth（uid/basic 均可）→ 成功交 forwarder
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

    const parsed = await forwarder.parseSocks4(reader);

    if (!parsed) {
      reader.dispose();
      socket.write(SOCKS4_REPLY_FAILURE);
      setTimeout(() => socket.destroy(), 100);
      return;
    }

    const ok = await this.authorize({
      protocol: "socks4",
      req: { headers: { "proxy-authorization": parsed.userid } as Record<string, string>, socket } as unknown as import("node:http").IncomingMessage,
      socket,
      authority: `socks4 ${parsed.host}:${parsed.port}`,
    });

    if (!ok) {
      reader.dispose();
      socket.write(SOCKS4_REPLY_FAILURE);
      setTimeout(() => socket.destroy(), 100);
      return;
    }

    forwarder.serveSocks4(socket, parsed, reader);
  }
}
