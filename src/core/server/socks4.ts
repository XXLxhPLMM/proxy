/**
 * SOCKS4 代理 - 明文 TCP 服 + SocksForwarder(version=4)
 * 职责：
 * - 建服：net.createServer，每连接走 onConn
 * - 鉴权：基类 authorize（空 headers + authority socks4），失败回 SOCKS4_REPLY_FAILURE 并销毁
 * - 委派：通过 SocksForwarder.handle(socket, 4)，pipe 事件转抛
 * 与 socks5 差异：无握手选鉴方法，版本号固定 4
 */
import net from "node:net";
import type { Duplex } from "node:stream";
import { BaseProxy } from "./base.js";
import type { ProxyOptions } from "@/core/types/proxy.js";
import { SocksForwarder } from "@/core/forward/socks.js";
import { SOCKS4_REPLY_FAILURE } from "@/utils/constants.js";

/**
 * SOCKS4 代理实现：BaseProxy 的明文 TCP 分支
 */
export class Socks4Proxy extends BaseProxy {
  /** 底层 TCP 服务实例，未启动为 null，stop 后置空 */
  protected server: net.Server | null = null;

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
   * 单连接处理：绑 error 兜底 -> authorize -> 失败回失败应答并销毁 -> 成功交 SocksForwarder
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
      authority: "socks4",
    });

    if (!ok) {
      socket.write(SOCKS4_REPLY_FAILURE);
      socket.destroy();
      return;
    }

    new SocksForwarder((e) => {
      this.emit("pipe", e as never);
    }).handle(socket, 4);
  }
}
