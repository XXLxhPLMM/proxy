/**
 * SOCKS 代理骨架 - 四个 SOCKS server 共用的生命周期与连接登记
 * 职责：
 * - 收敛 socks4/socks5/sockss4/sockss5 逐字重复的模板方法：doStart（建服+listen，connection 登记原始 socket）/ doStop（close + registry.drain 排空）
 * - 收敛单连接处理：registry 登记 + error 销毁，构造握手读取器后交会话处理器（socks-session.ts）
 * - 收敛转发器单例与日志器（协议名前缀）；pipe 事件转抛
 * 设计：
 * - 明文（PlainSocksProxy）与 TLS（TlsSocksProxy）差异只在 createListener 与证书加载，抽出为导出中间类
 * - **原始 socket 在 `connection` 事件登记**（不只靠 onConn）：TLS 握手未完成的连接永远到不了
 *   `secureConnection`，只登记 onConn 会让 drain 拆不掉它们、`server.close` 回调永不兑现
 * - 会话逻辑经 SocksSessionHost 注入，骨架不感知 socks4/socks5 分支（见 socks-session.ts）
 * - sessionHost/authorize 用闭包桥接 protected 成员，避免把 auth/authorize 暴露到接口之外
 * - 可见差异：日志前缀由「BaseProxy/Sockss4Proxy…」统一为协议名（socks4/socks5/sockss4/sockss5）
 */
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { BaseProxy } from "./base.js";
import type { ProxyOptions, ProxyProtocol } from "@/core/types/proxy.js";
import { checkClientIp } from "@/config/acl.js";
import { SocksForwarder } from "@/core/forward/socks.js";
import { SocksHandshakeReader } from "@/core/forward/socks-reader.js";
import { listenAsync } from "@/utils/net/listen.js";
import { getSocketAddress } from "@/utils/net/socket.js";
import { getLogger } from "@/utils/log/logger.js";
import {
  bindTlsClientError,
  loadCerts,
  requiresClientCert,
  tlsServerOptions,
  type LoadedTlsCerts,
} from "@/utils/net/tls.js";
import { writeReplyAndClose } from "@/core/proxy-helpers.js";
import { logBadRequest, logClientTimeout, logTlsClientError } from "@/utils/log/events.js";
import type { SocksSessionHost, SocksSessionRunner } from "./socks-session.js";

/**
 * 握手失败日志的等级：本次连接已读 0 字节 = 裸 TCP 探活（端口扫描/健康检查），降到 debug；
 * 已读到任何字节 = 真实握手失败，维持事件默认等级。
 * @param bytesReceived - 本次连接已读字节数（读取器统计，只增不减）
 */
function levelForBytes(bytesReceived: number): "debug" | undefined {
  return bytesReceived === 0 ? "debug" : undefined;
}

/**
 * SOCKS 代理骨架：BaseProxy 的 SOCKS 分支
 * 明文与 TLS 两态共用建服/关服/连接登记/会话委派，仅 createListener 与证书加载不同
 */
