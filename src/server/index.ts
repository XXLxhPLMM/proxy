/**
 * ProxyServer —— CLI 进程包装器。库调用方用 `createProxyRuntime()`。
 *
 * 本类只做三件事：打印配置快照、编排 cluster ready/shutdown、把进程级动作委托给
 * `ProcessPolicy`（信号 / 守卫 / banner / 退出兜底，见 `./process.js`）。本类只保留**次序**与
 * **日志文本**。
 *
 * 「事件 → 落盘」不在本类：11 类公共事件的 JSONL 行与 `[lifecycle] state …` 由
 * `@/runtime/event-log.ts` 绑定，随 `createProxyRuntime` 的 `start()` / `stop()` 同一轮装卸。
 *
 * 本类打出的进程级日志行只有：`[config]`、`proxy started:`、`[shutdown]` ×2、banner。
 */

import cluster from "node:cluster";
import type { ConfigContext } from "@/config/index.js";
import { EventHub } from "@/core/events/index.js";
import type { ConnectorSource } from "@/core/forward/upstream/connector/index.js";
import type { ProxyCore } from "@/core/types/proxy.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { ProxyRuntime, RuntimeServices } from "@/runtime/index.js";
import { shouldRunAsMaster, runAsMaster } from "./cluster.js";
import { createLogger, type LoggerImpl } from "@/utils/logger/index.js";
import { logAccountTableInert, logAclInert, logQuotaInert } from "@/core/log-events.js";
import {
  cliProcessPolicy,
  type ProcessPolicy,
  type ProcessStartupPreset,
  type SignalHost,
} from "./process.js";

/** 进程策略的现成实现与端口经本模块对外（`cli.ts` 与库调用方都从这里取，server 目录只有这一个出口）。 */
export { cliPreset, cliProcessPolicy, managedProcessPolicy } from "./process.js";
export type { ProcessPolicy, ProcessStartupPreset, SignalHost } from "./process.js";

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
   * 进程策略：信号 / 进程守卫 / banner / 强制退出的注入位。
   * @description
   * **缺省 = {@link cliProcessPolicy}** —— CLI 走的就是这一档，**改这个缺省就会改变 CLI 行为**。
   * 宿主已拥有进程时传 `managedProcessPolicy`（什么都不装、什么都不退）。
   * 优先级：`processPolicy` > `assembly.process` > 缺省档。
   */
  processPolicy?: ProcessPolicy;
  /**
   * 服务替身（身份 / 访问控制 / 流量配额 / 配额账本），透传给 `createProxyRuntime`。
   * @description
   * **只在本类自己创建 runtime 时生效**（注入了 `runtime` 时本字段无处可去）。缺省项由
   * runtime 的 `buildDefaultServices` 解析——显式注入优先。
   */
  services?: Partial<RuntimeServices>;
  /**
   * 上游连接器源（装配期注入位），透传给 `createProxyRuntime`。
   * @description
   * 缺省由 runtime 按 `upstreamProtocol` 造 `createConnectorSource(...)`；显式注入整份替换。
   * 同 `services`：只在本类自己创建 runtime 时生效。
   */
  connectors?: ConnectorSource;
  /**
   * 启动预设：协议 / 服务替身 / 上游连接器那一侧的整份组装件（`cliPreset()` 即其一）。
   * @description
   * 类型是 `ProcessStartupPreset` = `StartupPreset` **加一个可选的进程位**（库那一侧的
   * `StartupPreset` 刻意不含进程字段，理由见 `./process.ts`）。
   *
   * **进程策略有两个入口，优先级写死**：`processPolicy` > `assembly.process` > 缺省档
   * {@link cliProcessPolicy}。
   * 预设的其余字段（`protocol` / `services` / `connectors`）由 runtime 按
   * 「显式 options > assembly > 配置/缺省」三层消费，本类原样透传。
   */
  assembly?: ProcessStartupPreset;
}

