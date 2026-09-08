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
   * 单连接处理：绑 error 兜底 -> authorize -> 失败回 SOCKS5_AUTH_REJECT 并销毁 -> 成功交 SocksForwarder(version 5)
   * @param socket - 客户端双工流（net.Socket as Duplex）
   */
  private async onConn(socket: Duplex): Promise<void> {
    socket.on("error", () => {
      socket.destroy();
    });

    const ok = await this.authorize({
      protocol: this.protocol,
      req: { headers: {} },
      socket,
      authority: "socks5",
    });

    if (!ok) {
      socket.write(SOCKS5_AUTH_REJECT);
      socket.destroy();
      return;
    }

    new SocksForwarder((e) => {
      this.emit("pipe", e as never);
    }).handle(socket, 5);
  }
}
