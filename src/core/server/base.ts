/**
 * 代理基类 - 统一生命周期、状态管理与**服务包归一**
 * 职责：
 * - 归一化 ProxyOptions（port/host 兜底）
 * - 归一 `CoreServices`（identity / access / traffic 三项）：`identity` 与 `traffic`
 *   缺省各落一个命名单例的 inert 档（`access` 在 `ProxyOptions` 上**就是必填**、core 侧
 *   零缺省解析）——`BaseProxy` 构造期是全仓**唯一**做这件事的地方
 * - 解析一次 `ConnectorSource`（四个转发器共享同一份，不各造一个）
 * - 维护 startedAt 时间戳与运行态统计
 * - 提供 doStart/doStop 钩子约束与默认 isRunning（server.listening），复用 getStats
 * 设计：
 * - 仅持弱类型 server 引用（只读 listening 判运行态）与共享 ConnRegistry：建服/排空细节归子类
 * - 仅提供 markStarted/markStopped 供子类在 listen/close 成功回调中调用
 */

import type { Duplex } from "node:stream";
import type {
  CoreServices,
  LifecycleState,
  ProxyAuthEvent,
  ProxyOptions,
  ProxyProtocol,
  ProxyStats,
} from "@/core/types/proxy.js";
import type {
  IdentityContext,
  IdentityProvider,
  IdentityResult,
} from "@/core/types/identity.js";
import { noneIdentity } from "@/core/identity.js";
import { ContextualBase } from "@/core/context.js";
import { inertTrafficAccount, type TrafficAccount } from "@/core/traffic/index.js";
import { createConnectorSource } from "@/core/forward/upstream/connector/index.js";
import type { ConnectorSource } from "@/core/forward/upstream/connector/index.js";

/**
 * 身份端口的**显式禁用档单例**：全仓只有 `BaseProxy` 归一 `ProxyOptions` 时用一次
 * @description 刻意做成常量而不是每次 `noneIdentity()` 新建：它是纯只读的空实现，
 * 共享一个实例让「注入没生效」在对象身份上也看得出来（各处拿到的都是同一个）。
 *
 * 语义是「**这里没有身份识别**」而不是「配置坏了」：恒放行、恒不剥任何出站凭证。
 * 真正的默认实现（读 `users.json` + `AUTH_TYPE` 四个模式之一）**只在唯一组装根
 * `createProxyRuntime` 解析**（`runtime/services.ts:buildDefaultServices`），与 `traffic`
 * 的既有纪律完全一致。
 */
const NONE_IDENTITY: IdentityProvider = Object.freeze(noneIdentity());

/**
 * 流量配额端口的**显式禁用档单例**：全仓只有 `BaseProxy` 归一 `ProxyOptions` 时用一次
 * @description 刻意做成常量而不是每次 `inertTrafficAccount()` 新建：它是纯只读的空实现，
 * 共享一个实例让「注入没生效」在对象身份上也看得出来（各处拿到的都是同一个）。
 */
const INERT_TRAFFIC_ACCOUNT: TrafficAccount = Object.freeze(inertTrafficAccount());

/**
 * 连接登记表 - 存量连接追踪与强制排空
 * 职责：
 * - track：登记新连接，close 时自动移除，避免集合随连接数无限增长
 * - drain：关服时强制销毁存量连接——idle/隧道连接会让 server.close 回调迟迟不触发
 * 设计：
 * - http / socks 两分支共用一份实现，消除逐字重复的「登记 + 排空」
 * - drain 可选传入 server：具备原生 closeAllConnections()（http.Server）时**先**走一次原生优化，
 *   但**无论走不走原生都要逐条兜底销毁**（原因见 drain 的 @description）
 */
export class ConnRegistry {
  /** 存量连接集合：track 加入、close 移除，drain 据此销毁 */
  private readonly conns = new Set<Duplex>();

  /**
   * 登记一条连接：加入集合并在 close 时自动移除
   * @param socket - 客户端双工流（net.Socket / tls.TLSSocket / http 连接）
   */
  track(socket: Duplex): void {
    this.conns.add(socket);
    socket.once("close", () => {
      this.conns.delete(socket);
    });
  }

