/**
 * ProxyServer - CLI 进程包装器
 *
 * 库调用方请使用 `createProxyRuntime()`；本类只负责 CLI 进程级职责：
 * 配置初始化后的快照打印、进程守卫、信号、cluster ready/shutdown 与退出兜底。
 */

import cluster from "node:cluster";
import type { ConfigContext } from "@/config/accessor.js";
import { EventHub, type EventContext, type EventSubscription } from "@/core/events/index.js";
import type { PipeEvent } from "@/core/types/pipe.js";
import type {
  ProxyAuthEvent,
  ProxyClientErrorEvent,
  ProxyCore,
  ProxyEventMap,
  ProxyForwardErrorEvent,
  ProxyForwardEvent,
  ProxyServerErrorEvent,
} from "@/core/types/proxy.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { ProxyRuntime } from "@/runtime/index.js";
import { shouldRunAsMaster, runAsMaster } from "./cluster.js";
import { createLogger, type LoggerImpl } from "@/utils/logger.js";
import {
  logBadRequest,
  logIpDenied,
  logLoopDetected,
  logTargetDenied,
  logTargetUnresolved,
  logUpstreamError,
  logUpstreamRefused,
  logUpstreamTimeout,
} from "@/server/log/events-log.js";
import { getClientAddress, getAuthority } from "@/utils/ip.js";
import { printBanner } from "@/utils/banner.js";

/** forwardError 日志名前缀：kind -> 函数名，Record 保证新增 kind 时编译期必补 */
const FORWARD_ERROR_LABEL: Record<ProxyForwardErrorEvent["kind"], string> = {
  http: "forwardHttp",
  tunnel: "forwardTunnel",
  upgrade: "forwardUpgrade",
};

/** debug 头 dump 的敏感头（小写）：命中一律掩码，凭证/会话绝不出现在日志 */
const SENSITIVE_HEADERS = new Set(["proxy-authorization", "authorization", "cookie"]);

/**
 * core 的低层事件与 runtime 的公共事件是两套有意分离的契约：
 * `ProxyEventMap` 保留完整请求对象（forward/pipe 等），而 `EventHub` 负责
 * runtime 生命周期与可组合的观察面。CLI 日志总线把前者同步桥到后者，既不
 * 把 Node EventEmitter 暴露到 server 业务代码，也不丢原始 payload。
 */
type ProxyEventName = Exclude<keyof ProxyEventMap, "stateChange">;
type ProxyEventData<K extends ProxyEventName> = ProxyEventMap[K] extends [infer Data]
  ? Data
  : undefined;

interface ProxyEventEnvelope<K extends ProxyEventName> {
  readonly name: K;
  readonly context: EventContext;
  readonly data: ProxyEventData<K>;
  readonly timestamp: number;
}

/** server 日志侧的 EventHub 视图；额外事件名只在本地桥接，不扩张公共 AppEventMap。 */
interface ProxyEventBus {
  subscribe<K extends ProxyEventName>(
    name: K,
    listener: (event: ProxyEventEnvelope<K>) => void,
  ): EventSubscription;
  publish<K extends ProxyEventName>(name: K, data: ProxyEventData<K>): void;
}

/** BaseProxy 的强类型 emitter 端口；ProxyCore 的公共接口刻意不暴露 EventEmitter。 */
interface ProxyEventSource {
  on<K extends ProxyEventName>(
    name: K,
    listener: (data: ProxyEventData<K>) => void,
  ): unknown;
  off<K extends ProxyEventName>(
    name: K,
    listener: (data: ProxyEventData<K>) => void,
  ): unknown;
}

function asProxyEventBus(hub: EventHub): ProxyEventBus {
  // EventHub 的公共事件类型不含 core 低层事件；这里只在 server 内建立同步桥。
  return hub as unknown as ProxyEventBus;
}

function asProxyEventSource(proxy: ProxyCore): ProxyEventSource {
  return proxy as unknown as ProxyEventSource;
}

