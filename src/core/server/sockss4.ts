/**
 * SOCKSS4 代理 - TLS 加密 TCP 服 + SocksForwarder(version=4)
 * 职责：
 * - 建服：tls.createServer，每连接走 onConn
 * - 证书：onBeforeStart 经 loadCerts 预载，非 worker 打 lifecycle 日志
 * - 握手：SocksHandshakeReader 读满 SOCKS4 请求（USERID 作为 uid token），兼容分段与流水线
 * - 鉴权：读取并解析请求后再授权（basic 复用 socks4 的 USERID==username uid 语义），失败回 SOCKS4_REPLY_FAILURE 并销毁
 * - 委派：解析成功后交 SocksForwarder.serveSocks4，pipe 事件转抛；tlsClientError 忽略握手异常
 * - 关服：doStop 先 close 再销毁存量连接，避免 idle 连接导致 stop 挂起
 * 与 socks4 差异：传输层多 TLS；与 sockss5 差异：版本号固定 4
 */
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { BaseProxy } from "./base.js";
import type { ProxyOptions } from "@/core/types/proxy.js";
import { getLogger } from "@/utils/logger.js";
import { loadCerts, type LoadedTlsCerts } from "@/utils/cert.js";
import { SocksForwarder, SocksHandshakeReader } from "@/core/forward/socks.js";
import { SOCKS4_REPLY_FAILURE } from "@/utils/constants.js";
import { logBadRequest, logClientTimeout } from "@/server/log/events-log.js";

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
   * 单连接处理：绑 error/登记 -> 读 SOCKS4 请求（USERID 承载 uid）-> authorize -> 失败回失败应答并销毁 -> 成功交 SocksForwarder
   * @param socket - 客户端双工流（TLSSocket as Duplex）
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
      // 传真实协议：Auth 对 socks4/sockss4 的 basic 均允许 USERID==username 的 uid 语义
      protocol: this.protocol,
      req: { headers: { "proxy-authorization": parsed.userid } as Record<string, string>, socket } as unknown as import("node:http").IncomingMessage,
      socket,
      authority: `sockss4 ${parsed.host}:${parsed.port}`,
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
