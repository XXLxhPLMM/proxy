/**
 * ProxyServer - CLI 进程包装器
 *
 * 库调用方请使用 `createProxyRuntime()`；本类只负责 CLI 进程级职责：
 * 配置初始化后的快照打印、cluster ready/shutdown 编排，以及**把进程级动作委托给
 * `ProcessPolicy`**（信号 / 进程守卫 / banner / 退出兜底 —— 见 `./process.js`）。
 *
 * 「进程级动作」是注入位而不是本类的私有实现：本类只保留**次序**与**日志文本契约**，
 * `ProxyServer` 仍是进程壳（唯一持有 `process.exit` 语义的地方），
 * `createProxyRuntime` 侧继续零 `process` 访问。
 *
 * ⚠️ **「事件 → 落盘」不是本类的职责**：那 11 类公共事件到 JSONL 行的翻译**与**那条
 * `[lifecycle] state …` 日志行住在 `@/runtime/event-log.ts`（`bindProxyEventLogs` /
 * `bindLifecycleLog`），由 `createProxyRuntime` 在 `start()` 内、与 bridge / store / ACL 文件
 * 订阅**同一轮**装配，随 `stop()` 同一轮退订。判据是本仓自己的分界线「谁声明拥有这个进程」——
 * 落盘**不拥有进程**，它零 `process` 触点，留在这一层是**陷阱不是能力**（库调用方因此完全拿不到
 * 它）。这个归属**不新增依赖边**：`server/` → `runtime/` 是既有方向。
 *
 * ⚠️ **「文本契约」不构成留在这一层的理由**：`[lifecycle] state …` 是一行 CLI 落盘文本契约，
 * `bindProxyEventLogs` 的十几条同样是——判据同源，契约约束的是**那几行逐字不变**。
 * 「凭什么这个不搬」那种不对称会变成下一个人凭直觉做错事的起点。
 * ⚠️ **本类保留的进程级日志行**是那几条真的需要「谁拥有这个进程」才说得清的：
 * `[config]`（配置快照）/ `proxy started:`（ready 面）/ `[shutdown]` ×2（停机）/ banner。
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
import { logAclInert, logQuotaInert } from "@/core/log-events.js";
import { cliProcessPolicy, type ProcessPolicy, type ProcessStartupPreset, type SignalHost } from "./process.js";

/** 进程策略的现成实现与端口经本模块对外（`cli.ts` 与库调用方都从这里取，server 目录只有这一个出口）。 */
export {
  cliPreset,
  cliProcessPolicy,
  managedProcessPolicy,
} from "./process.js";
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
   * 流量配额账本的**槽位号**
   * @description
   * 由 CLI 从 **env 快照**（`PROXY_WORKER_SLOT`，cluster master 在 fork 时注入）显式传下来，
   * 一路透到 `createProxyRuntime({ trafficWorkerSlot })`。**本层与 core/runtime 都不读
   * `process.env`**：槽位会被拼进账本文件名，「自己猜来源」= 「写错文件 / 读别人的账」。
   * 省略（单进程 / 库模式）归一为 `"0"`，非法值同样归一为 `"0"`。
   */
  trafficWorkerSlot?: string;
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
   * **进程策略有两个入口，优先级写死**：`processPolicy`（显式注入）> `assembly.process`
   * （随预设一起来，CLI 走的就是它）> 缺省档 {@link cliProcessPolicy}。
   * 预设的其余字段（`protocol` / `services` / `connectors`）由 runtime 按
   * 「显式 options > assembly > 配置/缺省」三层消费，本类原样透传、不另写一份规则。
   */
  assembly?: ProcessStartupPreset;
}