/**
 * 掩码敏感请求头 - debug 级 headers dump 防凭证泄漏
 * @description `proxy-authorization` / `authorization` / `cookie`（大小写不敏感，值可为数组）
 * 一律替换为 `"***"`，其余头原样保留
 * @param headers - req.headers 原文
 * @returns 掩码后的新对象（不改动入参）
 */
function maskSensitiveHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const masked: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    masked[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? "***" : value;
  }
  return masked;
}

/** ProxyServer 构造注入位；配置与 logger 都由本次进程显式持有。 */
export interface ProxyServerOptions {
  /** 本进程加载得到的配置上下文；runtime/auth/日志/cluster 共享同一 store。 */
  context: ConfigContext;
  /** 注入完整 runtime（测试/嵌入高级用法）；缺省由 context 创建。 */
  runtime?: ProxyRuntime;
  /** 未注入 runtime 时传给库 runtime 的事件总线。 */
  events?: EventHub;
  /** 未注入时按 context.accessor 创建独立 logger。 */
  logger?: LoggerImpl;
  /** 是否禁用 banner ANSI 色码；由 CLI 从宿主 NO_COLOR 快照后显式传入。 */
  noColor?: boolean;
  /** 覆盖 cluster worker 判定，主要供测试注入；缺省读取 cluster.isWorker。 */
  isWorker?: boolean;
}

/**
 * 代理服务端编排器 - 纯 CLI 进程包装器。
 *
 * 代理核心由 `createProxyRuntime()` 承载；本类只叠加 CLI 进程职责，绝不把
 * loader、信号、cluster 或日志落盘带进库 runtime 的生命周期。
 */
export class ProxyServer {
  /** 当前运行的代理实例，start 成功后非空。 */
  private proxy: ProxyCore | null = null;
  /** runtime 门面；stop 经它排空连接，不直接操作 core 生命周期。 */
  private runtime: ProxyRuntime | null = null;
  /** 停机防重入标记，避免多次 SIGINT 触发重复 stop。 */
  private shuttingDown = false;
  /** 本进程配置上下文；不再从任何全局 Map 读取。 */
  private readonly context: ConfigContext;
  /** 构造注入的 runtime（缺省时 start 才从 context 创建）。 */
  private readonly injectedRuntime?: ProxyRuntime;
  /** 传给新 runtime 的事件总线。 */
  private readonly injectedEvents?: EventHub;
  /** 本 server/runtimes 共享的显式 logger。 */
  private readonly logger: LoggerImpl;
  /** banner 是否禁用 ANSI 色码。 */
  private readonly noColor: boolean;
  /** 测试可覆盖 worker 判定；生产缺省随 cluster。 */
  private readonly workerOverride?: boolean;
  /** EventHub 日志订阅，stop/失败重试时释放。 */
  private readonly logSubscriptions: EventSubscription[] = [];
  /** core -> EventHub 桥接的退订动作。 */
  private readonly bridgeDisposers: (() => void)[] = [];
  /** runtime 生命周期订阅，stop/失败重试时释放。 */
  private readonly lifecycleSubscriptions: EventSubscription[] = [];
  /** 防止重复 start 叠加 SIGINT/SIGTERM 监听。 */
  private signalsBound = false;

  constructor(options: ProxyServerOptions) {
    this.context = options.context;
    this.injectedRuntime = options.runtime;
    this.injectedEvents = options.events;
    this.logger = options.logger ?? createLogger({ config: options.context.accessor });
    this.noColor = options.noColor ?? false;
    this.workerOverride = options.isWorker;
  }

  /** 当前是否按 cluster worker 运行。 */
  private isWorker(): boolean {
    return this.workerOverride ?? cluster.isWorker === true;
  }

  /** 从本进程配置上下文创建 runtime；auth/core 共用同一 live store。 */
  private createRuntime(): ProxyRuntime {
    return createProxyRuntime({
      context: this.context,
      events: this.injectedEvents,
      logger: this.logger,
    });
  }

