/**
 * SOCKSS4 代理 - TLS 加密 TCP 服 + SocksForwarder(version=4)
 * 职责：
 * - 建服：tls.createServer，每连接走 onConn
 * - 证书：onBeforeStart 经 loadCerts 预载，非 worker 打 lifecycle 日志
 * - 鉴权：基类 authorize（空 headers + authority sockss4），失败回 SOCKS4_REPLY_FAILURE 并销毁
 * - 委派：通过 SocksForwarder.handle(socket, 4)，pipe 事件转抛；tlsClientError 忽略握手异常
 * 与 socks4 差异：传输层多 TLS；与 sockss5 差异：版本号固定 4
 */
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { BaseProxy } from "./base.js";
import type { ProxyOptions } from "@/core/types/proxy.js";
import { getLogger } from "@/utils/logger.js";
import { loadCerts, type LoadedTlsCerts } from "@/utils/cert.js";
import { SocksForwarder } from "@/core/forward/socks.js";
import { SOCKS4_REPLY_FAILURE } from "@/utils/constants.js";

/**
 * SOCKSS4 代理实现：BaseProxy 的 TLS 加密分支
 */
export class Sockss4Proxy extends BaseProxy {
  /** 日志器，前缀 Sockss4Proxy */
  protected readonly log = getLogger("Sockss4Proxy");

  /** 底层 TLS 服务实例，未启动为 null，stop 后置空 */
  protected server: tls.Server | null = null;

  /** 已加载证书，onBeforeStart 预载，doStart 兜底加载 */
  private certs?: LoadedTlsCerts;

  /**
   * 构造 SOCKSS4 代理
   * @param o - 监听地址/端口与 TLS/鉴权等选项，缺省由 BaseProxy 归一化
   */
  constructor(o: ProxyOptions = {}) {
    super("sockss4", o);
  }

  /**
   * 预载证书：经 loadCerts 加载 TLS 证书，非 worker 打 lifecycle 日志
   */
  async onBeforeStart(): Promise<void> {
    if (!this.options.isWorker) {
      this.log.info("[lifecycle] sockss4 loading certs");
    }
    this.certs = loadCerts(this.options.tls, this.log, "SOCKSS4");
  }

  /**
   * 建服：certs 兜底加载，组装 passphrase/ca 建 tls.Server 并 listen，每连接委派 onConn
   * @throws listen/证书失败（如 EADDRINUSE）时抛错，由基类转 error 态
   */
  protected async doStart(): Promise<void> {
    if (!this.certs) {
      this.certs = loadCerts(this.options.tls, this.log, "SOCKSS4");
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
      // 忽略 TLS 握手异常，保持服务可用
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
   * 单连接处理：绑 error 兜底 -> authorize（authority sockss4）-> 失败回失败应答并销毁 -> 成功交 SocksForwarder
   * @param socket - 客户端双工流（TLSSocket as Duplex）
   */
  private async onConn(socket: Duplex): Promise<void> {
    socket.on("error", () => {
      socket.destroy();
    });

    const ok = await this.authorize({
      protocol: this.protocol,
      req: { headers: {} },
      socket,
      authority: "sockss4",
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
