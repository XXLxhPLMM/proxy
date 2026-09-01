/**
 * HTTPS 代理核心 - TLS 之上的 HTTP 代理（原生 https 实现）
 * 文件职责：
 * - 继承 HttpProxy，协议固定 https，生命周期 onBeforeStart 加载证书（store tlsKey/tlsCert，相对路径以 cwd 解析）
 * - doStart 以 https.createServer({key,cert}) 监听 request/connect，复用 HttpProxy 的 forwardHttp/forwardTunnel
 * - 客户端需先 TLS 握手再发 HTTP/CONNECT，服务端证书默认 keys/server.crt/key（CLI TLS_CERT/TLS_KEY/env 可覆）
 * 关联：store tls*、utils/constants、BaseProxy 状态机、HttpProxy
 */

import https from "node:https";
import type { ProxyOptions } from "../core/types.js";
import { getLogger } from "../utils/logger.js";
import { loadCerts, extractTlsPaths } from "../utils/cert.js";
import { HttpProxy } from "./http.js";

/**
 * HTTPS 代理实现类
 * 继承 HttpProxy，复用 forwardHttp/forwardTunnel，仅将底层 http.Server 替换为 https.Server
 */
export class HttpsProxy extends HttpProxy {
  /** 底层 HTTPS 服务实例，未启动时为 null */
  private httpsServer: https.Server | null = null;
  private readonly httpsLog = getLogger("HttpsProxy");

  /**
   * 构造 HTTPS 代理
   * @param options - 端口与地址，auth 由 createAuthFromConfig 注入
   */
  constructor(options: ProxyOptions = {}) {
    super(options);
  }

  /** 预加载证书缓存，避免每次 doStart 重复读盘 */
  private certs?: { key: Buffer; cert: Buffer };

  /**
   * 启动前钩子 - 加载证书
   */
  async onBeforeStart(): Promise<void> {
    this.httpsLog.info(`[lifecycle] https loading certs key=${this.options.tls?.key} cert=${this.options.tls?.cert}`);
    this.certs = loadCerts(extractTlsPaths(this.options.tls), this.httpsLog, "HTTPS");
  }

  /** 启动后钩子 - 探针日志 */
  async onStarted(): Promise<void> {
    this.httpsLog.info(`[lifecycle] https started ${this.options.host}:${this.options.port} state=${this.state}`);
  }

  /**
   * 真实建服 - 覆写 HttpProxy.doStart
   * 使用 https.Server 替代 http.Server，其余逻辑复用 HttpProxy
   */
  protected override async doStart(): Promise<void> {
    if (!this.certs) this.certs = loadCerts(extractTlsPaths(this.options.tls), this.httpsLog, "HTTPS");
    const { key, cert } = this.certs;
    const passphrase = (this.options.tls?.passphrase as string) || undefined;

    const server = https.createServer({ key, cert, passphrase }, (req, res) => {
      this.forwardHttp(req, res);
    });

    server.on("connect", (req, socket, head) => {
      this.forwardTunnel(req, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    server.on("error", (err) => {
      this.setState("error");
      this.httpsLog.error(`server error (${this.options.host}:${this.options.port}):`, err);
    });
    server.on("clientError", (err, socket) => {
      this.httpsLog.warn("clientError:", (err as Error).message);
      try {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      } catch {}
    });

    this.httpsServer = server;
  }

  /**
   * 真实关服 - 覆写 HttpProxy.doStop
   */
  protected override async doStop(): Promise<void> {
    if (!this.httpsServer) return;
    await new Promise<void>((resolve) => this.httpsServer!.close(() => resolve()));
    this.httpsServer = null;
  }

  /**
   * 是否运行中 - 覆写 HttpProxy.isRunning
   */
  override isRunning(): boolean {
    return !!this.httpsServer?.listening;
  }

}

export function createHttpsProxy(options?: ProxyOptions): HttpsProxy {
  return new HttpsProxy(options);
}