  /**
   * runtime 生命周期日志订阅。
   *
   * runtime 已在构造期桥接 core 的 `stateChange`，这里改订阅公共 EventHub，
   * 不再对 ProxyCore 做 EventEmitter 类型强转；日志文本保持原样。
   */
  private bindRuntimeLifecycle(isWorker: boolean): void {
    if (isWorker || !this.runtime) {
      return;
    }
    this.lifecycleSubscriptions.push(
      this.runtime.events.subscribe("lifecycle.changed", ({ data }) => {
        this.logger.debug(
          `[lifecycle] state ${data.prev} -> ${data.next} protocol=${this.proxy?.protocol}`,
        );
      }),
    );
  }

  /**
   * 代理事件日志订阅 - core/server 只抛不记，日志收拢于此。
   *
   * 每个 core 事件先同步桥入 server-local EventHub，再由强类型订阅统一落盘；
   * 订阅快照、字段、等级与消息文本均保持既有契约。
   */
  private bindProxyEventLogs(): void {
    if (!this.proxy) {
      return;
    }
    const source = asProxyEventSource(this.proxy);
    const bus = asProxyEventBus(new EventHub({ onListenerError: () => undefined }));

    const bind = <K extends ProxyEventName>(
      name: K,
      handler: (data: ProxyEventData<K>) => void,
    ): void => {
      const bridge = (data: ProxyEventData<K>): void => bus.publish(name, data);
      source.on(name, bridge);
      this.bridgeDisposers.push(() => source.off(name, bridge));
      this.logSubscriptions.push(
        bus.subscribe(name, ({ data }) => handler(data)),
      );
    };

    bind("forward", (e: ProxyForwardEvent) => {
      // 懒求值：client/target/headers 只在真正要打日志时才解析 req
      const client = getClientAddress(e.req);
      const target = getAuthority(e.req) || "-";
      const headers = e.req.headers;
      // 查询维度进结构化字段，msg 只留可读文本，避免 client/target/user 在 msg 里重复
      switch (e.kind) {
        case "http":
        case "tunnel":
        case "upgrade": {
          // 三种 kind 仅 method 有差异：tunnel 恒 CONNECT，其余取请求行方法
          const method = e.kind === "tunnel" ? "CONNECT" : (e.req.method ?? "GET");
          this.logger.debug(`[${e.kind}] headers`, {
            client,
            target,
            headers: maskSensitiveHeaders(headers),
            user: e.username,
          });
          this.logger.info("[forward]", {
            kind: e.kind,
            client,
            target,
            method,
            user: e.username,
          });
          break;
        }
        default: {
          e.kind satisfies never;
          break;
        }
      }
    });
    bind("forwardError", (e: ProxyForwardErrorEvent) => {
      const label = FORWARD_ERROR_LABEL[e.kind] ?? "forwardUnknown";
      this.logger.error(`${label} error`, e.error);
    });
    bind("serverError", (e: ProxyServerErrorEvent) => {
      this.logger.error(`server error (${e.host}:${e.port}):`, e.error);
    });
    bind("clientError", (e: ProxyClientErrorEvent) => {
      logBadRequest(this.logger, `client error: ${e.error.message}`);
    });
    bind("auth", (e: ProxyAuthEvent) => {
      // allow 是逐请求的常规成功（与 [forward] 成功行重复）-> debug；deny 是预期内拒绝，info 留审计
      if (e.passed) {
        this.logger.debug("[auth] allow", {
          user: e.user,
          client: e.client,
          target: e.target,
          tag: e.tag,
        });
      } else {
        // expected 字段已由 core 层移除，不再引用；attempted/reason 进结构化字段（undefined 自动跳过）
        this.logger.info("[auth] deny", {
          client: e.client,
          target: e.target,
          attempted: e.attempted,
          reason: e.reason,
        });
      }
    });
    bind("listening", (e: { host: string; port: number }) => {
      this.logger.debug(`listening on ${e.host}:${e.port}`);
    });
    bind("close", () => {
      this.logger.debug("server closed");
    });
    bind("pipe", (e: PipeEvent) => {
      // 该 PipeEvent 上的查询维度统一透传为结构化字段
      const fields = { user: e.user, client: e.client, target: e.target };
      switch (e.type) {
        case "target-unresolved": {
          logTargetUnresolved(this.logger, e.url as string | undefined, fields);
          break;
        }
        case "loop-detected": {
          const req = e.req as { method?: string; url?: string } | undefined;
          logLoopDetected(this.logger, `${req?.method} ${req?.url} -> ${e.target as string}`, fields);
          break;
        }
        case "upstream-refused": {
          logUpstreamRefused(this.logger, e.statusLine as string, fields);
          break;
        }
        case "upstream-error": {
          // 转发层 502 的成因（TLS 校验失败 / ECONNREFUSED / DNS 等）必须落到 warn 级，
          // 否则默认分支的 debug 会把「为什么 502」淹掉
          logUpstreamError(this.logger, (e.message as string) ?? "upstream error", e.err, fields);
          break;
        }
        case "upstream-timeout": {
          logUpstreamTimeout(this.logger, (e.message as string) ?? "upstream timeout", fields);
          break;
        }
        case "route": {
          // route 事件与 [route] 行 1:1（core 在 server 模式短路处不发）；字段形态是 jq 契约、勿动
          this.logger.info("[route]", {
            target: e.target,
            route: e.route,
            ...(e.reason ? { reason: e.reason } : {}),
          });
          break;
        }
        case "ip-denied": {
          logIpDenied(
            this.logger,
            `${e.protocol as string} 客户端 ${e.client as string} 拒绝 reason=${e.reason as string}`,
            { client: e.client, reason: e.reason, protocol: e.protocol, user: e.user },
          );
          break;
        }
        case "target-denied": {
          logTargetDenied(this.logger, `${e.target as string} 拒绝 reason=${e.reason as string}`, {
            target: e.target,
            host: e.host,
            reason: e.reason,
            user: e.user,
            client: e.client,
          });
          break;
        }
        case "socks": {
          this.logger.info(e.message as string, { user: e.user, client: e.client, target: e.target });
          break;
        }
        case "debug": {
          this.logger.debug(e.message as string);
          break;
        }
        // 拨号守卫与握手畸形类：仅 debug 级留痕，无结构化落盘（与改造前 default 分支同档）
        case "dial":
        case "established":
        case "bad-request":
        case "client-error": {
          this.logger.debug(e.message ?? String(e.type));
          break;
        }
        default: {
          // 判别联合新增变体时在此显式收口：`e satisfies never` 编译期强制补 case，
          // 杜绝新事件被静默吞进兜底分支
          e satisfies never;
          break;
        }
      }
    });
  }