/**
 * 代理服务端编排器 - 纯 CLI 进程包装器。
 *
 * 代理核心由 `createProxyRuntime()` 承载；本类只叠加 CLI 进程职责，绝不把
 * loader、信号、cluster 或配置快照打印带进库 runtime 的生命周期。
 * （⚠️ 「日志落盘」不属于本类职责，见文件头那一节。）
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
   * 进程策略：信号 / 守卫 / banner / 强制退出全部委托给它。
   * @description
   * 优先级 `processPolicy` > `assembly.process` > {@link cliProcessPolicy}——**缺省即 CLI 现状行为**。
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
   * @description
   * 与 {@link signalDisposer} 同形：**旗标兼退订句柄**。裸调
   * `process.on("uncaughtExceptionMonitor", …)`（不经端口、不受任何旗标保护）会泄漏：
   * `start → stop → start` 每轮都在进程上多挂一个闭包，每个闭包持有 `this.logger`
   * （server 对象连带整条观察面一起被钉在进程的事件表上）。
   *
   * ⚠️ **`stop()` 刻意不调它**：现状那个监听器活过 `stop()`（`start()` 装上就再也不摘），
   * 改掉这一点是**另一个决策**（会让「停机后进程里出的未捕获异常不再有本代理那一行日志」），
   * 不该由「修叠加泄漏」顺手带上。这里只保证**不叠加**。
   */
  private exceptionMonitorDisposer: (() => void) | null = null;

  constructor(options: ProxyServerOptions) {
    this.context = options.context;
    this.injectedRuntime = options.runtime;
    this.injectedEvents = options.events;
    this.logger = options.logger ?? createLogger({ config: options.context.accessor });
    this.noColor = options.noColor ?? false;
    this.workerOverride = options.isWorker;
    this.trafficWorkerSlot = options.trafficWorkerSlot;
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
      // 启动期告警落到本进程 logger：**只**接两条（`runtime.ts:reportQuotaGate` /
      // `reportAclGate`），刻意**不**把 `onWarning` 整体转发——那会把 `config-normalized`
      // 与 `start-failed` 一并变成 warn，改变 CLI 的落盘形态。
      //
      // ⚠️ **「只接白名单两条」这条裁决写在这里，免得下一个人加第三条告警时重新推导一遍**：
      // 白名单里的每一条都是「**配置有洞、服务照跑**」——
      // 运维必须知道但不必停机；白名单外的是「**归一提示 / 启动失败**」，前者是文档级的
      // 提示（已经在 `cli.ts` 按 `context.warnings` warn 过一次）、后者由启动异常本身
      // 暴露。全量转发会把两类混在同一个等级里，warn 一多就等于没有 warn。
      // **什么时候该推翻这条**：白名单到第三条时重新裁决整体转发（或改成「每条自带等级」，
      // 让 `RuntimeWarning` 携带 level 而不是一个 code→等级的隐式映射表）——那时「维护
      // 一张白名单」的成本会超过「统一渲染 + 逐条定级」的成本。
      onWarning: (w) => {
        if (w.code === "quota-inert") {
          logQuotaInert(this.logger);
        } else if (w.code === "acl-inert") {
          logAclInert(this.logger);
        }
      },
      // 槽位号显式透传：CLI 的 env 快照 → 这里 → runtime（谁都不读 process.env）
      trafficWorkerSlot: this.trafficWorkerSlot,
      // worker 身份同样**显式**透传：runtime 侧那一行 `[lifecycle] state …` 是 master 独有的日志，
      // 而 runtime 零 `cluster` 零 `process`，所以「本进程是不是子进程」只能由本类如实申报
      // （与 `trafficWorkerSlot` 同一手法）。它同时让 `runtime.options.isWorker` 不再是常量。
      isWorker: this.isWorker(),
    });
  }

  /**
   * 「注入了 `runtime`、又传了那三样」时打一条 warn —— **因为静默丢弃是最坏的失败形态**。
   *
   * @description
   * `this.runtime = this.injectedRuntime ?? this.createRuntime()`：注入的 runtime **优先**，
   * 于是同一次调用里传的 `services` / `connectors` / `assembly` **无处可去**。
   * 这三项在 `ProxyServerOptions` 上都写着「只在本类自己创建 runtime 时生效」，而那句话
   * **只在文档里、代码不兑现**——症状是「我注入了替身但行为没变」且**零线索**，调用方只能靠读源码猜。
   *
   * **为什么不抛错**：两者同时给是**合法用法**（例如只想让 server 层复用某个 runtime、
   * 顺手把预设也写上），抛错会把一个顺序问题升级成启动失败。此处只保证它**响**。
   *
   * ⚠️ **`assembly` 不是整个被忽略**：`assembly.process` 在**构造期**已解析进
   * `this.processPolicy`（优先级 `processPolicy` > `assembly.process` > 缺省档），仍然生效。
   * 忽略的只是它的 `protocol` / `services` / `connectors` 三项 —— 那三项由 runtime 消费。
   *
   * ⚠️ **判据是「真的注入了东西」而不是「字段在不在」**：`services: { ...maybe }` 条件展开成
   * `{}` 是常见写法且确实没注入任何替身，对着它报 warn 是**噪音**（warn 一多就等于没有 warn）。
   */
  private warnIgnoredRuntimeOptions(): void {
    if (!this.injectedRuntime) {
      return;
    }
    const ignored: string[] = [];
    // ⚠️ `services` 判「**有没有真的注入东西**」而不是「字段在不在」：`services: { ...maybe }`
    // 这种条件展开在 `maybe` 为空时得到 `{}`，那是**常见写法**、且确实没注入任何替身 ——
    // 按字段存在判会对着一条正常路径狂报 warn，而 warn 一多就等于没有 warn。
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
      `[start] 同时注入了 runtime 与 ${names}：注入的 runtime 优先，${names} 已被忽略`
        + "（这不是错误——两者同时给是合法用法，只是后者没有落点）"
        + "；要换服务替身/上游连接器/入站协议，请把它们传给那个 runtime 自己的构造选项，或干脆别注 runtime"
        + (this.assembly
          ? "。另：assembly.process 仍生效（构造期已解析进 processPolicy，"
            + "优先级 processPolicy > assembly.process > 缺省档），被忽略的只是它的 protocol/services/connectors"
          : ""),
    );
  }

  /**
   * 启动流程（八步次序是契约，**不因进程策略注入位而重排**）：
   * 1) 经 `processPolicy.installGuards` 装进程级容错守卫（CLI 档 = `setupProcessGuards`）
   * 2) 打印脱敏后的配置快照（密码/密钥以 *** 代替），并对常见误配给出告警
   * 3) 创建（或接收）runtime
   * 4) 事件 → 落盘绑定**由 runtime 在 `start()` 内装配**（`runtime/event-log.ts`，随它的
   *    `activateSubscriptions` 同轮）：那 11 类代理事实**与** `[lifecycle] state …` 那一行都在那里，
   *    本类不再自己订阅任何一个公共事件
   * 5) 经 `processPolicy.installSignals` 绑停机信号
   * 6) `runtime.start()`
   * 7) ready 面：worker 发 IPC `ready`；单进程打运行态行 + `processPolicy.printReady`
   * 8) `bindExceptionMonitor()` —— 经端口装 `uncaughtExceptionMonitor`（**位置固定在 ready 面
   *    之后**；「装不装」由策略说了算，且受幂等旗标保护）
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

    // ⚠️ 这里**曾经**有一个 `try { await runtime.start() } catch { unbindRuntimeObservers(); throw }`：
    // 它摘的 `lifecycle.changed` 订阅已随 `bindRuntimeLifecycle` 搬进 `runtime/event-log.ts`
    // （与 11 类代理事实同轮装配、同轮释放），本类这一层没有可摘的东西，故整段删除。
    // 「同一对象 start 失败后重试」不叠加由 runtime 侧的 `subscriptionsActive` 幂等旗标负责。
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

    // 现状这一行是裸 `process.on("uncaughtExceptionMonitor", …)`；现经端口装，位置不动
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
      // 摘信号监听（**排在最前**）：`installSignals` **返回**幂等退订函数，不摘的话
      // 「同一对象 stop → start → stop」会一层层叠加 SIGINT/SIGTERM 监听。
      // 排在排空**之后**才有意义：finally 是 `await runtime.stop()` 落地才进的，
      // 排空途中收二次信号仍然能强退（CLI 现状行为）。
      this.unbindSignals();
      // 显式 process.exit（信号处理的 finally）会截断在途 appendFile：先等齐落盘。
      // ⚠️ 事件订阅的退订**不在本类这一层**：`[lifecycle] state …` 与那 11 类代理事实的落盘
      // 绑定都住在 `runtime/event-log.ts`，由 `runtime.stop()` 的 `releaseSubscriptions()` 在
      // 排空之后统一退。**本层不持有任何事件订阅**，别在这里加退订。
      // 流量配额账本的最后一次落盘，**排在 logger.flush 之前**：
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
   * 信号宿主：把「装信号那一侧真正需要的四样」交给 `ProcessPolicy`（端口定义见 `./process.js`）。
   *
   * 每次安装造一个新对象：策略只在 `installSignals` 执行期间用它装闭包，不缓存也不跨轮复用，
   * 所以无需在实例上存一份（存了反而会让人以为它是稳定引用）。
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
   * 绑 `uncaughtExceptionMonitor`（**只观察、不改变进程行为**的那一个），具体装不装、装成什么样
   * 由 `ProcessPolicy.installExceptionMonitor` 决定——本方法只负责**幂等**。
   *
   * @description
   * ① 装不装由策略说了算（`cliProcessPolicy` 装 = CLI 逐字保留；`managedProcessPolicy`
   * 省略即不装）；② 幂等由本旗标保证，与 {@link bindSignals} 同形。
   * **裸调不行**：不经端口、不受旗标保护时 `start → stop → start` 会在进程上叠加监听
   * （每个旧闭包持有 `this.logger`）。
   *
   * 策略省略该成员时旗标恒为 null，于是每轮 `start()` 重新问一次——那不是浪费：**「没装」这件事
   * 本来就该每轮重新裁决**（调用方可能在两轮之间换掉 `processPolicy`）。
   */
  private bindExceptionMonitor(): void {
    if (this.exceptionMonitorDisposer) {
      return;
    }
    this.exceptionMonitorDisposer = this.processPolicy.installExceptionMonitor?.(this.logger) ?? null;
  }

  /**
   * 停机中再收信号：放弃排空、立刻强退。
   *
   * **worker 不走这里**（`cliProcessPolicy` 的信号处理自己判 `!host.isWorker()`）：
   * worker 的信号来自控制台广播、会与 master 的 IPC 同时到达，无法区分「同一次 Ctrl+C」与
   * 用户二次按键，兜底交给 master 的 grace SIGKILL 与 `stop()` 自身超时。
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
 * **形状与 `ProxyRuntimeOptions` / `ProxyServerOptions` 刻意统一**（三者都是「一个必填的
 * context + 一串可选项」）。位置参数形态是这条链上**唯一**的不一致：四个位置参数里有两个是
 * 布尔/字符串开关，调用点读不出「第四个是账本槽位」这种语义，也没有任何扩展位。
 *
 * 本函数**不采集宿主来源、不读 `process.env`**：槽位（`PROXY_WORKER_SLOT`）由 CLI 从 env 快照
 * 取出来经 `trafficWorkerSlot` 传进来——槽位会被拼进账本文件名，「自己猜来源」= 「写错文件 /
 * 读别人的账」。
 */