/**
 * 代理核心由 `createProxyRuntime()` 承载；本类只叠加 CLI 进程职责，绝不把 loader、信号、
 * cluster 或配置快照打印带进库 runtime 的生命周期。（⚠️ 「日志落盘」不属于本类职责，
 * 见文件头那一节。）
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
  /**
   * 进程策略：信号 / 守卫 / banner / 强制退出全部委托给它。
   * @description
   * 优先级 `processPolicy` > `assembly.process` > {@link cliProcessPolicy}——**缺省即 CLI 档**。
   * 进程端口**只长在本类**：`createProxyRuntime` 那侧继续零 `process`、零 `exit`。
   */
  private readonly processPolicy: ProcessPolicy;
  /** 透传给 `createProxyRuntime` 的服务替身；缺省项由 runtime 解析。 */
  private readonly injectedServices?: Partial<RuntimeServices>;
  /** 透传给 `createProxyRuntime` 的上游连接器源。 */
  private readonly injectedConnectors?: ConnectorSource;
  /** 透传给 `createProxyRuntime` 的启动预设（库那一侧的组装件）。 */
  private readonly assembly?: ProcessStartupPreset;
  /**
   * 信号退订函数（`ProcessPolicy.installSignals` 的返回值）。
   * @description
   * 它同时充当「已装信号」的旗标（防重复 start 叠加监听）：非 null 即已装。`stop()` 收尾时
   * 摘掉并置回 null，于是同一对象 `stop → start` 会重新装。
   */
  private signalDisposer: (() => void) | null = null;
  /**
   * `uncaughtExceptionMonitor` 退订函数（`ProcessPolicy.installExceptionMonitor` 的返回值）。
   * 与 {@link signalDisposer} 同形：**旗标兼退订句柄**——裸调 `process.on` 不受旗标保护，
   * `start → stop → start` 每轮都会在进程上多挂一个持有 `this.logger` 的闭包。
   *
   * ⚠️ `stop()` 不摘它：摘掉会让停机后进程里出的未捕获异常失去本代理那一行日志。这里只保证
   * **不叠加**。
   */
  private exceptionMonitorDisposer: (() => void) | null = null;

  constructor(options: ProxyServerOptions) {
    this.context = options.context;
    this.injectedRuntime = options.runtime;
    this.injectedEvents = options.events;
    this.logger = options.logger ?? createLogger({ config: options.context.accessor });
    this.noColor = options.noColor ?? false;
    this.workerOverride = options.isWorker;
    this.injectedServices = options.services;
    this.injectedConnectors = options.connectors;
    this.assembly = options.assembly;
    this.processPolicy = options.processPolicy ?? options.assembly?.process ?? cliProcessPolicy;
  }

  /** 当前是否按 cluster worker 运行。 */
  private isWorker(): boolean {
    return this.workerOverride ?? cluster.isWorker === true;
  }

  /** 从本进程配置上下文创建 runtime；identity/access/traffic 共用同一 live store。 */
  private createRuntime(): ProxyRuntime {
    return createProxyRuntime({
      context: this.context,
      events: this.injectedEvents,
      logger: this.logger,
      // 上游连接器源：装配期注入位，缺省由 runtime 按 `upstreamProtocol` 造默认表
      connectors: this.injectedConnectors,
      // 启动预设（协议 / 服务替身 / 连接器的整份组装件，如 `cliPreset()`）
      assembly: this.assembly,
      // 服务替身：显式注入优先，缺省项由 `buildDefaultServices` 解析（唯一解析点）。
      // 展开成新对象，避免把本 server 持有的那份交给 runtime 之后被外部改写。
      services: { ...this.injectedServices },
      // 启动期告警**只**接白名单三条（`runtime.ts:reportQuotaGate` / `reportAclGate` /
      // `reportAccountTableGate`），不整体转发 `onWarning`：白名单里每一条都是「配置有洞、
      // 服务照跑」，运维必须知道但不必停机；白名单外是「归一提示 / 启动失败」，前者已在
      // `cli.ts` 按 `context.warnings` warn 过，后者由启动异常本身暴露。整体转发会把两类混进
      // 同一等级，warn 一多就等于没有 warn。
      // ⚠️ **三条是封顶，不是起点**：再加一条就该换成让 `RuntimeWarning` 自带 `level` 并整体
      // 转发（见 `runtime/types.ts:RuntimeWarning`）。新告警**优先并进现有某一条**——只要它与
      // 那条的成因相同（`account-table-inert` 就是把 `disabled` 并进原 `expiresAt` 那条的例子：
      // 同为「jwt 模式不查账号表」，拆两个码只会白费下游一个 `if`）。
      onWarning: (w) => {
        if (w.code === "quota-inert") {
          logQuotaInert(this.logger);
        } else if (w.code === "acl-inert") {
          logAclInert(this.logger);
        } else if (w.code === "account-table-inert") {
          logAccountTableInert(this.logger);
        }
      },
      // worker 身份**显式**透传：runtime 侧那一行 `[lifecycle] state …` 是 master 独有的日志，
      // 而 runtime 零 `cluster` 零 `process`，所以「本进程是不是子进程」只能由本类如实申报。
      // 它同时让 `runtime.options.isWorker` 不再是常量。
      //
      // （旧形态这里还透传过 `trafficWorkerSlot`——账本分槽用。账本改成所有进程共用的
      // 同一个 SQLite 文件后，槽位不再存在，这条链整体删除。）
      isWorker: this.isWorker(),
    });
  }

  /**
   * 注入了 `runtime` 又传了 `services` / `connectors` / `assembly` 时 warn 一次——注入的 runtime
   * 优先，那三项无处可去，静默丢弃会让「我注入了替身但行为没变」零线索。
   *
   * 两者同时给是合法用法，因此这里只 warn 不抛：抛错会把顺序问题升级成启动失败。
   *
   * `assembly` 不整个被忽略——`assembly.process` 在构造期已解析进 `this.processPolicy`。
   * 判据是「**真的注入了东西**」而非「字段在不在」：`services: { ...maybe }` 展开成 `{}`
   * 确实没注入任何替身，对着它 warn 是噪音。
   */
  private warnIgnoredRuntimeOptions(): void {
    if (!this.injectedRuntime) {
      return;
    }
    const ignored: string[] = [];
    // `services` 判「**有没有真的注入东西**」而不是「字段在不在」
    if (this.injectedServices && Object.keys(this.injectedServices).length > 0) {
      ignored.push("services");
    }
    if (this.injectedConnectors) {
      ignored.push("connectors");
    }
    if (this.assembly) {
      ignored.push("assembly");
    }
    if (ignored.length === 0) {
      return;
    }
    const names = ignored.join("/");
    this.logger.warn(
      `[start] 同时注入了 runtime 与 ${names}：注入的 runtime 优先，${names} 已被忽略` +
        "（这不是错误——两者同时给是合法用法，只是后者没有落点）" +
        "；要换服务替身/上游连接器/入站协议，请把它们传给那个 runtime 自己的构造选项，或干脆别注 runtime" +
        (this.assembly
          ? "。另：assembly.process 仍生效（构造期已解析进 processPolicy，" +
            "优先级 processPolicy > assembly.process > 缺省档），被忽略的只是它的 protocol/services/connectors"
          : ""),
    );
  }

  /**
   * 启动流程（八步次序是契约，**不因进程策略注入位而重排**）：
   * 1) 经 `processPolicy.installGuards` 装进程级容错守卫（CLI 档 = `setupProcessGuards`）
   * 2) 打印脱敏后的配置快照（密码/密钥以 *** 代替），并对常见误配给出告警
   * 3) 创建（或接收）runtime
   * 4) 事件 → 落盘绑定**由 runtime 在 `start()` 内装配**（`runtime/event-log.ts`，随它的
   *    `activateSubscriptions` 同轮）：那 11 类代理事实**与** `[lifecycle] state …` 那一行都在
   *    那里，本类不再自己订阅任何一个公共事件
   * 5) 经 `processPolicy.installSignals` 绑停机信号
   * 6) `runtime.start()`
   * 7) ready 面：worker 发 IPC `ready`；单进程打运行态行 + `processPolicy.printReady`
   * 8) `bindExceptionMonitor()` —— 经端口装 `uncaughtExceptionMonitor`（**位置固定在 ready 面
   *    之后**；「装不装」由策略说了算，且受幂等旗标保护）
   *
   * 第 2 步依赖调用方已完成加载：**模块 import 本身不加载配置**。
   */
  async start(): Promise<ProxyCore> {
    await this.processPolicy.installGuards?.(this.logger);
    const isWorker = this.isWorker();

    if (!isWorker) {
      // 配置日志不是进程策略（它打印的是配置快照，与谁拥有本进程无关），故动态 import 留在本文件
      const { logConfig } = await import("./log/config-log.js");
      logConfig(this.context, this.logger);
    }

    // 注入了 runtime 又传了那三样时必须响一次（否则「注入的替身没生效」零线索）
    this.warnIgnoredRuntimeOptions();
    this.runtime = this.injectedRuntime ?? this.createRuntime();
    this.proxy = this.runtime.getProxy();
    this.bindSignals();

    // 本类这一层没有可摘的事件订阅：落盘绑定在 `runtime/event-log.ts` 侧，随 runtime 的
    // `activateSubscriptions` 装配、由其 `subscriptionsActive` 幂等旗标保证 start 重试不叠加。
    await this.runtime.start();

    if (isWorker) {
      process.send?.({ type: "ready", pid: process.pid });
    } else {
      const stats = this.proxy.getStats();
      this.logger.notice(
        "info",
        `proxy started: ${stats.protocol}://${stats.host}:${stats.port} running=${stats.running} state=${this.proxy.state}`,
      );
      this.processPolicy.printReady?.(this.logger, this.noColor);
    }

    // 位置固定在 ready 面之后：runtime.start() 抛错时本监听器不装
    this.bindExceptionMonitor();
    return this.proxy;
  }

  /**
   * 优雅停止 - 带超时兜底。
   * graceMs 内未能关闭则经 `processPolicy.forceExit(1)` 强制结束本进程，防止长连接使停机挂死；
   * timer.unref() 保证正常停机时不额外延长事件循环存活。
   *
   * **兜底动作本身归策略**（CLI 档 = `process.exit(1)`；`managedProcessPolicy` 档 = 只发一条
   * 警告并把退出交还宿主），但**触发它的那行 `[shutdown]` 日志留在本类**：那是 CLI 的落盘文本
   * 契约，不该跟着进程策略搬家。
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
      this.processPolicy.forceExit(1);
    }, graceMs);
    timer.unref();
    try {
      await this.runtime.stop();
      this.logger.notice("info", "[shutdown] 代理已停止");
    } catch (err) {
      this.logger.error("[shutdown] 停止代理失败:", err);
    } finally {
      // 摘信号监听排在最前：finally 是 `await runtime.stop()` 落地才进的，排空途中收二次信号
      // 仍能强退；不摘则「同一对象 stop → start → stop」会叠加 SIGINT/SIGTERM 监听。
      this.unbindSignals();
      // 事件订阅的退订不在本层：那 11 类代理事实与 `[lifecycle] state …` 的落盘绑定由
      // `runtime.stop()` 的 `releaseSubscriptions()` 统一退。
      //
      // 账本落盘排在 logger.flush 之前：队列里「已计入镜像判定、还没进磁盘」的字节若丢掉，
      // 反复「用一点、Ctrl+C」就能把配额窗口内的额度一次次刷新。两者说的是同一段时间的用量，
      // 次序错了对不上账。
      await this.closeUsageSource();
      await this.logger.flush();
      clearTimeout(timer);
    }
  }

  /** 收用量数据源（幂等；没有数据源时 no-op）。 */
  private async closeUsageSource(): Promise<void> {
    try {
      await this.runtime?.services.usageSource?.close();
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
   * 信号宿主：把「装信号那一侧真正需要的四样」交给 `ProcessPolicy`（端口定义见 `./process.js`）。
   *
   * 每次安装造一个新对象：策略只在 `installSignals` 执行期间用它装闭包，不缓存也不跨轮复用，
   * 所以无需在实例上存一份。
   */
  private createSignalHost(): SignalHost {
    return {
      gracefulStop: () => this.stop(),
      // 日志行归本类（`[shutdown]` 是 CLI 落盘文本契约），退出动作归策略
      forceStopNow: () => this.forceStopNow(),
      isShuttingDown: () => this.shuttingDown,
      isWorker: () => this.isWorker(),
    };
  }

  /**
   * 绑 `uncaughtExceptionMonitor`（**只观察、不改变进程行为**的那一个）。装不装由
   * `ProcessPolicy.installExceptionMonitor` 决定，本方法只负责**幂等**——不经端口、不受旗标保护
   * 时 `start → stop → start` 会在进程上叠加监听。
   *
   * 策略省略该成员时旗标恒为 null，每轮 `start()` 重新问一次：「没装」本就该每轮重新裁决
   * （调用方可能在两轮之间换掉 `processPolicy`）。
   */
  private bindExceptionMonitor(): void {
    if (this.exceptionMonitorDisposer) {
      return;
    }
    this.exceptionMonitorDisposer =
      this.processPolicy.installExceptionMonitor?.(this.logger) ?? null;
  }

  /**
   * 停机中再收信号：放弃排空、立刻强退。
   *
   * **worker 不走这里**（`cliProcessPolicy` 的信号处理自己判 `!host.isWorker()`）：worker 的
   * 信号来自控制台广播、会与 master 的 IPC 同时到达，无法区分「同一次 Ctrl+C」与二次按键，
   * 兜底交给 master 的 grace SIGKILL 与 `stop()` 自身超时。
   */
  private forceStopNow(): void {
    this.logger.notice("warn", "[shutdown] 停机中再次收到信号，强制退出");
    this.processPolicy.forceExit(0);
  }

  /**
   * 绑定中断信号，具体装什么（SIGINT/SIGTERM/SIGBREAK/worker IPC、首次优雅、二次强退）
   * 由 `ProcessPolicy.installSignals` 决定——本方法只负责**幂等**与**退订**。
   *
   * 信号语义、防重入、worker IPC、worker 不强退这四样住在 `cliProcessPolicy`；
   * 这里只剩「装一次」与「收尾时摘掉」两件事。
   */
  private bindSignals(): void {
    if (this.signalDisposer) {
      return;
    }
    this.signalDisposer = this.processPolicy.installSignals?.(this.createSignalHost()) ?? null;
  }

  /** 摘掉信号监听（幂等；退订失败不阻断停机）。 */
  private unbindSignals(): void {
    const dispose = this.signalDisposer;
    if (!dispose) {
      return;
    }
    // 先清引用：dispose 抛错也不至于被 stop 的重入再调一次
    this.signalDisposer = null;
    try {
      dispose();
    } catch {
      // 退订失败不应阻断 stop。
    }
  }
}

/**
 * `runServer` 的可选项。
 *
 * @description
 * 与 `ProxyServerOptions` 同形：一个必填的 `context` + 一串可选项，选项一律走对象入参。
 *
 * 本函数**不采集宿主来源、不读 `process.env`**：所有需要宿主事实的量（`NO_COLOR`）都由
 * CLI 从 env 快照取出来经形参传进来。账本不再有槽位（它是所有进程共用的同一个 SQLite 文件），
 * 故这里**没有** `trafficWorkerSlot`。
 */
export interface RunServerOptions {
  /** 本进程 logger；省略时按已给 context 新建一份。 */
  readonly logger?: LoggerImpl;
  /** 是否禁用 banner ANSI 色码（由 CLI 从宿主 NO_COLOR 快照后显式传入）。 */
  readonly noColor?: boolean;
  /** 进程策略注入位（信号 / 守卫 / banner / 退出）；缺省 = CLI 档。 */
  readonly processPolicy?: ProcessPolicy;
  /** 服务替身，透传给 `ProxyServer` → `createProxyRuntime`。 */
  readonly services?: Partial<RuntimeServices>;
  /** 上游连接器源，透传给 `ProxyServer` → `createProxyRuntime`。 */
  readonly connectors?: ConnectorSource;
  /** 启动预设（如 `cliPreset()`）；形如 `StartupPreset` 加一个可选的进程位。 */
  readonly assembly?: ProcessStartupPreset;
  /**
   * 本进程与数据面的关系（**由调用方造、由本函数填写**，故控制面可以现读它）
   * @description
   * 同进程里同时跑着数据面与控制面时，控制面需要如实回答「端口在不在监听」。而这件事
   * **只有本模块知道答案**：master 进程 fork workers 并共享监听句柄，它自己不持有数据面；
   * worker 与单进程档才持有。
   *
   * 传**对象**而不是回调：控制面在 `runServer` **返回之前**就已经在监听了（组合根先开控制面，
   * 见 `src/manager/control-plane.ts` 文件头的次序纪律），它需要在任意时刻现读这份事实。
   * 回调要到调用方自己装上才成立，而这里没有「装配」的时机——对象在调用方手里就是活的。
   *
   * 缺省 = 不告知（库调用方不需要这个面）。
   */
  readonly dataPlaneOwner?: DataPlaneOwner;
}

/**
 * 本进程与数据面的关系（**可变对象**：调用方造、`runServer` 填、控制面现读）
 * @description
 * 字段**刻意不是 `readonly`**：这份事实随 `start()` 推进而变（`core` 由 null 变成真核心），
 * 而把它标成只读等于逼调用方每轮重新造一个对象，那恰好破坏了「现读」这件事。
 */
export interface DataPlaneOwner {
  /** 本进程是否为 cluster master（fork workers 并共享监听句柄的那一侧） */
  master: boolean;
  /** 数据面核心；master 分支恒为 null（本进程不持有数据面） */
  core: ProxyCore | null;
}

/**
 * 进程级 CLI 入口 - 接收已加载配置，不自行读取宿主环境。
 * import 本模块不会加载配置；CLI 显式调用 `loadConfig()` 后把 context/logger 传进来。
 */
export async function runServer(
  context: ConfigContext,
  options: RunServerOptions = {},
): Promise<void> {
  const {
    logger,
    noColor = false,
    processPolicy,
    services,
    connectors,
    assembly,
    dataPlaneOwner,
  } = options;
  const activeLogger = logger ?? createLogger({ config: context.accessor });
  const owner = dataPlaneOwner;
  if (shouldRunAsMaster(context)) {
    // master 分支只 fork/ready/退出编排：不开账本，也不需要转发器/服务替身。
    // 先把判据落成「本进程不持有数据面」：控制面此刻已经在监听了，而 `master: true` +
    // `core: null` 本身就是那份真事实（端口由 worker 持有），不是「还没填上」。
    if (owner) {
      owner.master = true;
      owner.core = null;
    }
    await runAsMaster(context, activeLogger, noColor);
    return;
  }
  if (owner) {
    // 同样先落判据：worker 与单进程档都持有数据面，`core` 在 `start()` 之后才拿到。
    owner.master = false;
    owner.core = null;
  }
  const app = new ProxyServer({
    context: context,
    logger: activeLogger,
    noColor: noColor,
    processPolicy: processPolicy,
    services: services,
    connectors: connectors,
    assembly: assembly,
  });
  await app.start();
  if (owner) {
    owner.core = app.getProxy();
  }
}