  /** 释放本次 server 观察面；不触碰 runtime 自己的 EventHub 订阅。 */
  private unbindRuntimeObservers(): void {
    for (const subscription of this.logSubscriptions.splice(0)) {
      subscription.dispose();
    }
    for (const dispose of this.bridgeDisposers.splice(0)) {
      try {
        dispose();
      } catch {
        // 退订失败不应阻断 stop/重试。
      }
    }
    for (const subscription of this.lifecycleSubscriptions.splice(0)) {
      subscription.dispose();
    }
  }

  /**
   * 启动流程：
   * 1) 安装进程级容错守卫（仅 CLI start 时）
   * 2) 打印脱敏后的配置快照（密码/密钥以 *** 代替），并对常见误配给出告警
   * 3) 创建 runtime、订阅 lifecycle 与代理日志
   * 4) 绑定 SIGINT/SIGTERM 优雅停机，随后启动并输出运行态
   */
  async start(): Promise<ProxyCore> {
    const { setupProcessGuards } = await import("@/utils/process-guards.js");
    setupProcessGuards(this.logger);
    const isWorker = this.isWorker();

    if (!isWorker) {
      const { logConfig } = await import("./log/config-log.js");
      logConfig(this.context, this.logger);
    }

    // 启动失败后允许同一对象重试，先解掉上一轮观察面。
    this.unbindRuntimeObservers();
    this.runtime = this.injectedRuntime ?? this.createRuntime();
    this.proxy = this.runtime.getProxy();
    this.bindRuntimeLifecycle(isWorker);
    this.bindProxyEventLogs();
    this.bindSignals();

    try {
      await this.runtime.start();
    } catch (error) {
      this.unbindRuntimeObservers();
      throw error;
    }

    if (isWorker) {
      process.send?.({ type: "ready", pid: process.pid });
    } else {
      const stats = this.proxy.getStats();
      this.logger.notice(
        "info",
        `proxy started: ${stats.protocol}://${stats.host}:${stats.port} running=${stats.running} state=${this.proxy.state}`,
      );
      printBanner(this.logger, this.noColor);
    }

    process.on("uncaughtExceptionMonitor", (err) => {
      this.logger.error("[monitor] 异常监控:", err);
    });
    return this.proxy;
  }