export interface RunServerOptions {
  /** 本进程 logger；省略时按已给 context 新建一份。 */
  readonly logger?: LoggerImpl;
  /** 是否禁用 banner ANSI 色码（由 CLI 从宿主 NO_COLOR 快照后显式传入）。 */
  readonly noColor?: boolean;
  /**
   * 流量配额账本槽位号（`PROXY_WORKER_SLOT`，cluster master 在 fork 时注入）。
   *
   * **只对单进程分支有意义**：master 只负责 fork/ready/退出编排，自己不开账本，
   * 故 `runAsMaster` 不接它。省略（单进程 / 库模式）归一为 `"0"`。
   */
  readonly trafficWorkerSlot?: string;
  /** 进程策略注入位（信号 / 守卫 / banner / 退出）；缺省 = CLI 档。 */
  readonly processPolicy?: ProcessPolicy;
  /** 服务替身，透传给 `ProxyServer` → `createProxyRuntime`。 */
  readonly services?: Partial<RuntimeServices>;
  /** 上游连接器源，透传给 `ProxyServer` → `createProxyRuntime`。 */
  readonly connectors?: ConnectorSource;
  /** 启动预设（如 `cliPreset()`）；形如 `StartupPreset` 加一个可选的进程位。 */
  readonly assembly?: ProcessStartupPreset;
}

/**
 * 进程级 CLI 入口 - 接收已加载配置，不自行读取宿主环境。
 * import 本模块不会加载配置；CLI 显式调用 `loadConfig()` 后把 context/logger 传进来。
 */
export async function runServer(
  context: ConfigContext,
  options: RunServerOptions = {},
): Promise<void> {
  const { logger, noColor = false, trafficWorkerSlot, processPolicy, services, connectors, assembly } =
    options;
  const activeLogger = logger ?? createLogger({ config: context.accessor });
  if (shouldRunAsMaster(context)) {
    // master 分支不变：它只 fork/ready/退出编排，既不需要账本槽位也不需要转发器/服务替身
    await runAsMaster(context, activeLogger, noColor);
    return;
  }
  const app = new ProxyServer({
    context: context,
    logger: activeLogger,
    noColor: noColor,
    trafficWorkerSlot: trafficWorkerSlot,
    processPolicy: processPolicy,
    services: services,
    connectors: connectors,
    assembly: assembly,
  });
  await app.start();
}
