/**
 * SOCKS 代理骨架 - 四个 SOCKS server 共用的生命周期与连接登记
 * 职责：
 * - 收敛 socks4/socks5/sockss4/sockss5 逐字重复的模板方法：doStart（建服+listen）/ doStop（close+销毁存量）/ isRunning
 * - 收敛单连接处理：conns 登记 + close 移除 + error 销毁，构造握手读取器后交会话处理器（socks-session.ts）
 * - 收敛转发器单例与日志器（协议名前缀）；pipe 事件转抛
 * 设计：
 * - 明文（PlainSocksProxy）与 TLS（TlsSocksProxy）差异只在 createListener 与证书加载，抽出为导出中间类
 * - 会话逻辑经 SocksSessionHost 注入，骨架不感知 socks4/socks5 分支（见 socks-session.ts）
 * - sessionHost/authorize 用闭包桥接 protected 成员，避免把 auth/authorize 暴露到接口之外
 * - 可见差异：日志前缀由「BaseProxy/Sockss4Proxy…」统一为协议名（socks4/socks5/sockss4/sockss5）
 */
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { BaseProxy } from "./base.js";
import type { ProxyOptions, ProxyProtocol } from "@/core/types/proxy.js";
import { SocksForwarder, SocksHandshakeReader } from "@/core/forward/socks.js";
import { listenAsync } from "@/utils/net.js";
import { getLogger } from "@/utils/logger.js";
import { loadCerts, type LoadedTlsCerts } from "@/utils/cert.js";
import { writeReplyAndClose } from "@/core/proxy-helpers.js";
import { logBadRequest, logClientTimeout } from "@/server/log/events-log.js";
import type { SocksSessionHost, SocksSessionRunner } from "./socks-session.js";

/**
 * SOCKS 代理骨架：BaseProxy 的 SOCKS 分支
 * 明文与 TLS 两态共用建服/关服/连接登记/会话委派，仅 createListener 与证书加载不同
 */
export abstract class SocksProxyBase extends BaseProxy {
  /** 底层服务实例（net.Server，tls.Server extends net.Server），未启动为 null，stop 后置空 */
  protected server: net.Server | null = null;

  /** 存量连接登记：创建时加入、close 时移除，doStop 据此强制销毁避免 stop 挂起 */
  private readonly conns = new Set<Duplex>();

  /**
   * 转发器单例：SocksForwarder/Dialer 均无连接态，每连接 new 纯属浪费，
   * 提到 server 级复用。行为不变，仅省分配与闭包。
   */
  protected readonly forwarder = new SocksForwarder((e) => {
    this.emit("pipe", e as never);
  });

  /** 日志器：统一以协议名为前缀（可见差异，见文件头说明） */
  protected override readonly log = getLogger(this.protocol);

  /**
   * 构造 SOCKS 骨架
   * @param protocol - 协议标识（socks4/socks5/sockss4/sockss5）
   * @param o - 监听地址/端口与鉴权等选项，缺省由 BaseProxy 归一化
   * @param runner - 会话处理器（明文/TLS 之外的唯一行为差异点）
   */
  constructor(protocol: ProxyProtocol, o: ProxyOptions, private readonly runner: SocksSessionRunner) {
    super(protocol, o);
  }

  /**
   * 创建底层监听器（明文 net / TLS tls），把每条连接丢回 onConn
   * @param onConn - 连接回调（已归一为 Duplex）
   */
  protected abstract createListener(onConn: (s: Duplex) => void): net.Server;

  /**
   * 监听就绪钩子：供 TLS 分支挂 tlsClientError 等实例事件，基类默认空实现
   * @param s - 已就绪的 server 实例（基类不使用，保留供子类覆盖）
   */
  protected onListenerReady(s: net.Server): void {
    void s;
  }

