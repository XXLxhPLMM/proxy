/**
 * SOCKSS5 代理 - TLS 加密 TCP 服 + SocksForwarder(version=5)
 * 职责：
 * - 建服：tls.createServer，每连接走 onConn；tlsClientError 忽略握手异常
 * - 证书：onBeforeStart/loadCerts 预加载，非 worker 打 lifecycle 日志；doStart 兜底加载并组装 passphrase/ca
 * - 鉴权委派：基类 authorize（空 headers + authority sockss5），失败回 SOCKS5_AUTH_REJECT 并销毁；成功交 SocksForwarder.handle(socket, 5)，pipe 事件转抛
 * 与 socks5 差异：仅传输层多了 TLS；与 sockss4 差异：版本号为 5
 */
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { BaseProxy } from "./base.js";
import type { ProxyOptions } from "@/core/types/proxy.js";
import { getLogger } from "@/utils/logger.js";
import { loadCerts, type LoadedTlsCerts } from "@/utils/cert.js";
import { SocksForwarder } from "@/core/forward/socks.js";
import { SOCKS5_AUTH_REJECT } from "@/utils/constants.js";

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
   * 单连接处理：绑 error 兜底 -> authorize（authority sockss5）-> 失败回 SOCKS5_AUTH_REJECT 并销毁 -> 成功交 SocksForwarder(version=5)
   * @param socket - 客户端双工流（tls.Socket as Duplex）
   */
  private async onConn(socket: Duplex): Promise<void> {
    socket.on("error", () => {
      socket.destroy();
    });

    const ok = await this.authorize({
      protocol: this.protocol,
      req: { headers: {} },
      socket,
      authority: "sockss5",
    });

    if (!ok) {
      socket.write(SOCKS5_AUTH_REJECT);
      socket.destroy();
      return;
    }

    this.forwarder.handle(socket, 5);
  }
}
