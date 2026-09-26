/**
 * ProxyServer - CLI 进程包装器
 *
 * 库调用方请使用 `createProxyRuntime()`；本类只负责 CLI 进程级职责：
 * 配置初始化后的快照打印、进程守卫、信号、cluster ready/shutdown 与退出兜底。
 */

import cluster from "node:cluster";
import type { ConfigContext } from "@/config/index.js";
import { EventHub, type EventEnvelope, type EventName, type EventSubscription } from "@/core/events/index.js";
import type { PipeEvent } from "@/core/types/pipe.js";
import type {
  ProxyCore,
  ProxyForwardKind,
} from "@/core/types/proxy.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { ProxyRuntime } from "@/runtime/index.js";
import { shouldRunAsMaster, runAsMaster } from "./cluster.js";
import { createLogger, type LoggerImpl } from "@/utils/logger/index.js";
import {
  logBadRequest,
  logIpDenied,
  logLoopDetected,
  logQuotaExceeded,
  logQuotaInert,
  logQuotaLedgerError,
  logTargetDenied,
  logTargetUnresolved,
  logUpstreamError,
  logUpstreamRefused,
  logUpstreamTimeout,
} from "@/core/log-events.js";
import { printBanner } from "./banner.js";

/** forward.error 日志名前缀：kind -> 函数名，Record 保证新增 kind 时编译期必补 */
const FORWARD_ERROR_LABEL: Record<ProxyForwardKind, string> = {
  http: "forwardHttp",
  tunnel: "forwardTunnel",
  upgrade: "forwardUpgrade",
};

/**
 * 本 server 在某条 EventHub 上持有的一条订阅。
 *
 * `hub` 是**归属声明**：记录这条订阅当初挂在哪条总线上。换总线
 * （`RuntimeContext.setEvents`）后仍能看清它属于谁；只存 `subscription` 就丢了这个信息，
 * 而 `dispose()` 对错 hub 调用是静默空操作（旧总线上的记录一个都摘不掉）。
 */
interface EventBinding {
  readonly hub: EventHub;
  readonly subscription: EventSubscription;
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
  /**
   * 流量配额账本的**槽位号**（Phase 5b-2）
   * @description
   * 由 CLI 从 **env 快照**（`PROXY_WORKER_SLOT`，cluster master 在 fork 时注入）显式传下来，
   * 一路透到 `createProxyRuntime({ trafficWorkerSlot })`。**本层与 core/runtime 都不读
   * `process.env`**：槽位会被拼进账本文件名，「自己猜来源」= 「写错文件 / 读别人的账」。
   * 省略（单进程 / 库模式）归一为 `"0"`，非法值同样归一为 `"0"`。
   */
  trafficWorkerSlot?: string;
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
  /** 流量配额账本槽位号（CLI 显式传入；缺省 = 单进程 `"0"`）。 */
  private readonly trafficWorkerSlot?: string;
  /**
   * core 事实日志订阅；`hub` 为订阅时的总线实例，`subscription.dispose()` 只能作用在它上面。
   */
  private readonly eventDisposers: EventBinding[] = [];
  /** runtime 生命周期订阅，stop/失败重试时释放；同样记 hub 以固定退订归属。 */
  private readonly lifecycleSubscriptions: EventBinding[] = [];
  /** 防止重复 start 叠加 SIGINT/SIGTERM 监听。 */
  private signalsBound = false;

