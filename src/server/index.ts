/**
 * ProxyServer - 代理服务端编排与进程生命周期
 * 职责：按 proxyProtocol 创建 HttpProxy/HttpsProxy/TlsProxy/SocksProxy，管理启停
 */

import { get, getAll } from "../config/store.js";
import "../config/loader.js";
import { createAuthFromConfig } from "../core/auth.js";
import type { ProxyCore } from "../core/types.js";
import { HttpProxy } from "./http.js";
import { HttpsProxy } from "./https.js";
import { TlsProxy } from "./tls.js";
import { SocksProxy } from "./socks.js";
import { logger } from "../utils/logger.js";
import { setupProcessGuards } from "../utils/process-guards.js";

function createProxy(): ProxyCore {
  const protocol = get("proxyProtocol");
  const port = get("port");
  const auth = createAuthFromConfig();
  const upstreamTimeout = get("upstreamTimeout");
  const tls = { key: get("tlsKey"), cert: get("tlsCert"), ca: get("tlsCa"), passphrase: get("tlsPassphrase") };
  const baseOpts = { port, auth, upstreamTimeout, tls };

  switch (protocol) {
    case "http":
      return new HttpProxy(baseOpts);
    case "https":
      return new HttpsProxy(baseOpts);
    case "socks":
      return new SocksProxy(baseOpts);
    case "tls":
      return new TlsProxy(baseOpts);
    default:
      throw new Error(`未知代理协议: ${protocol}`);
  }
}

export class ProxyServer {
  private proxy: ProxyCore | null = null;
  private shuttingDown = false;

  async start(): Promise<ProxyCore> {
    setupProcessGuards();
    const all = getAll();
    const safeAll = { ...all, authPassword: all.authPassword ? "***" : "", jwtSecret: all.jwtSecret ? "***" : "" };
    logger.debug("=== config ===", safeAll);
    if (all.authEnabled) {
      if (all.authType === "basic") {
        logger.info(`[config] auth ENABLED type=basic username=${all.authUsername || "(empty)"} password=${all.authPassword ? "***已设置" : "(empty)"}`);
        if (!all.authUsername || !all.authPassword) logger.warn("[config] auth basic 已开启但用户名或密码为空，鉴权将全部拒绝");
      } else if (all.authType === "jwt") {
        logger.info(`[config] auth ENABLED type=jwt jwtSecret=${all.jwtSecret ? "***已设置" : "(empty)"}`);
        if (!all.jwtSecret) logger.warn("[config] auth jwt 已开启但 JWT_SECRET 为空，鉴权将全部拒绝");
      } else {
        logger.warn(`[config] auth ENABLED 但 authType=${all.authType} 非 basic/jwt，将视为放行`);
      }
    } else {
      logger.info("[config] auth DISABLED 鉴权关闭，所有请求放行");
    }
    if (all.proxyProtocol === "https" || all.proxyProtocol === "tls") {
      logger.info(`[config] tls cert paths key=${all.tlsKey} cert=${all.tlsCert} ca=${all.tlsCa} protocol=${all.proxyProtocol}`);
    }

    this.proxy = createProxy();
    (this.proxy as unknown as import("node:events").EventEmitter).on?.("stateChange", (next: string, prev: string) => {
      logger.info(`[lifecycle] state ${prev} -> ${next} protocol=${this.proxy?.protocol}`);
    });

    this.bindSignals();
    await this.proxy.start();
    const stats = this.proxy.getStats();
    logger.info(`proxy started: ${stats.protocol}://${stats.host}:${stats.port} running=${stats.running} state=${this.proxy.state}`);
    process.on("uncaughtExceptionMonitor", (err) => {
      logger.error("[monitor] 异常监控:", err);
    });
    return this.proxy;
  }

  async stop(graceMs = 10000): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (!this.proxy) return;
    const timer = setTimeout(() => {
      logger.warn(`[shutdown] 优雅停止超时 ${graceMs}ms，强制退出`);
      process.exit(1);
    }, graceMs);
    timer.unref();
    try {
      await this.proxy.stop();
      logger.info("[shutdown] 代理已停止");
    } catch (err) {
      logger.error("[shutdown] 停止代理失败:", err);
    } finally {
      clearTimeout(timer);
    }
  }

  getProxy(): ProxyCore | null {
    return this.proxy;
  }

  private bindSignals(): void {
    const handler = async () => {
      await this.stop();
      process.exit(0);
    };
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
  }
}

export async function runServer(): Promise<void> {
  const app = new ProxyServer();
  await app.start();
}