export abstract class SocksProxyBase extends BaseProxy {
  /**
   * 底层服务实例（net.Server，tls.Server extends net.Server）
   * 未启动为 null；只在 closeServer resolve（关服兑现）后置空，关服失败保留引用供重试
   */
  protected server: net.Server | null = null;

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
  constructor(
    protocol: ProxyProtocol,
    o: ProxyOptions,
    private readonly runner: SocksSessionRunner,
  ) {
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
   * 建服：createListener → 登记 connection 原始 socket → listen → 绑运行期 error → onListenerReady → 记录 server
   * 引用只在 listen 兑现后写入（失败不留半初始化引用）；关服侧对称：只在 close 兑现后清空
   * @throws listen 失败（如 EADDRINUSE）时抛错，由基类转 error 态
   */
  protected async doStart(): Promise<void> {
    // connection 登记（**listen 之前**绑，不给未登记窗口留缝）：
    // TLS 分支的关键补漏——`tls.createServer(options, listener)` 的 listener 挂在
    // `secureConnection` 上，只在握手成功后才跑；握手未完成/失败的连接只出现在 `connection`
    // 事件里（tls.Server 内部监听器随后把 raw socket 包成 TLSSocket）。若只在 onConn 登记，
    // 握手未完成的 socket 永远不在 registry 里：停机 drain 拆不掉它，`server.close` 的回调
    // 也就永远不兑现（`close` 只停 accept，不动存量连接）。明文分支与 onConn 拿到同一对象，
    // `ConnRegistry.track` 的 Set 按 identity 去重，不会重复计数。
    const s = this.createListener((sock) => {
      // onConn 是 async：会话处理器意外抛错不得成为 unhandledRejection。
      // 销毁连接并经 clientError 上抛（core 零日志），落盘归 bindProxyEventLogs
      void this.onConn(sock).catch((error: unknown) => {
        sock.destroy();
        try {
          this.emit("clientError", {
            error: error instanceof Error ? error : new Error(String(error)),
          });
        } catch {
          // 监听器抛错不得反向污染已销毁的连接
        }
      });
    });
    s.on("connection", (socket: net.Socket) => {
      this.registry.track(socket);
    });

    await listenAsync(s, this.options.port, this.options.host);

    s.on("error", (e) => {
      // core 零日志：与 http 同形经 serverError 上抛，落盘归 bindProxyEventLogs。
      // 传输层 error 不越权改生命周期；stopping 期间仍由 runStop 收口为 stopped。
      this.emit("serverError", { error: e, host: this.options.host, port: this.options.port });
    });

    this.onListenerReady(s);

    this.server = s;
  }

  /**
   * 关服：先 close 拒绝新连接，再经 registry.drain 强制销毁存量连接（idle 连接会导致 close 回调迟迟不触发）
   * （close + 排空收口在基类 `closeServer` 模板；net.Server 无原生 closeAllConnections，走手动销毁）
   * 引用只在 closeServer resolve 之后清空：close 回调带 error（如 ERR_SERVER_NOT_RUNNING）时 reject，
   * 保留引用让 stop 落 error 态并可重试，绝不把仍 listening 的 server 洗成 stopped
   * 无 server 时直接返回（幂等）
   */
  protected async doStop(): Promise<void> {
    const s = this.server;

    if (!s) {
      return;
    }

    // 先 await closeServer 再置空：排空/close 没兑现时保留引用，失败重试仍命中同一个 server
    await this.closeServer(s);

    // identity 比对：期间若已被别的实例接管（理论上被 start 闸门禁止），不误清新引用
    if (this.server === s) {
      this.server = null;
    }
  }

  /**
   * 单连接处理：先过客户端名单 → 登记连接 → 绑 error → 构造握手读取器 → 交会话处理器
   * @param socket - 客户端双工流（net.Socket / tls.TLSSocket as Duplex）
   */
  private async onConn(socket: Duplex): Promise<void> {
    // 客户端名单最先判定：握手前直接丢弃——SOCKS 在握手完成前无可回报文，
    // 也避免为被禁来源解析握手（只认 TCP 对端地址，不看可伪造的 XFF）；
    // 拒绝经 pipe 的 `ip-denied` 事件上抛（与 http 分支同形，server/index.ts 统一落盘），不直接记日志
    const client = getSocketAddress(socket);
    const ip = checkClientIp(client);
    if (!ip.allowed) {
      this.emit("pipe", {
        type: "ip-denied",
        client,
        reason: ip.reason,
        protocol: this.protocol,
      });
      socket.destroy();
      return;
    }

    this.registry.track(socket);
    socket.on("error", () => {
      socket.destroy();
    });

    const reader = new SocksHandshakeReader(socket, {
      timeout: this.options.upstreamTimeout,
      // 等级只看「本次连接已读字节数」：0 字节 = 裸 TCP 探活/扫描/健康检查（connect 后不发
      // 任何字节就断，或干脆不发），是环境噪音，降到 debug；读到过任何字节的真实握手失败
      // （超时/缓冲超限/格式非法）维持 warn 与原结构化字段。判据是字节数而非错误码文本。
      onTimeout: (d, bytes) => logClientTimeout(this.log, d, undefined, levelForBytes(bytes)),
      onInvalid: (d, bytes) => logBadRequest(this.log, d, undefined, levelForBytes(bytes)),
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
   * @returns 注入 protocol/forwarder/auth/authorize/replyAndClose 的宿主对象
   */
  private sessionHost(): SocksSessionHost {
    return {
      protocol: this.protocol,
      forwarder: this.forwarder,
      auth: this.auth,
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
 * 证书在 onBeforeStart 预载，createListener 兜底加载
 * 配了 tlsCa 即强制校验客户端证书（mTLS）：握手期 rejectUnauthorized 拦截，
 * 握手后 authorized 兜底守卫（未授权连接不得进入 SOCKS 会话）
 */
export abstract class TlsSocksProxy extends SocksProxyBase {
  /** 已加载证书，onBeforeStart 预载，createListener 兜底加载 */
  private certs?: LoadedTlsCerts;

  /**
   * 预载证书：经 loadCerts 加载 TLS 证书（失败落盘由注入的 logger 负责，core 零日志）
   */
  async onBeforeStart(): Promise<void> {
    this.certs = loadCerts(this.options.tls, this.log, this.protocol.toUpperCase());
  }

  /**
   * 创建 TLS 监听器：certs 兜底加载后经 tlsServerOptions 组装 tls.Server
   * @param onConn - 连接回调（tls.TLSSocket as Duplex）
   */
  protected createListener(onConn: (s: Duplex) => void): net.Server {
    if (!this.certs) {
      this.certs = loadCerts(this.options.tls, this.log, this.protocol.toUpperCase());
    }

    // ca 非空 ⇒ 强制客户端证书（requestCert/rejectUnauthorized 已在 tlsServerOptions 同源置位）
    const mTLS = requiresClientCert(this.certs);

    return tls.createServer(tlsServerOptions(this.certs), (sock) => {
      // 兜底：握手已完成但客户端证书未通过校验的连接绝不能进入 SOCKS 会话
      if (mTLS && !sock.authorized) {
        logTlsClientError(this.log, `${this.protocol} 客户端证书未通过校验`, undefined, {
          authorizationError: sock.authorizationError,
        });
        sock.destroy();
        return;
      }
      onConn(sock as unknown as Duplex);
    });
  }

  /**
   * 监听就绪钩子：TLS 握手失败（非 TLS 客户端 / 证书不符 / mTLS 拒绝）只记 warn，不断服
   * 接线收敛在 utils/net/tls.ts:bindTlsClientError，与 https 分支共用一份实现
   * @param s - 已就绪的 server（tls.Server）
   */
  protected onListenerReady(s: net.Server): void {
    bindTlsClientError(s as tls.Server, this.log, this.protocol);
  }
}
