/**
 * ProxyServer - 代理服务端编排与进程生命周期
 * 职责：按 proxyProtocol 创建 HttpProxy/HttpsProxy/TlsProxy/SocksProxy，管理启停
 */

import cluster from "node:cluster";
import { get } from "@/config/store.js";
import "@/config/loader.js";
import { createAuthFromConfig } from "@/core/auth.js";
import type { PipeEvent } from "@/core/types/pipe.js";
import type {
  ProxyAuthEvent,
  ProxyClientErrorEvent,
  ProxyCore,
  ProxyForwardErrorEvent,
  ProxyForwardEvent,
  ProxyOptions,
  ProxyServerErrorEvent,
} from "@/core/types/proxy.js";
import { createProxy as createCoreProxy } from "@/core/server/factory.js";
import { shouldRunAsMaster, runAsMaster } from "./cluster.js";
import { logger } from "@/utils/logger.js";
import {
  logBadRequest,
  logLoopDetected,
  logTargetUnresolved,
  logUpstreamRefused,
} from "@/server/log/events-log.js";
import { setupProcessGuards } from "@/utils/process-guards.js";
import { getClientAddress, getAuthority } from "@/utils/ip.js";
import { printBanner } from "@/utils/banner.js";
import { logConfig } from "./log/config-log.js";

/** forwardError 日志名前缀：kind -> 函数名，Record 保证新增 kind 时编译期必补 */
const FORWARD_ERROR_LABEL: Record<ProxyForwardErrorEvent["kind"], string> = {
  http: "forwardHttp",
  tunnel: "forwardTunnel",
  upgrade: "forwardUpgrade",
};

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
  return createCoreProxy(protocol, baseOpts);
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
   * 代理事件日志订阅 - server/core 层只抛不记，日志收拢于此（http/https 链经此记，socks/tls 自记）
   * 订阅不分 worker：单进程与 worker 的转发日志行为一致
   */
  private bindProxyEventLogs(): void {
    const proxy = this.proxy as unknown as import("node:events").EventEmitter;
    const on = (event: string, listener: (...args: any[]) => void): void => {
      proxy.on?.(event, listener);
    };
    on("forward", ((e: ProxyForwardEvent) => {
      // 懒求值：client/target/headers 只在真正要打日志时才解析 req
      const client = getClientAddress(e.req);
      const target = getAuthority(e.req) || "-";
      const headers = e.req.headers;
      switch (e.kind) {
        case "http": {
          logger.debug(`[http] headers ${client} -> ${target} ${JSON.stringify(headers)}`);
          logger.info(`[forward] ${client} -> ${target} ${e.req.method ?? "GET"}`);
          break;
        }
        case "tunnel": {
          logger.debug(`[tunnel] headers ${client} -> ${target} ${JSON.stringify(headers)}`);
          logger.info(`[tunnel] ${client} -> ${target} CONNECT`);
          break;
        }
        case "upgrade": {
          logger.debug(`[upgrade] headers ${client} -> ${target} ${JSON.stringify(headers)}`);
          logger.info(`[upgrade] ${client} -> ${target} ${e.req.method ?? "GET"}`);
          break;
        }
        default: {
          e.kind satisfies never;
          break;
        }
      }
    }) as (...args: any[]) => void);
    on("forwardError", ((e: ProxyForwardErrorEvent) => {
      const label = FORWARD_ERROR_LABEL[e.kind] ?? "forwardUnknown";
      logger.error(`${label} error`, e.error);
    }) as (...args: any[]) => void);
    on("serverError", ((e: ProxyServerErrorEvent) => {
      logger.error(`server error (${e.host}:${e.port}):`, e.error);
    }) as (...args: any[]) => void);
    on("clientError", ((e: ProxyClientErrorEvent) => {
      logBadRequest(logger, `client error: ${e.error.message}`);
    }) as (...args: any[]) => void);
    on("auth", ((e: ProxyAuthEvent) => {
      // allow 是逐请求的常规成功（与 [forward] 成功行重复）-> debug；deny 是预期内拒绝，info 留审计
      if (e.passed) {
        logger.debug(`[auth] allow ${e.tag}${e.client} -> ${e.target} user=${e.user || "-"}`);
      } else {
        const reason = e.reason ? ` reason=${e.reason}` : "";
        logger.info(
          `[auth] deny ${e.tag}${e.client} -> ${e.target} attempted=${e.attempted ?? "-"} expected=${e.expected || "-"}${reason}`,
        );
      }
    }) as (...args: any[]) => void);
    on("listening", ((e: { host: string; port: number }) => {
      logger.debug(`listening on ${e.host}:${e.port}`);
    }) as (...args: any[]) => void);
    on("close", (() => {
      logger.debug("server closed");
    }) as (...args: any[]) => void);
    on("pipe", ((e: PipeEvent) => {
      switch (e.type) {
        case "target-unresolved": {
          logTargetUnresolved(logger, e.url as string | undefined);
          break;
        }
        case "loop-detected": {
          const req = e.req as { method?: string; url?: string } | undefined;
          logLoopDetected(logger, `${req?.method} ${req?.url} -> ${e.target as string}`);
          break;
        }
        case "upstream-refused": {
          logUpstreamRefused(logger, e.statusLine as string);
          break;
        }
        case "route": {
          const req = e.req as { method?: string; url?: string } | undefined;
          logger.debug(
            () =>
              `[${e.kind as string}] ${req?.method} ${req?.url} -> ${e.target as string}${e.note ? ` (${e.note as string})` : ""} (mode: ${e.mode as string})`,
          );
          break;
        }
        case "socks": {
          logger.info(e.message as string);
          break;
        }
        case "debug": {
          logger.debug(e.message as string);
          break;
        }
        default: {
          (e as { type: string }).type satisfies string;
          logger.debug((e.message as string) ?? String((e as Record<string, unknown>).type));
          break;
        }
      }
    }) as (...args: any[]) => void);
  }

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
          logger.debug(`[lifecycle] state ${prev} -> ${next} protocol=${this.proxy?.protocol}`);
        },
      );
    }
    this.bindProxyEventLogs();

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
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    if (!this.proxy) {
      return;
    }
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
    const shutdown = (): void => {
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
