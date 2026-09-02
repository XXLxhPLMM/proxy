/**
 * ProxyServer - 代理服务端编排与进程生命周期
 * 职责：按 proxyProtocol 创建 HttpProxy/HttpsProxy/TlsProxy/SocksProxy，管理启停
 */

import cluster from "node:cluster";
import { get } from "@/config/store.js";
import "@/config/loader.js";
import { createAuthFromConfig } from "@/core/auth.js";
import type { ProxyCore, ProxyOptions } from "@/core/types.js";
import { HttpProxy } from "./http.js";
import { HttpsProxy } from "./https.js";
import { TlsProxy } from "./tls.js";
import { SocksProxy } from "./socks.js";
import { shouldRunAsMaster, runAsMaster } from "./cluster.js";
import { logger } from "@/utils/logger.js";
import { setupProcessGuards } from "@/utils/process-guards.js";
import { printBanner } from "@/utils/banner.js";
import { logConfig } from "./config-log.js";

/**
 * 协议工厂 - 按 store 中的 proxyProtocol 选择具体代理实现
 * 所有实现共享同一组选项：端口、鉴权提供者、上游超时、TLS 证书路径
 * （TLS 配置对 http/socks 等协议是惰性字段，仅在需要时被读取）
 */
function createProxy(isWorker = false): ProxyCore {
  const protocol = get("proxyProtocol");
  const auth = createAuthFromConfig();
  const baseOpts: ProxyOptions = {
    host: get("host"),
    port: get("port"),
    upstreamTimeout: get("upstreamTimeout"),
    tls: {
      key: get("tlsKey"),
      cert: get("tlsCert"),
      ca: get("tlsCa"),
      passphrase: get("tlsPassphrase"),
    },
    auth,
    isWorker,
  };

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

/**
 * 代理服务端编排器 - 进程级生命周期入口
 * 职责：装配配置 -> 工厂建代理 -> 启动 -> 信号处理 -> 优雅停止
 * 与 BaseProxy 的分工：本类只管「进程与编排」，协议内部状态机由 ProxyCore 子类负责
 */
export class ProxyServer {
  /** 当前运行的代理实例，start 成功后非空 */
  private proxy: ProxyCore | null = null;
  /** 停机防重入标记，避免多次 SIGINT 触发重复 stop */
  private shuttingDown = false;

  /**
   * 启动流程：
   * 1) 安装进程级容错守卫（未捕获异常仅记日志不退出）
   * 2) 打印脱敏后的配置快照（密码/密钥以 *** 代替），并对常见误配给出告警
   * 3) 工厂创建代理实例，订阅 stateChange 输出生命周期日志
   * 4) 绑定 SIGINT/SIGTERM 优雅停机，随后启动并输出运行态
   */
  async start(): Promise<ProxyCore> {
    setupProcessGuards();
    const isWorker = cluster.isWorker === true;

    if (!isWorker) {
      logConfig();
    }

    this.proxy = createProxy(isWorker);
    if (!isWorker) {
      (this.proxy as unknown as import("node:events").EventEmitter).on?.(
        "stateChange",
        (next: string, prev: string) => {
          logger.debug(
            `[lifecycle] state ${prev} -> ${next} protocol=${this.proxy?.protocol}`,
          );
        },
      );
    }

    this.bindSignals();
    await this.proxy.start();

    if (isWorker) {
      process.send?.({ type: "ready", pid: process.pid });
    } else {
      const stats = this.proxy.getStats();
      logger.info(
        `proxy started: ${stats.protocol}://${stats.host}:${stats.port} running=${stats.running} state=${this.proxy.state}`,
      );
      printBanner();
    }

    process.on("uncaughtExceptionMonitor", (err) => {
      logger.error("[monitor] 异常监控:", err);
    });
    return this.proxy;
  }

  /**
   * 优雅停止 - 带超时兜底
   * graceMs 内未能关闭则强制 process.exit(1)，防止长连接使停机挂死
   * timer.unref() 保证正常停机时不额外延长事件循环存活
   */
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
      await logger.flush();
      clearTimeout(timer);
    }
  }

  /** 获取当前代理实例（未启动为 null），供上层查询状态或注入 */
  getProxy(): ProxyCore | null {
    return this.proxy;
  }

  /**
   * 绑定中断信号：Ctrl+C / kill 时先优雅停机再以 0 退出
   * cluster worker 场景下 Windows 无法收到 master 转发的信号，
   * 故额外监听 IPC { type: "shutdown" } 消息触发同一条停机路径
   */
  private bindSignals(): void {
    const shutdown = () => {
      logger.infoSync("[shutdown] 代理已停止");
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    if (process.platform === "win32") {
      process.on("SIGBREAK", shutdown);
    }
    if (cluster.isWorker) {
      process.on("message", (msg: unknown) => {
        if (
          typeof msg === "object" &&
          msg !== null &&
          (msg as { type?: string }).type === "shutdown"
        ) {
          shutdown();
        }
      });
    }
  }
}

/**
 * 便捷入口 - 供 src/index.ts 在 require.main 分支调用
 * clusterWorkers > 1 时以 master 身份 fork 并托管 worker，否则当前进程直接启动代理
 */
export async function runServer(): Promise<void> {
  if (shouldRunAsMaster()) {
    await runAsMaster();
    return;
  }
  const app = new ProxyServer();
  await app.start();
}