  /**
   * 排空：销毁全部未销毁的存量连接并清空登记
   *
   * @description **原生优化与兜底销毁两者都做，不是二选一。**
   *
   * 先按需调 `server.closeAllConnections()`（只有 `http.Server` / `https.Server` 有；`net.Server` /
   * `tls.Server` 的 SOCKS 分支没有，走不到这里），**之后照样**逐条销毁 `this.conns` 里未销毁的
   * socket，最后 `clear()`。
   *
   * 为什么原生路径之后仍必须兜底：Node 的 `closeAllConnections()` **只覆盖它自己的连接表**，
   * 而 `connect` / `upgrade` 事件发出后该 socket 已**脱离**这张表（升级后的连接不再由 HTTP
   * 解析器托管）。所以一条活着的 CONNECT 隧道 / WebSocket 连接不会被它碰到，而 `server.close(cb)`
   * 要等**所有**连接都结束才回调 —— 隧道不被拆掉，`stop()` 就永久挂起。
   *
   * 两者的分工：原生调用一次性覆盖 idle keep-alive 那一大类（不必自己遍历，是它的强项），
   * 兜底循环负责它结构上覆盖不到的升级连接与任何非 http 承载；`destroyed` 判断保证重复销毁无害。
   *
   * 回归护栏：`tests/integration/stop-drain-live-tunnel.test.ts`（活隧道下 `stop()` 必须在预算内完成）
   * @param server - 可选底层服务实例；具备 `closeAllConnections()` 时先走原生优化，SOCKS 分支不传
   */
  drain(server?: { closeAllConnections?(): void } | null): void {
    // 原生优化：一次性拆掉 Node 连接表里的全部连接（idle keep-alive 走这条最省）
    if (typeof server?.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    // 兜底销毁：**原生路径覆盖不到的正是已升级的 socket**（CONNECT / upgrade 隧道），
    // 不遍历它们 `server.close(cb)` 的回调就永不触发、`stop()` 挂死；
    // SOCKS 分支（net.Server / tls.Server 无原生方法）走的也正是这段，行为与修复前逐字一致
    for (const c of this.conns) {
      if (!c.destroyed) {
        c.destroy();
      }
    }
    this.conns.clear();
  }
}

/**
 * 可监听 server 的最小形状：net.Server / tls.Server / http.Server 均结构满足
 * 只声明实际用到的三个方法，避免绑定具体 Server 类型
 */
export interface ListenableServer {
  listen(port: number, host: string, cb: () => void): unknown;
  once(event: "error", cb: (e: Error) => void): unknown;
  off(event: "error", cb: (e: Error) => void): unknown;
}

/**
 * 监听端口并等待就绪（`BaseProxy.closeServer` 的建服对称面）
 * @description 把「listen 并等就绪」的同一段 Promise 包装收敛到一处，供 http/https/net/tls
 * 各 Server 复用（`net.Server` 为共同基类）。监听期 error（如 EADDRINUSE）直接 reject，
 * 由调用方转 error 态；就绪后解绑临时 error 监听，避免启动失败监听器常驻
 * （后续 server error 由各代理的 `bindServer`/`onListenerReady` 接管）。
 * @param server - 任何具备 listen/once/off 的 Server 实例
 * @param port - 监听端口
 * @param host - 监听地址
 * @throws listen 失败时抛错，由调用方转 error 态
 * @example
 * ```ts
 * await listenAsync(server, 1080, "0.0.0.0");
 * ```
 */
export function listenAsync(server: ListenableServer, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/**
 * 代理基类 - 统一生命周期状态机与钩子编排
 * 状态流转：idle -> starting -> running -> stopping -> stopped
 *          （可重入 starting）
 * 异常分支：任意环节抛错 -> error，需外部重试或重启
 * 事件：core 的**全部**事实（含生命周期跃迁）都直接发布到注入的 `EventHub`（`ctx.events`）。
 *       本类**不继承 Node `EventEmitter`**：`setState()` 发 `lifecycle.changed`
 *       （`{ next, prev }`），与「一个事实一个来源」对齐。
 * 依赖：`extends ContextualBase` 一次性提供 `this.config` / `this.log` / `this.events` 三个
 *      protected getter（**每次现读 `this.ctx`，绝不缓存成字段**——`RuntimeContext.setEvents()`
 *      能在运行期换总线，缓存会把「换完立刻生效」变成半个进程级暗改）。
 */
export abstract class BaseProxy extends ContextualBase {
  /** 协议标识，由子类通过 super(protocol) 传入 */
  readonly protocol: ProxyProtocol;

  /** 归一化后的选项，保证 port/host 必有值，避免子类重复判空 */
  readonly options: Readonly<Required<ProxyOptions>>;

  /**
   * **归一后的服务包**（`CoreServices` 三项全必填，`Object.freeze` 后的只读视图）
   * @description `identity` 与 `traffic` 是**可选 + 各自带一个命名单例的 inert 档**
   * （`identity ?? NONE_IDENTITY` / `traffic ?? INERT_TRAFFIC_ACCOUNT`），
   * **缺省解析在本构造期发生且仅发生一次**。`access` **不在这一档里**：它在 `ProxyOptions`
   * 上就是必填，core 侧零缺省解析（理由见 `ProxyOptions.access` 的注释与 `types/proxy.ts`）。
   * 之后 core 内部一路拿到的都是这个非 optional 的冻结包：转发器与准入层因此不必在每个
   * 使用点写 `?.` / `??`，「忘注入」也不会退化成运行期的 `undefined is not a function`。
   *
   * **两个 inert 档的语义各不相同，别混**：`identity` 缺省 = 不判身份（不鉴权）、
   * `traffic` 缺省 = 不计量（不计费）——都读作「这个部署没配这一项」而不是「配坏了」，
   * 后者是配置校验层的事。`access` 缺席是**取消防护**（全放行）而不是关闭功能，方向相反，
   * 所以它走「编译期强制必填」而不是「缺省档」那套。
   *
   * 真正的默认实现**只在唯一组装根解析**（`createProxyRuntime` → `runtime/services.ts:
   * buildDefaultServices`），所以库调用方注入的替身一定原样生效。
   */
  protected readonly services: CoreServices;

  /**
   * 上游接入来源（装配期已解析完毕的「直连 / 走上游」两档）
   * @description **在 `BaseProxy` 构造期解析一次**，四个转发器共享**同一个** source。
   * 每个转发器各造一份的后果不是「多几个对象」而是**语义错误**：连接器是无状态的、
   * 本可安全复用，但「记忆上游协议」这件事一旦按实例分叉，同一个进程里就会出现两个
   * `upstreamProtocol` 的真相源（`ConnectorSource` 模块头那条「记忆协议」正确性论证的前提
   * 就是「同一个 source 永远只认第一次看到的值」）。默认实现在这里解析
   * （`createConnectorSource` 本身是零分配的惰性门面，构造期调用不产生副作用）；
   * 库调用方可注入自己的实现替换整条上游接入。
   */
  protected readonly connectors: ConnectorSource;

  /**
   * 身份端口（`protected` 别名，与 `services.identity` **恒为同一对象**）
   * @description 只服务两个 protected 消费点：`authorize()` 调 `identify()`，
   * `SocksProxyBase.sessionHost()` 闭包桥接给 SOCKS 会话处理器读 `isEnabled`。
   * 之所以留这个别名而不是让两处都写 `this.services.identity`：`sessionHost` 的产物是
   * 给 `socks-session.ts` 的最小接口，字段名 `identity` 比 `services.identity` 更贴近那份
   * 接口自己的形状，而**别名指向同一个对象**、不构成第二份配置真相源。
   * 未注入时即上面那个显式禁用档（恒放行、恒不剥凭证），与 `access` / `traffic` 的缺省档同构。
   */
  protected readonly identity: IdentityProvider;

  /** 最近一次启动成功的时间戳，未启动或已停止为 undefined */
  protected startedAt?: number;

  /** 底层服务实例的弱类型引用：由子类赋值/置空，基类只读 listening 判运行态 */
  protected server: { readonly listening: boolean } | null = null;

  /** 存量连接登记表：子类 track 新连接，doStop 经 drain 强制销毁避免 stop 挂起 */
  protected readonly registry = new ConnRegistry();

  /** 当前生命周期状态，初始 idle */
  private _state: LifecycleState = "idle";

  /**
   * 在途 start 的 promise（仅在 starting 态存在）
   * 用途：stop() 处于 starting 态时先 await 它，串行化启停，
   *       避免「stop 抢先置 stopped，start 完成后又把状态改回 running」的乱序与套接字泄漏
   */
  private startInFlight?: Promise<void>;

  /**
   * 当前生命周期状态的只读视图
   * @returns 现态（idle/starting/running/stopping/stopped/error），初始为 idle
   */
  get state(): LifecycleState {
    return this._state;
  }

  /**
   * 构造基类
   * @param protocol - 协议标识，决定 getStats 展示与工厂注册 key
   * @param options - 外部注入的端口、地址、三个服务位与**必填**依赖上下文 `ctx`；
   *   端口/地址等可选字段由基类归一化
   */
  constructor(protocol: ProxyProtocol, options: ProxyOptions) {
    // 依赖上下文**先于** options 归一化落到基类：`ContextualBase` 构造只做一次 `this.ctx` 赋值，
    // 零副作用（不订阅/不读配置/不打日志），故此刻读不到 `this.config`/`this.log`/`this.events`
    // 是不可能的——构造体内这三者的第一次使用都在 `setState` 之后（且本类构造期不做任何发布）。
    super(options.ctx);
    this.protocol = protocol;
    // ── 服务包归一（全仓唯一一次，缺省解析只发生在这里） ──
    // 顺序有讲究：`services` 必须先于 `options` 建好（后者要读前者的归一结果），
    // 而 `connectors` 必须在**任何**转发器字段初始化之前就位——`SocksProxyBase.forwarder`
    // 是字段初始化器，它在 `super()` 返回后才跑（TS 规范：字段初始化器在基类构造之后、
    // 构造函数体之前执行），故本构造体内的赋值天然早于它，时序安全。
    this.services = Object.freeze({
      // 身份：显式注入优先，未注入 = 显式禁用档（恒放行、恒不剥出站凭证）
      identity: options.identity ?? NONE_IDENTITY,
      // 访问控制：**必填、零缺省解析**（`ProxyOptions.access` 上就没有 `?`）。
      // ⚠️ 全仓不存在「恒放行」的 `OPEN_ACCESS_CONTROL` 那个缺省档：它会让「忘注入」
      // 变成「配了名单却全放行、且零信号」，而这个失败形态必须在编译期就被拦住。
      access: options.access,
      // 流量配额：显式注入优先，未注入 = 显式禁用档（不计量、不判定）
      traffic: options.traffic ?? INERT_TRAFFIC_ACCOUNT,
    });
    this.connectors = options.connectors ?? createConnectorSource(options.ctx);
    this.identity = this.services.identity;
    this.options = Object.freeze({
      port: options.port ?? 3000,
      host: options.host ?? "0.0.0.0",
      upstreamTimeout: options.upstreamTimeout ?? 10000,
      tls: Object.freeze({ ...(options.tls ?? {}) }),
      isWorker: options.isWorker ?? false,
      // 三个服务位与 `connectors` 落的是**归一后的值**（不是 `options.x` 原文）：否则同一个
      // 事实会有两个入口（options 上的原文 + services 上的归一值），且 `Required<ProxyOptions>`
      // 会谎称「它们必有」而实际可能 undefined
      identity: this.services.identity,
      access: this.services.access,
      traffic: this.services.traffic,
      connectors: this.connectors,
      // 依赖上下文由调用方显式注入；原样赋值，不冻结、不做任何缺省解析
      // （三件套的缺省解析只发生在唯一组装根 createProxyRuntime）
      ctx: options.ctx,
    });
  }

  /**
   * 内部状态跃迁并发布 `lifecycle.changed`
   * 相同状态直接跳过，避免重复触发（同一条跃迁**恰好一条**事件）
   *
   * @description `this.events` 是 `ContextualBase` 的继承 getter，每次现读 `this.ctx.events`，
   * `RuntimeContext.setEvents()` 换总线后下一跃迁即生效——**绝不允许把 hub 缓存成字段**。
   * @param next - 目标生命周期状态
   */
  protected setState(next: LifecycleState): void {
    const prev = this._state;
    if (prev === next) {
      return;
    }
    this._state = next;
    this.events.publish("lifecycle.changed", { next, prev });
  }

  // ── 生命周期钩子（子类可选覆盖） ──
  /**
   * start 前钩子：校验配置/加载证书
   * 基类默认为空实现，子类按需覆盖
   */
  async onBeforeStart(): Promise<void> {}

  /**
   * start 后钩子：注册探针/打日志
   * 已处于 running 态后调用，抛错不回滚状态
   */
  async onStarted(): Promise<void> {}

  /**
   * stop 前钩子：优雅排空、拒绝新连接
   * 基类默认为空实现
   */
  async onBeforeStop(): Promise<void> {}

  /**
   * stop 后钩子：清理定时器/缓存等资源
   * 已处于 stopped 态后调用
   */
  async onStopped(): Promise<void> {}

  /**
   * 启动代理服务 - 模板方法：编排状态机 + 钩子
   * 流程：幂等检查 -> setState(starting) -> onBeforeStart
   *       -> doStart（子类建服） -> markStarted
   *       -> setState(running) -> onStarted
   * 幂等：running/starting 或 server 已 listening 时直接返回
   * 串行化：执行体以 this.startInFlight 记录，供 stop() 在 starting 态等待
   * @throws 建服或钩子抛错时透出，状态转为 error
   */
  async start(): Promise<void> {
    if (this._state === "running" || this._state === "starting") {
      return;
    }

    // 幂等：已在运行/启动中直接返回
    if (this.isRunning()) {
      // server 已 listening 但状态未同步时校正
      this.setState("running");
      return;
    }

    // 进入启动态
    this.setState("starting");

    // 记录在途启动 promise：stop() 在 starting 态据此串行等待（见 stop）
    const inFlight = this.runStart();
    this.startInFlight = inFlight;
    try {
      await inFlight;
    } finally {
      // 启动落地（成功/失败）后清空，避免悬挂引用
      if (this.startInFlight === inFlight) {
        this.startInFlight = undefined;
      }
    }
  }

  /**
   * 启动的执行体 - 钩子编排与状态跃迁
   * 由 start() 包装为在途 promise，供 stop() 串行等待；异常统一转 error 态并透出
   * @throws onBeforeStart/doStart/onStarted 抛错时透出
   */
  private async runStart(): Promise<void> {
    try {
      // 前置钩子：如加载证书/校验配置
      await this.onBeforeStart();

      // 子类建服
      await this.doStart();

      // 记录 startedAt
      this.markStarted();

      // 标记运行
      this.setState("running");

      // 后置钩子：日志/探针
      await this.onStarted();
    } catch (e) {
      // 异常转 error 态
      this.setState("error");
      throw e;
    }
  }

  /**
   * 停止代理服务 - 模板方法：与 start 对称
   * 流程：幂等检查 -> [starting 态先等在途 start 落地]
   *       -> setState(stopping) -> onBeforeStop
   *       -> doStop（子类关服） -> markStopped
   *       -> setState(stopped) -> onStopped
   * 串行化：处于 starting 时先 await 在途 start（吞掉其异常），再走正常停止流程，
   *         保证最终态为 stopped 且无监听残留
   * 幂等：idle/stopped/stopping 或无 server 且非 running/error 时直接返回
   * @throws 关服或钩子抛错时透出，状态转为 error
   */
  async stop(): Promise<void> {
    if (this._state === "idle" || this._state === "stopped" || this._state === "stopping") {
      // 幂等：未启动/已停止直接返回
      return;
    }

    if (this._state === "starting") {
      // 启动在途：先等 start 落地再停止，避免 stop 抢先返回后 start 又置 running
      const inFlight = this.startInFlight;
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // 启动失败已转 error 态，继续向下收尾
        }
      }
    }

    if (!this.isRunning() && this._state !== "running" && this._state !== "error") {
      // 无 server 且非运行态，直接标记停止
      this.setState("stopped");
      return;
    }

    // 进入停止态
    this.setState("stopping");

    try {
      // 前置：优雅排空拒绝新连接
      await this.onBeforeStop();

      // 子类关服
      await this.doStop();

      // 清空 startedAt
      this.markStopped();

      this.setState("stopped");

      // 后置：清理资源
      await this.onStopped();
    } catch (e) {
      this.setState("error");
      throw e;
    }
  }

