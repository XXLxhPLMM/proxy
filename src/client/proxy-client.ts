/**
 * ProxyClient - 代理客户端（http + socks 统一封装）
 * 职责：按 protocol 选择 HttpProxyClient / SocksProxyClient，提供统一 get/connect 入口
 * - http：走 HTTP 代理 GET（path 为完整 URL）或 CONNECT 隧道
 * - socks：走 SOCKS5 over TLS/明文 的握手+CONNECT，中转后 pipe
 * 关联：client/http、client/socks、config/store（fromConfig 读取 remote*）
 */

import { get } from "../config/store.js";
import { logger } from "../utils/logger.js";
import { HttpProxyClient, type HttpProxyClientOptions } from "./http.js";
import { SocksProxyClient, type SocksProxyClientOptions } from "./socks.js";

export interface ProxyClientOptions extends HttpProxyClientOptions, SocksProxyClientOptions {
  protocol: "http" | "socks";
}

export class ProxyClient {
  readonly protocol: "http" | "socks";
  private readonly httpClient: HttpProxyClient;
  private readonly socksClient: SocksProxyClient;

  constructor(opts: ProxyClientOptions) {
    this.protocol = opts.protocol;
    this.httpClient = new HttpProxyClient(opts);
    this.socksClient = new SocksProxyClient(opts);
  }

  /** 从全局 config（store）创建客户端，自动取 remote* 目标服务器地址与鉴权 */
  static fromConfig(protocol?: "http" | "socks"): ProxyClient {
    const p = (protocol ?? (get("proxyProtocol") === "socks" ? "socks" : "http")) as "http" | "socks";
    const host = get("remoteHost");
    const port = get("remotePort");
    const secure = get("remoteSecure");
    const username = get("remoteUsername");
    const password = get("remotePassword");
    const ca = get("remoteCa");
    const insecure = get("remoteInsecure");
    return new ProxyClient({ protocol: p, host, port, secure, username, password, ca, insecure, timeout: get("upstreamTimeout") });
  }

  /** 统一 GET：http 走代理 GET，socks 走隧道后 GET */
  async get(targetUrl: string): Promise<{ statusCode: number; body: Buffer; raw?: Buffer; headers?: unknown }> {
    if (this.protocol === "http") return this.httpClient.get(targetUrl);
    return this.socksClient.get(targetUrl);
  }

  /** 统一隧道：http 发 CONNECT 建管，socks 发 SOCKS5 CONNECT */
  async connect(targetHost: string, targetPort: number) {
    if (this.protocol === "http") return this.httpClient.connect(targetHost, targetPort);
    return this.socksClient.connect(targetHost, targetPort);
  }
}

/** 进程级容错：复用服务端守卫逻辑，避免未捕获异常击穿客户端服务 */
function setupClientGuards(): void {
  if ((globalThis as unknown as { __proxyClientGuardsInstalled?: boolean }).__proxyClientGuardsInstalled) return;
  (globalThis as unknown as { __proxyClientGuardsInstalled: boolean }).__proxyClientGuardsInstalled = true;
  process.on("uncaughtException", (err) => {
    logger.error("[client uncaughtException] 继续运行:", err);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("[client unhandledRejection] 继续运行:", reason);
  });
  process.on("warning", (warning) => {
    logger.warn("[client warning]", warning.name, warning.message);
  });
}

/**
 * 客户端服务编排器 - 本地监听 + 上游转发 + 链式鉴权穿透
 * 对应需求：
 * 1) 客户端本身就是代理服务，可配置下游暴露协议与上游目标协议
 * 2) 下游鉴权(auth*) 与上游鉴权(remote*) 正交，可独立开关
 * 3) 多级串联时 鉴权穿透：本级无鉴权透传，有鉴权则消费剥离
 */
export class ProxyClientServer {
  private proxy: import("../core/types.js").ProxyCore | null = null;
  private shuttingDown = false;

  async start(): Promise<import("../core/types.js").ProxyCore> {
    setupClientGuards();
    const { getAll } = await import("../config/store.js");
    const { createAuthFromConfig } = await import("../core/auth.js");
    const { createClientForwardProxy } = await import("./forward-proxy.js");
    const all = getAll();
    const safeAll = { ...all, authPassword: all.authPassword ? "***" : "", jwtSecret: all.jwtSecret ? "***" : "", remotePassword: all.remotePassword ? "***" : "" };
    logger.debug("=== client config ===", safeAll);
    if (all.authEnabled) {
      logger.info(`[client config] downstream auth ENABLED type=${all.authType} user=${all.authUsername || "(empty)"}`);
    } else {
      logger.info("[client config] downstream auth DISABLED 对外放行，鉴权头将透传至上游");
    }
    logger.info(`[client config] listen ${all.proxyProtocol}://${all.port} -> upstream ${all.upstreamProtocol}://${all.remoteHost}:${all.remotePort} secure=${all.remoteSecure}`);

    const localAuth = createAuthFromConfig();
    const upstream = {
      host: all.remoteHost,
      port: all.remotePort,
      protocol: all.upstreamProtocol as "http" | "https" | "socks" | "tls",
      secure: all.remoteSecure,
      username: all.remoteUsername,
      password: all.remotePassword,
      ca: all.remoteCa,
      insecure: all.remoteInsecure,
      timeout: all.upstreamTimeout,
    };
    const tls = { key: all.tlsKey, cert: all.tlsCert, ca: all.tlsCa, passphrase: all.tlsPassphrase };
    this.proxy = createClientForwardProxy({ port: all.port, upstream, localAuth, upstreamTimeout: all.upstreamTimeout, tls });

    (this.proxy as unknown as import("node:events").EventEmitter).on?.("stateChange", (next: string, prev: string) => {
      logger.info(`[client lifecycle] state ${prev} -> ${next} protocol=${this.proxy?.protocol}`);
    });
    this.bindSignals();
    await this.proxy.start();
    const stats = this.proxy.getStats();
    logger.info(`client proxy started: ${stats.protocol}://${stats.host}:${stats.port} -> upstream ${upstream.protocol}://${upstream.host}:${upstream.port} running=${stats.running}`);
    return this.proxy;
  }

  async stop(graceMs = 10000): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (!this.proxy) return;
    const timer = setTimeout(() => {
      logger.warn(`[client shutdown] 超时 ${graceMs}ms 强制退出`);
      process.exit(1);
    }, graceMs);
    timer.unref();
    try {
      await this.proxy.stop();
      logger.info("[client shutdown] 已停止");
    } catch (err) {
      logger.error("[client shutdown] 失败:", err);
    } finally {
      clearTimeout(timer);
    }
  }

  getProxy(): import("../core/types.js").ProxyCore | null { return this.proxy; }

  private bindSignals(): void {
    const handler = async () => { await this.stop(); process.exit(0); };
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
  }
}

/** 客户端启动入口（供 src/index.ts 直接执行时调用），现为真服务：本地监听 + 上游转发 */
export async function runClient(): Promise<void> {
  const app = new ProxyClientServer();
  await app.start();
}