  /**
   * 建服：createListener → listen → 绑运行期 error → onListenerReady → 记录 server
   * @throws listen 失败（如 EADDRINUSE）时抛错，由基类转 error 态
   */
  protected async doStart(): Promise<void> {
    const s = this.createListener((sock) => {
      void this.onConn(sock);
    });

    await listenAsync(s, this.options.port, this.options.host);

    s.on("error", (e) => {
      this.setState("error");
      this.log.error("server error:", e);
    });

    this.onListenerReady(s);

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
   * 单连接处理：登记连接 → 绑 close/error → 构造握手读取器 → 交会话处理器
   * @param socket - 客户端双工流（net.Socket / tls.TLSSocket as Duplex）
   */
  private async onConn(socket: Duplex): Promise<void> {
    this.conns.add(socket);
    socket.once("close", () => {
      this.conns.delete(socket);
    });
    socket.on("error", () => {
      socket.destroy();
    });

    const reader = new SocksHandshakeReader(socket, {
      timeout: this.options.upstreamTimeout,
      onTimeout: (d) => logClientTimeout(this.log, d),
      onInvalid: (d) => logBadRequest(this.log, d),
    });

    await this.runner(this.sessionHost(), socket, reader);
  }

  /**
   * 回失败应答并延时销毁（桥接 writeReplyAndClose）
   * @param socket - 待回复并关闭的连接
   * @param reply - 预拼应答 Buffer
   */
  protected replyAndClose(socket: Duplex, reply: Buffer): void {
    writeReplyAndClose(socket, reply);
  }

  /**
   * 构造会话宿主：用闭包桥接 protected 成员，供会话处理器调用
   * @returns 注入 protocol/forwarder/auth/log/authorize/replyAndClose 的宿主对象
   */
  private sessionHost(): SocksSessionHost {
    return {
      protocol: this.protocol,
      forwarder: this.forwarder,
      auth: this.auth,
      log: this.log,
      authorize: (ctx) => this.authorize(ctx),
      replyAndClose: (s, b) => this.replyAndClose(s, b),
    };
  }
}

/**
 * 明文 SOCKS 骨架：net.createServer 承载（socks4/socks5）
 */
export abstract class PlainSocksProxy extends SocksProxyBase {
  /**
   * 创建明文 net.Server
   * @param onConn - 连接回调（net.Socket as Duplex）
   */
  protected createListener(onConn: (s: Duplex) => void): net.Server {
    return net.createServer((sock) => {
      onConn(sock as unknown as Duplex);
    });
  }
}

/**
 * TLS SOCKS 骨架：tls.createServer 承载（sockss4/sockss5）
 * 证书在 onBeforeStart 预载（非 worker 打 lifecycle 日志），createListener 兜底加载
 */
export abstract class TlsSocksProxy extends SocksProxyBase {
  /** 已加载证书，onBeforeStart 预载，createListener 兜底加载 */
  private certs?: LoadedTlsCerts;

  /**
   * 预载证书：经 loadCerts 加载 TLS 证书，非 worker 打 lifecycle 日志
   */
  async onBeforeStart(): Promise<void> {
    if (!this.options.isWorker) {
      this.log.info(`[lifecycle] ${this.protocol} loading certs`);
    }
    this.certs = loadCerts(this.options.tls, this.log, this.protocol.toUpperCase());
  }

  /**
   * 创建 TLS 监听器：certs 兜底加载后按 key/cert/ca/passphrase 组装 tls.Server
   * @param onConn - 连接回调（tls.TLSSocket as Duplex）
   */
  protected createListener(onConn: (s: Duplex) => void): net.Server {
    if (!this.certs) {
      this.certs = loadCerts(this.options.tls, this.log, this.protocol.toUpperCase());
    }

    const { key, cert, ca, passphrase } = this.certs;

    return tls.createServer({ key, cert, passphrase, ca: ca ? [ca] : undefined }, (sock) => {
      onConn(sock as unknown as Duplex);
    });
  }

  /**
   * 监听就绪钩子：忽略 TLS 握手异常（如客户端非 TLS/证书不符），保持服务可用
   * @param s - 已就绪的 server（tls.Server）
   */
  protected onListenerReady(s: net.Server): void {
    (s as tls.Server).on("tlsClientError", () => {
      // 忽略 TLS 握手异常
    });
  }
}