  /**
   * 子类实现：真实建服（创建 server + listen + 绑事件）
   * 在 starting 态内被 start() 调用，成功后由基类 markStarted
   * @throws 建服失败时抛错，基类将其转为 error 态
   */
  protected abstract doStart(): Promise<void>;

  /**
   * 子类实现：真实关服（close + 置空 server）
   * 在 stopping 态内被 stop() 调用，成功后由基类 markStopped
   * @throws 关服失败时抛错，基类将其转为 error 态
   */
  protected abstract doStop(): Promise<void>;

  /**
   * 关服模板：close 拒绝新连接 + `registry.drain` 排空存量连接
   * @description 主动断开存量 keep-alive/隧道连接，否则 `close` 的回调要等这些连接自然结束才触发；
   * `drain` 先按需走原生 `closeAllConnections()`（http/https.Server 有，net/tls.Server 的 SOCKS
   * 分支没有）**再一律兜底逐条销毁**登记的连接——原生调用不覆盖已升级（CONNECT / upgrade）的
   * socket，只走它会让活着的隧道把 `close` 回调永久挡住。分工与理由见 `ConnRegistry.drain`，
   * 调用方只需透传 server 本身
   * @param server - 待关闭的底层服务；null/undefined 直接返回（幂等）
   */
  protected closeServer(
    server: { close(cb: () => void): unknown; closeAllConnections?(): void } | null | undefined,
  ): Promise<void> {
    if (!server) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      this.registry.drain(server);
    });
  }

  /**
   * 是否处于监听态：默认以子类持有的 server.listening 判断
   * 与 _state 可能短暂不一致；需要不同判定逻辑的子类可覆盖（如测试桩以标记位代替 server）
   * @returns server 正在监听返回 true，否则 false
   */
  isRunning(): boolean {
    return !!this.server?.listening;
  }

  /**
   * 获取运行态快照
   * @returns 包含协议、端口、地址、运行态与启动时间的对象
   */
  getStats(): ProxyStats {
    return {
      protocol: this.protocol,
      port: this.options.port,
      host: this.options.host,
      running: this.isRunning(),
      startedAt: this.startedAt,
    };
  }

  /**
   * 标记已启动，供子类在 server.listen 成功回调中调用
   * 作用：记录 startedAt，供 getStats 与外部监控使用
   */
  protected markStarted(): void {
    this.startedAt = Date.now();
  }

  /**
   * 标记已停止，供子类在 server.close 回调中调用
   * 作用：清空 startedAt，避免展示过期时间
   */
  protected markStopped(): void {
    this.startedAt = undefined;
  }

  /**
   * 统一身份识别入口 - 供所有子类调用
   * 流程：包装 onAuthEvent，经 ctx.events 直接发布 `auth.decided`
   *       （身份维度进 context，tag 进 payload）
   *       -> 调 identity.identify -> 异常视为不通过
   * @param ctx - 本次请求的身份上下文
   * @returns 识别结果：`{ passed, username }`；异常一律转 `{ passed: false }`
   */
  protected async authorize(ctx: IdentityContext): Promise<IdentityResult> {
    const prev = ctx.onAuthEvent;
    ctx.onAuthEvent = (e) => {
      // 把协议入口注入的请求/连接标识补进鉴权事件：
      // 公共事件面的 `auth.decided` 据此与该请求的终态事件按 requestId 串联
      const enriched: ProxyAuthEvent =
        e.requestId === undefined && e.connectionId === undefined
          ? {
              ...e,
              ...(ctx.requestId !== undefined ? { requestId: ctx.requestId } : {}),
              ...(ctx.connectionId !== undefined ? { connectionId: ctx.connectionId } : {}),
            }
          : e;
      // core 直接发 `auth.decided`，不经 EventEmitter 中转。
      // `EventHub` 已隔离单个 listener 的异常，故这里不需要（也不该再有）try/catch 包裹。
      this.events.publish(
        "auth.decided",
        {
          passed: enriched.passed,
          user: enriched.user,
          attempted: enriched.attempted,
          reason: enriched.reason,
          tag: enriched.tag,
        },
        {
          protocol: this.protocol,
          client: enriched.client,
          user: enriched.user,
          target: enriched.target,
          ...(enriched.requestId !== undefined ? { requestId: enriched.requestId } : {}),
          ...(enriched.connectionId !== undefined ? { connectionId: enriched.connectionId } : {}),
        },
      );
      if (prev) {
        prev(enriched);
      }
    };

    try {
      return await this.identity.identify(ctx);
    } catch {
      return { passed: false };
    } finally {
      ctx.onAuthEvent = prev;
    }
  }
}