  /**
   * 优雅停止 - 带超时兜底。
   * graceMs 内未能关闭则强制 process.exit(1)，防止长连接使停机挂死；
   * timer.unref() 保证正常停机时不额外延长事件循环存活。
   */
  async stop(graceMs = 10000): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    if (!this.runtime) {
      return;
    }
    const timer = setTimeout(() => {
      this.logger.notice("warn", `[shutdown] 优雅停止超时 ${graceMs}ms，强制退出`);
      process.exit(1);
    }, graceMs);
    timer.unref();
    try {
      await this.runtime.stop();
      this.logger.notice("info", "[shutdown] 代理已停止");
    } catch (err) {
      this.logger.error("[shutdown] 停止代理失败:", err);
    } finally {
      // 显式 process.exit（bindSignals 的 finally）会截断在途 appendFile：先等齐落盘
      this.unbindRuntimeObservers();
      await this.logger.flush();
      clearTimeout(timer);
    }
  }

  /** 获取当前代理实例（未启动为 null），供上层查询状态或注入。 */
  getProxy(): ProxyCore | null {
    return this.proxy;
  }

  /**
   * 绑定中断信号：Ctrl+C / kill 时先优雅停机再以 0 退出。
   * 首次信号走 this.stop()（排空在途连接 + flush 日志）后退出；
   * 停机进行中再次收到信号则直接强退，避免排空挂死。
   */
  private bindSignals(): void {
    if (this.signalsBound) {
      return;
    }
    this.signalsBound = true;
    // 优雅停机入口：幂等。信号与 master IPC 可能同时到达（同一次 Ctrl+C 的控制台广播 + IPC 扇出），
    // 重复触发不得打断排空
    const graceful = (): void => {
      if (this.shuttingDown) {
        return;
      }
      void this.stop().finally(() => process.exit(0));
    };

    const onSignal = (): void => {
      // 单进程场景：停机中再次收到信号（用户二次 Ctrl+C）→ 放弃排空强退。
      // cluster worker 不做强退：worker 的信号来自控制台广播、会与 master 的 IPC 同时到达，
      // 无法区分「同一次 Ctrl+C」与用户二次按键，兜底交给 master 的 grace SIGKILL 与 stop() 自身超时
      if (this.shuttingDown && !this.isWorker()) {
        this.logger.notice("warn", "[shutdown] 停机中再次收到信号，强制退出");
        process.exit(0);
      }
      graceful();
    };

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    if (process.platform === "win32") {
      process.on("SIGBREAK", onSignal);
    }
    if (this.isWorker()) {
      process.on("message", (msg: unknown) => {
        if (
          typeof msg === "object" &&
          msg !== null &&
          (msg as { type?: string }).type === "shutdown"
        ) {
          // master 的停机指令与信号等价：只触发幂等排空，绝不强退
          graceful();
        }
      });
    }
  }
}

/**
 * 进程级 CLI 入口 - 接收已加载配置，不自行读取宿主环境。
 * import 本模块不会加载配置；CLI 显式调用 `loadConfig()` 后把 context/logger 传进来。
 */
export async function runServer(
  context: ConfigContext,
  logger?: LoggerImpl,
  noColor = false,
): Promise<void> {
  const activeLogger = logger ?? createLogger({ config: context.accessor });
  if (shouldRunAsMaster(context)) {
    await runAsMaster(context, activeLogger, noColor);
    return;
  }
  const app = new ProxyServer({ context, logger: activeLogger, noColor });
  await app.start();
}