  constructor(options: ProxyServerOptions) {
    this.context = options.context;
    this.injectedRuntime = options.runtime;
    this.injectedEvents = options.events;
    this.logger = options.logger ?? createLogger({ config: options.context.accessor });
    this.noColor = options.noColor ?? false;
    this.workerOverride = options.isWorker;
    this.trafficWorkerSlot = options.trafficWorkerSlot;
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
      // 启动期告警落到本进程 logger：目前只有「未开鉴权 → 流量配额整体不生效」一条
      // （`runtime.ts:reportQuotaGate`）。刻意**只**接这一条、不把 `onWarning` 整体转发：
      // 那会把 `config-normalized` 一并变成 warn，改变改造前 CLI 的落盘形态。
      onWarning: (w) => {
        if (w.code === "quota-inert") {
          logQuotaInert(this.logger);
        }
      },
      // 槽位号显式透传：CLI 的 env 快照 → 这里 → runtime（谁都不读 process.env）
      trafficWorkerSlot: this.trafficWorkerSlot,
    });
  }

  /**
   * runtime 生命周期日志订阅。
   *
   * 订阅源是公共 `EventHub` 上的 `lifecycle.changed`——core 的 `setState` 直接发布它
   * （Phase 1.3b 起 core 不再继承 Node `EventEmitter`），本 runtime 运行时只需订阅，
   * 不对 `ProxyCore` 做 EventEmitter 类型强转；日志文本保持原样。
   */
  private bindRuntimeLifecycle(isWorker: boolean): void {
    if (isWorker || !this.runtime) {
      return;
    }
    const hub = this.runtime.events;
    this.lifecycleSubscriptions.push({
      hub,
      subscription: hub.subscribe("lifecycle.changed", ({ data }) => {
        this.logger.debug(
          `[lifecycle] state ${data.prev} -> ${data.next} protocol=${this.proxy?.protocol}`,
        );
      }),
    });
  }

  /**
   * 代理事件日志订阅 - core 只抛事实不直接记，日志收拢于此。
   *
   * Phase 1.3a：订阅源从 core 的 `ProxyEventMap`（Node EventEmitter）换成注入的 `EventHub`。
   * 落盘行为逐字不变——事件名映射见下表，`pipe` 的 14 变体 switch 一字未改：
   *
   * | core 事实（旧事件名） | 订阅的公共事件 | 落点 |
   * |---|---|---|
   * | `forward`            | `forward.request-headers` | `[{kind}] headers` debug |
   * |                      | `request.started`        | `[forward]` info |
   * | `forwardError`       | `forward.error`        | `forwardXxx error` error |
   * | `serverError`        | `server.error`         | `server error (host:port):` error |
   * | `clientError`        | `server.client-error`  | `[bad-request] client error: …` warn |
   * | `auth`               | `auth.decided`         | `[auth] allow` debug / `[auth] deny` info |
   * | `listening`          | `server.listening`     | `listening on host:port` debug |
   * | `close`              | `server.closed`        | `server closed` debug |
   * | `pipe`               | `pipe`                 | 按 `type` 落 `[event-code]` / `[route]` |
   *
   * 身份维度（`client`/`target`/`user`/`method`）改从 `EventEnvelope.context` 读；
   * `method` 由 `core/server/http.ts` 写进 context（payload 只有 `kind`）。
   *
   * `[{kind}] headers` 那行**没有删除**：数据源从 `req.headers` 换成 core 侧已掩码的
   * `forward.request-headers` 事件（`maskSensitiveHeaders` 随之从本文件移到
   * `core/server/http.ts`，掩码在 publish 之前完成，原始凭证不跨事件总线）。文本格式、
   * debug 等级与 `client`/`target`/`headers`/`user` 四个字段与改造前逐字一致。
   *
   * listener **不需要** try/catch：`EventHub` 已隔离单个 listener 的异常并交给 `onListenerError`，
   * 且不会阻断同事件名的其它 listener。
   */
  private bindProxyEventLogs(): void {
    if (!this.proxy || !this.runtime) {
      return;
    }
    const hub = this.runtime.events;

    const bind = <K extends EventName>(
      name: K,
      handler: (e: EventEnvelope<K>) => void,
    ): void => {
      // 记下**订阅时的 hub**：dispose 必须打回同一个实例（见 eventDisposers 注释）
      this.eventDisposers.push({ hub, subscription: hub.subscribe(name, handler) });
    };

    bind("forward.request-headers", (e) => {
      const { context, data } = e;
      // 逐字对齐改造前 `bind("forward")` 里那条 debug 行：同样的 msg（`[{kind}] headers`）、
      // 同样的 debug 等级、同样的四个字段。headers 是 core 侧已掩码好的形态（掩码不进本层）。
      this.logger.debug(`[${data.kind}] headers`, {
        client: context.client,
        target: context.target ?? "-",
        headers: data.headers,
        user: context.user,
      });
    });
    bind("request.started", (e) => {
      const { context } = e;
      // 懒求值：只在真正要打日志时才拼文本；context 缺失回落 `-`（旧实现 `|| "-"` 同口径）
      const client = context.client ?? "-";
      const target = context.target ?? "-";
      // 查询维度进结构化字段，msg 只留可读文本，避免 client/target/user 在 msg 里重复
      switch (e.data.kind) {
        case "http":
        case "tunnel":
        case "upgrade": {
          // 三种 kind 仅 method 有差异：tunnel 恒 CONNECT，其余取请求行方法（core 写入 context.method）
          const method = e.data.kind === "tunnel" ? "CONNECT" : (context.method ?? "GET");
          this.logger.info("[forward]", {
            kind: e.data.kind,
            client,
            target,
            method,
            user: context.user,
          });
          break;
        }
        default: {
          e.data.kind satisfies never;
          break;
        }
      }
    });
    bind("forward.error", (e) => {
      const label = FORWARD_ERROR_LABEL[e.data.kind] ?? "forwardUnknown";
      this.logger.error(`${label} error`, e.data.error);
    });
    bind("server.error", (e) => {
      const { error, host, port } = e.data;
      this.logger.error(`server error (${host}:${port}):`, error);
    });
    bind("server.client-error", (e) => {
      logBadRequest(this.logger, `client error: ${e.data.error.message}`);
    });
    bind("auth.decided", (e) => {
      const { data, context } = e;
      // allow 是逐请求的常规成功（与 [forward] 成功行重复）-> debug；deny 是预期内拒绝，info 留审计
      if (data.passed) {
        this.logger.debug("[auth] allow", {
          user: data.user ?? context.user,
          client: context.client,
          target: context.target,
          tag: data.tag,
        });
      } else {
        // attempted/reason 进结构化字段（undefined 自动跳过）
        this.logger.info("[auth] deny", {
          client: context.client,
          target: context.target,
          attempted: data.attempted,
          reason: data.reason,
        });
      }
    });
    bind("server.listening", (e) => {
      this.logger.debug(`listening on ${e.data.host}:${e.data.port}`);
    });
    // 每用户流量配额耗尽：core 只发布事实（`core/forward/base.ts:publishQuotaExceeded`），
    // 传输侧的硬切（507 / destroy）已由那条路径执行完，这里只落一条 warn。
    // **不走上方的 `pipe` switch**：它是新公共契约（`traffic.quota-exceeded`）而不是管道细节，
    // 刻意没往 `PipeEvent` 判别联合里加变体——那会让 14 变体的穷尽清单与两处测试同时要改，
    // 而这条事实本来就不需要「管道上下文」。
    bind("traffic.quota-exceeded", (e) => {
      const { data } = e;
      // 文本契约：`[<user>] 配额耗尽 dir=<up|down> scope=<up|down|total> usage=<n> limit=<n>`。
      // 四个数都要人可读：运维要据此判断「该扩容（usage≈limit）还是「撞了单向上限（scope=up/down）」。
      logQuotaExceeded(
        this.logger,
        `${data.user} 配额耗尽 dir=${data.dir} scope=${data.scope} usage=${data.usage} limit=${data.limit}`,
        { user: data.user, dir: data.dir, scope: data.scope, usage: data.usage, limit: data.limit },
      );
    });
    bind("traffic.ledger-error", (e) => {
      // 写盘失败：内存计数继续（配额判定不受影响），未落盘增量留待重试。**error 级**，
      // 且文案里带上「不要为此重启」——重启会把队列里未落盘的增量一起丢掉。
      logQuotaLedgerError(this.logger, e.data.path, e.data.error);
    });
    bind("server.closed", () => {
      this.logger.debug("server closed");
    });
    bind("pipe", (event) => {
      // 载荷即 `PipeEvent` 判别联合原样，下面的 14 变体 switch 与改造前逐字一致
      const e: PipeEvent = event.data;
      // 该 PipeEvent 上的查询维度统一透传为结构化字段
      const fields = { user: e.user, client: e.client, target: e.target };
      switch (e.type) {
        case "target-unresolved": {
          logTargetUnresolved(this.logger, e.url as string | undefined, fields);
          break;
        }
        case "loop-detected": {
          const req = e.req as { method?: string; url?: string } | undefined;
          logLoopDetected(
            this.logger,
            `${req?.method} ${req?.url} -> ${e.target as string}`,
            fields,
          );
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
          // 文本格式（Phase 4b 起）：`<target> 拒绝 reason=<reason> source=<global|user>`。
          // `source` 只在判定层给出时追加（老事件/手工构造的事件缺它 → 文本与改造前逐字一致），
          // 结构化字段同步补 `source`：**运维必须能一眼看出该改 acl.json 还是 users.json**，
          // 403 单看 reason 分不出是全局黑名单还是某个用户的个人名单。
          const source = e.source ? ` source=${e.source}` : "";
          logTargetDenied(this.logger, `${e.target as string} 拒绝 reason=${e.reason as string}${source}`, {
            target: e.target,
            host: e.host,
            reason: e.reason,
            ...(e.source ? { source: e.source } : {}),
            user: e.user,
            client: e.client,
          });
          break;
        }
        case "socks": {
          this.logger.info(e.message as string, {
            user: e.user,
            client: e.client,
            target: e.target,
          });
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
    // `binding.hub` 是**归属声明**：它记录这条订阅当初挂在哪条总线上。换总线
    // （`RuntimeContext.setEvents`）后仍能看清它属于谁，不会被当成「当前 runtime 的
    // hub」而误判。真正的退订动作由 `subscription` 自己的闭包完成（对错 hub 调用是
    // 静默空操作），所以必须连 hub 一起保存——只存 subscription 就丢了这个归属信息。
    for (const binding of this.eventDisposers.splice(0)) {
      try {
        binding.subscription.dispose();
      } catch {
        // 退订失败不应阻断 stop/重试。
      }
    }
    for (const binding of this.lifecycleSubscriptions.splice(0)) {
      binding.subscription.dispose();
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
    const { setupProcessGuards } = await import("./process-guards.js");
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
      // 流量配额账本的最后一次落盘，**排在 logger.flush 之前**（Phase 5b-2）：
      // 队列里那些「已计入内存判定、还没进磁盘」的字节如果丢掉，用户靠反复「用一点、
      // Ctrl+C」就能把配额窗口内的额度一次次刷新。`runtime.stop()` 里也调过一次，
      // 本次是幂等空转 —— 之所以还要写在这里，是让「先落账本、再落日志」的次序在
      // CLI 面上是显式的（配额账本与日志说的是同一段时间的用量，次序错了对不上账）。
      await this.closeTrafficLedger();
      await this.logger.flush();
      clearTimeout(timer);
    }
  }

  /** 收流量配额账本（幂等；没有账本时 no-op）。 */
  private async closeTrafficLedger(): Promise<void> {
    try {
      await this.runtime?.services.trafficLedger?.close();
    } catch (err) {
      // 停机路径绝不因账本收尾失败而抛出：那会让 `finally` 里后面的 logger.flush 落空
      this.logger.error("[shutdown] 流量配额账本落盘失败:", err);
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
 *
 * @param workerSlot - 流量配额账本槽位号（Phase 5b-2）。**由 CLI 从 env 快照显式传入**
 *   （`PROXY_WORKER_SLOT`，cluster master 在 fork 时注入）；本函数**不读 `process.env`**。
 *   省略 = 单进程 / 库模式（下游归一为 `"0"`）。
 */
export async function runServer(
  context: ConfigContext,
  logger?: LoggerImpl,
  noColor = false,
  workerSlot?: string,
): Promise<void> {
  const activeLogger = logger ?? createLogger({ config: context.accessor });
  if (shouldRunAsMaster(context)) {
    await runAsMaster(context, activeLogger, noColor);
    return;
  }
  const app = new ProxyServer({
    context: context,
    logger: activeLogger,
    noColor: noColor,
    trafficWorkerSlot: workerSlot,
  });
  await app.start();
}
