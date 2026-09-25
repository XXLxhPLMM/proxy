/**
 * 代理基类 - 统一生命周期与状态管理
 * 职责：
 * - 归一化 ProxyOptions（port/host 兜底）
 * - 维护 startedAt 时间戳与运行态统计
 * - 提供 doStart/doStop 钩子约束与默认 isRunning（server.listening），复用 getStats
 * 设计：
 * - 仅持弱类型 server 引用（只读 listening 判运行态）与共享 ConnRegistry：建服/排空细节归子类
 * - server 引用的所有权纪律：**只在 `closeServer` resolve（关服兑现）之后清空**；
 *   关服失败一律保留引用并抛错，让 `stop()` 落 `error` 且重试能真正重试到同一个 server
 * - 仅提供 markStarted/markStopped 供子类在 listen/close 成功回调中调用
 * - 启停票据（deferred）一律先登记再 setState：stateChange 同步重入只会复用同一 promise
 * - setState 先落地状态再 emit，并隔离 stateChange 监听器的同步抛错（同 authorize 的 emit 保护）：
 *   订阅方缺陷不参与生命周期成败判定，既不覆盖 runStart/runStop 主错误，也不把已完成的 stop 误报 error
 */

import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import type {
  LifecycleState,
  ProxyEventMap,
  ProxyLifecycleErrorCode,
  ProxyOptions,
  ProxyProtocol,
  ProxyStats,
} from "../types/proxy.js";
import type { AuthContext, AuthProvider, AuthResult } from "../types/auth.js";
import { Auth } from "../auth.js";
import { getLogger } from "@/utils/logger.js";

/**
 * 连接登记表 - 存量连接追踪与强制排空
 * 职责：
 * - track：登记新连接，close 时自动移除，避免集合随连接数无限增长
 * - drain：关服时强制销毁存量连接——idle/隧道连接会让 server.close 回调迟迟不触发
 * 设计：
 * - http / socks 两分支共用一份实现，消除逐字重复的「登记 + 排空」
 * - drain 可选传入 server：具备原生 closeAllConnections()（http.Server）时改走原生优化，
 *   否则（含 net.Server/tls.Server 的 SOCKS 分支）手动逐条销毁
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
   * @param server - 可选底层服务实例；传入且具备 closeAllConnections() 时走原生优化，SOCKS 分支不传
   */
  drain(server?: { closeAllConnections?(): void } | null): void {
    // 特性检测：具备原生 closeAllConnections()（http.Server）走原生，否则手动销毁存量连接
    if (typeof server?.closeAllConnections === "function") {
      server.closeAllConnections();
    } else {
      for (const c of this.conns) {
        if (!c.destroyed) {
          c.destroy();
        }
      }
    }
    this.conns.clear();
  }
}

/**
 * 生命周期准入拒绝 - 停机在途时禁止重新进入启动
 * @description `stopInFlight` 存在或状态为 `stopping` 时，`start()` 一律以该错误拒绝：
 * 既不走 `isRunning()` 快捷路径伪装成功，也不并发跑第二个 `doStart`。
 * `code` 与 server 层停机 ownership 闸门（`ProxyServer.start()`）完全一致，
 * 调用方按 code 统一重试，不必区分是哪一层拒绝（注意 server 侧是同 code 的私有类，
 * `instanceof` 不可跨层复用）；full stop settle 后再显式重试。
 * @example (e as { code?: string }).code === "ERR_PROXY_STOP_IN_PROGRESS"
 */
export class ProxyStopInProgressError extends Error {
  /**
   * 稳定错误码：与 server 层停机 ownership 闸门同一个 code
   * 字面量用 `satisfies ProxyLifecycleErrorCode` 绑到 types/proxy.ts 的唯一码来源：
   * 联合里缺这个码就编译不过，联合将来新增码也不会把本字段类型悄悄放宽
   */
  readonly code = "ERR_PROXY_STOP_IN_PROGRESS" satisfies ProxyLifecycleErrorCode;

  constructor() {
    super("Proxy stop is still in progress");
    this.name = "ProxyStopInProgressError";
  }
}

/**
 * 关服 deadline 常量 - 等待 `server.close` 回调兑现的有界上限
 * @description 纯安全网，不是关服预算的调节旋钮：正常路径（close 回调 + 排空）都是毫秒级。
 * 取值约束（跨层，见根 AGENTS.md 停机预算）：必须**小于** runtime 的 15s service deadline
 * 与 worker 的 20s stop grace（`src/server/lifecycle-budget.ts`），否则「close 永不兑现」
 * 会被外层超时/强退掩盖，core 永远拿不到机会把失败诚实报成 `error` + 可重试句柄。
 * 10s 留出 5s 余量给 onStopped 与其余收尾。
 */
const CLOSE_DEADLINE_MS = 10_000;

/**
 * 关服超时 - `server.close` 的回调在有界 deadline 内没有兑现
 * @description 这是 `stop()` 唯一允许的「非 close error」失败源：宁可落 `error` 态并保留
 * server 句柄供重试，也绝不让 `runStop` 永久 pending（调用方的公开 grace 到点后只能靠
 * 强退收场，core 连失败事实都报不出来）。
 * `code` 同样绑到 `ProxyLifecycleErrorCode` 唯一码来源，调用方可与 `ERR_SERVER_NOT_RUNNING`
 * 这类「close 明确报错」区分开：前者是「没消息」，后者是「明确说不行」。
 * @example (e as { code?: string }).code === "ERR_PROXY_CLOSE_TIMEOUT"
 */
export class ProxyCloseTimeoutError extends Error {
  /** 稳定错误码：先登记进 `ProxyLifecycleErrorCode` 联合再落地实现（禁止裸写字面量） */
  readonly code = "ERR_PROXY_CLOSE_TIMEOUT" satisfies ProxyLifecycleErrorCode;

  /** 实际生效的 deadline 毫秒数：随实例带出，便于上层日志/预算核算定位 */
  readonly deadlineMs: number;

  constructor(deadlineMs: number) {
    super(`Proxy server close did not settle within ${deadlineMs}ms`);
    this.name = "ProxyCloseTimeoutError";
    this.deadlineMs = deadlineMs;
  }
}

/**
 * 在途生命周期票据（deferred）
 * @description 票据在 `setState` 之前**同步**登记，`stateChange` 监听器同步重入
 * start/stop 时能立刻看到「已有在途」，只会复用同一 promise，绝不并发第二个执行体。
 * `promise` 挂着永久 noop rejection 消费器：调用方不 await 也不会产生 unhandledRejection，
 * 而真正 await 的一方拿到的仍是原始错误对象（identity 不变）。
 */
type InFlightTicket = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/** 建立在途票据并预挂 rejection 消费器：迟到的成败只交给真正 await 的调用方 */
function createInFlightTicket(): InFlightTicket {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // 消费器永不拆除：拒绝路径上任何「无人 await」的分支都不会变成 unhandledRejection
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/**
 * 代理基类 - 统一生命周期状态机与钩子编排
 * 状态流转：idle -> starting -> running -> stopping -> stopped
 *          （可重入 starting）
 * 异常分支：任意环节抛错 -> error（原始错误原样透出），需外部重试或重启
 * 准入闸门：stopping / 停机在途时 start() 以 ProxyStopInProgressError 拒绝
 * 事件：ProxyEventMap 全量类型化
 *       （stateChange/forward/auth/pipe/...），
 *       emit/on 两头编译期检查，事件契约见 types/proxy.ts；
 *       stateChange 监听器抛错由 setState 就地隔离，不参与生命周期成败判定
 */
export abstract class BaseProxy extends EventEmitter<ProxyEventMap> {
  /** 协议标识，由子类通过 super(protocol) 传入 */
  readonly protocol: ProxyProtocol;

  /** 归一化后的选项，保证 port/host 必有值，避免子类重复判空 */
  readonly options: Required<ProxyOptions>;

  /** 鉴权提供者，默认 AllowAll，子类通过 authorize() 统一调用 */
  protected readonly auth: AuthProvider;

  /** 最近一次启动成功的时间戳，未启动或已停止为 undefined */
  protected startedAt?: number;

  /** 子类共用日志 */
  protected readonly log = getLogger("BaseProxy");

  /**
   * 底层服务实例的弱类型引用：由子类赋值/置空，基类只读 listening 判运行态
   * 置空纪律：只在 `closeServer` resolve 之后清空（关服兑现）；关服失败一律保留引用，
   * 使 `isRunning()`/`getStats()` 继续反映真实监听态，并让 `stop()` 重试命中同一个 server
   */
  protected server: { readonly listening: boolean } | null = null;

  /** 存量连接登记表：子类 track 新连接，doStop 经 drain 强制销毁避免 stop 挂起 */
  protected readonly registry = new ConnRegistry();

  /** 当前生命周期状态，初始 idle */
  private _state: LifecycleState = "idle";

  /**
   * 在途 start 票据（starting 态恒非空）
   * 用途：① stop() 处于 starting 态时先 await 它，串行化启停，
   *       避免「stop 抢先置 stopped，start 完成后又把状态改回 running」的乱序与套接字泄漏；
   *       ② starting 态的 start() 幂等重入复用同一 promise。
   * 登记时机：早于 setState("starting")，同步无 await，否则 stateChange 监听器
   *          同步调用 stop() 时看不到在途 start。
   */
  private startInFlight?: InFlightTicket;

  /**
   * 在途 stop 票据（stopping 态恒非空，settle 前后短暂窗口仍保留）
   * 用途：① stop() 重入/并发调用复用同一 promise，必须等到 onStopped 真正完成；
   *       绝不能因为 state 已是 stopping 就提前宣告 stopped；
   *       ② start() 的准入闸门：票据存在即拒绝启动。
   * 登记时机：早于 setState("stopping")，同步无 await。
   */
  private stopInFlight?: InFlightTicket;

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
   * @param options - 外部注入的端口与地址，未传则使用 3000 / 0.0.0.0，
   *                  auth 未传则默认放行
   */
  constructor(protocol: ProxyProtocol, options: ProxyOptions = {}) {
    super();
    this.protocol = protocol;
    this.options = {
      port: options.port ?? 3000,
      host: options.host ?? "0.0.0.0",
      auth: options.auth ?? new Auth({ enabled: false }),
      upstreamTimeout: options.upstreamTimeout ?? 10000,
      tls: options.tls ?? {},
      isWorker: options.isWorker ?? false,
    } as Required<ProxyOptions>;
    this.auth = this.options.auth;
  }

  /**
   * 内部状态跃迁并发出事件
   * 相同状态直接跳过，避免重复触发 stateChange
   * 语义（两条硬约束）：
   * - 先写 `this._state` 再 emit：即使监听器抛错，状态也已落地，不会留下「emit 抛错 → 状态没变」的裂缝
   * - `stateChange` 监听器同步抛错**就地隔离**（同 `authorize` 的 emit 保护）：监听器是订阅方，
   *   它的 bug 不得冒泡进生命周期控制流，否则会覆盖 runStart/runStop 的原始主错误，
   *   或把 `markStopped` 之后的正常停机误判成 `error`。core 零日志，此处不打印
   * @param next - 目标生命周期状态
   */
  protected setState(next: LifecycleState): void {
    const prev = this._state;
    if (prev === next) {
      return;
    }
    this._state = next;
    try {
      this.emit("stateChange", next, prev);
    } catch {
      // 病态 stateChange 监听器抛错：状态已落地，异常就地丢弃，不污染生命周期主错误
      // （EventEmitter 语义下后续监听器仍会被跳过——那是该监听器自身的缺陷，不在兜底范围）
    }
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
   * 在 doStop 完成后、状态跃迁 stopped 之前调用；钩子抛错则保持 error 态，
   * 绝不能先把 state 伪装成 stopped 再让清理失败被吞掉。
   */
  async onStopped(): Promise<void> {}

  /**
   * 启动代理服务 - 模板方法：准入闸门 + 状态机 + 钩子
   * 流程：停机闸门（stopInFlight 或 stopping 一律拒绝）-> 复用同一在途 start
   *       -> 幂等（running / server 已 listening）-> 登记在途票据（同步，早于 setState）
   *       -> setState(starting) -> onBeforeStart -> doStart（子类建服） -> markStarted
   *       -> setState(running) -> onStarted
   * 幂等：running 或 server 已 listening 时校正状态直接返回；starting 态复用同一在途 promise
   * 串行化：执行体以 startInFlight 记录，供 stop() 在 starting 态等待、供同步重入复用
   * @returns 启动完成的 promise；停机在途时以 `ProxyStopInProgressError` 拒绝
   * @throws 建服或钩子抛错时透出，状态转为 error
   */
  start(): Promise<void> {
    // 准入闸门：停机在途或 stopping 态一律拒绝。此判定必须排在 isRunning 快捷路径之前——
    // 旧顺序会把「正在关服但 server 仍 listening」判成启动成功，或并发跑第二个 doStart。
    if (this.stopInFlight || this._state === "stopping") {
      return Promise.reject(new ProxyStopInProgressError());
    }

    // starting 态复用同一在途 promise：stateChange 同步重入 start 不会并发跑第二个 doStart
    const inFlight = this.startInFlight;
    if (inFlight) {
      return inFlight.promise;
    }

    // 幂等：已 running / server 已 listening 时校正状态直接返回
    if (this._state === "running" || this.isRunning()) {
      this.setState("running");
      return Promise.resolve();
    }

    // 同步登记在途票据（无 await）：必须早于 setState("starting")，否则 stateChange 监听器
    // 同步调用 stop() 时看不到在途 start，会把 stop 提前收敛成 stopped，再被迟到的 start 改回 running。
    const ticket = createInFlightTicket();
    this.startInFlight = ticket;
    try {
      this.setState("starting");
    } catch (error) {
      // setState 已隔离 stateChange 监听器抛错，这里只兜「子类覆写 setState 后抛错」：
      // 票据必须就地收口，绝不能悬挂成永不 settle 的在途 start（那会让后续 start 永远重入复用它）
      this.releaseTicket("start", ticket);
      ticket.reject(error);
      return ticket.promise;
    }
    void this.runStartLifecycle(ticket);
    return ticket.promise;
  }

  /**
   * 启动生命周期驱动 - 把执行体成败收口到票据
   * 自身永不 reject：失败一律转交票据的 reject，由真正 await 的调用方消费，
   * 因此 `void` 掉本 promise 不会产生 unhandledRejection
   * @param ticket - 已在 setState("starting") 之前登记的在途票据
   */
  private async runStartLifecycle(ticket: InFlightTicket): Promise<void> {
    try {
      await this.runStart();
      this.releaseTicket("start", ticket);
      ticket.resolve();
    } catch (error) {
      this.releaseTicket("start", ticket);
      ticket.reject(error);
    }
  }

  /**
   * 释放在途票据 - identity 比对
   * 迟到结果只能释放自己的票据，绝不能清掉后一轮的在途标记
   * @param kind - start / stop
   * @param ticket - 待释放的票据
   */
  private releaseTicket(kind: "start" | "stop", ticket: InFlightTicket): void {
    if (kind === "start") {
      if (this.startInFlight === ticket) {
        this.startInFlight = undefined;
      }
      return;
    }
    if (this.stopInFlight === ticket) {
      this.stopInFlight = undefined;
    }
  }

  /**
   * 启动的执行体 - 钩子编排与状态跃迁
   * 由 runStartLifecycle 收口成在途票据，供 start() 重入复用与 stop() 串行等待；
   * 异常统一转 error 态并原样透出
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
   * 流程：复用同一在途 stop -> idle/stopped 幂等返回 -> 登记在途票据（同步，早于 setState）
   *       -> [starting 态先等在途 start 落地] -> setState(stopping) -> onBeforeStop
   *       -> doStop（子类关服） -> onStopped
   *       -> markStopped -> setState(stopped)
   * 串行化：处于 starting 时先 await 在途 start（吞掉其异常），再走正常停止流程；
   *         stop 期间的重入调用复用同一个完整 promise，绝不因 state=stopping 提前返回。
   * 状态诚实：onStopped 完成前不发布 stopped，钩子失败统一转 error 并透出。
   * @returns 完整停机完成的 promise（票据在 onStopped 之后才 settle）
   * @throws 关服或钩子抛错时透出，状态转为 error
   */
  stop(): Promise<void> {
    // 先看在途票据：runStop 末尾先跃迁 stopped 再 settle，短暂窗口内也必须复用同一 promise。
    const inFlight = this.stopInFlight;
    if (inFlight) {
      // stopping/任何在途清理都复用同一 promise，保持 full stop 的 identity。
      return inFlight.promise;
    }
    if (this._state === "idle" || this._state === "stopped") {
      // 幂等：未启动/已停止直接返回；没有在途资源可等待。
      return Promise.resolve();
    }

    // 同步登记在途票据（无 await）：必须早于 setState("stopping")，
    // 否则 stateChange 监听器同步调用 stop() 会再跑一份 runStop，同步调用 start() 会被误判可启动。
    const ticket = createInFlightTicket();
    this.stopInFlight = ticket;
    void this.runStopLifecycle(ticket);
    return ticket.promise;
  }

  /**
   * 停止生命周期驱动 - 把执行体成败收口到票据
   * 自身永不 reject（同 runStartLifecycle）：失败只经票据传给调用方，
   * 因此重复 stop() / 无人 await 的 stop() 都不会留下 unhandledRejection
   * @param ticket - 已在 setState("stopping") 之前登记的在途票据
   */
  private async runStopLifecycle(ticket: InFlightTicket): Promise<void> {
    try {
      await this.runStop();
      this.releaseTicket("stop", ticket);
      ticket.resolve();
    } catch (error) {
      this.releaseTicket("stop", ticket);
      ticket.reject(error);
    }
  }

  /**
   * 停止的执行体 - 与 start 对称的模板编排
   * 在 stopping 态内等待在途 start，随后执行前置钩子、真实关服与后置清理；
   * 只有 onStopped 完成后才跃迁 stopped。
   * @throws onBeforeStop/doStop/onStopped 抛错时透出，状态转为 error
   */
  private async runStop(): Promise<void> {
    try {
      if (this._state === "starting") {
        // 启动在途：先等 start 落地再停止，避免 stop 抢先返回后 start 又置 running。
        // 票据早于 setState("starting") 登记，这里必然能拿到在途 start。
        const start = this.startInFlight;
        if (start) {
          try {
            await start.promise;
          } catch {
            // 启动失败已转 error 态，继续向下收尾。
          }
        }
      }

      if (!this.isRunning() && this._state !== "running" && this._state !== "error") {
        // 无 server 且非运行态：没有钩子需要执行，直接落到已停止。
        this.setState("stopped");
        return;
      }

      this.setState("stopping");
      await this.onBeforeStop();
      await this.doStop();
      await this.onStopped();
      this.markStopped();
      this.setState("stopped");
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
   * 子类实现：真实关服（close + 成功后置空 server）
   * 在 stopping 态内被 stop() 调用，成功后由基类 markStopped
   * 契约：`closeServer` 兑现（resolve）之后才允许清空 `this.server`；失败必须让异常原样冒出，
   * 保留引用供重试——提前置空会让失败重试把仍在 listening 的 server 洗成 stopped
   * @throws 关服失败时抛错，基类将其转为 error 态
   */
  protected abstract doStop(): Promise<void>;

  /**
   * 关服模板：close 拒绝新连接 + `registry.drain` 排空存量连接
   * @description 主动断开存量 keep-alive/隧道连接，否则 `close` 的回调要等这些连接自然结束才触发；
   * `drain` 收到具备原生 `closeAllConnections()` 的实例（http.Server）走原生优化，
   * 否则（含 net/tls.Server 的 SOCKS 分支）手动逐条销毁——由 `ConnRegistry.drain` 内部分流，
   * 调用方只需透传 server 本身
   *
   * 成败判据（唯一标准是 `close` 回调本身，三条失败路径都 reject，绝不吞错）：
   * - 回调带 error → reject（**原样透出**，含 Node 的 `ERR_SERVER_NOT_RUNNING`）：
   *   关服没兑现就不能让 `stop()` 报成功，否则调用方看到 `stopped` 却端口仍被占。
   * - `close()` 同步抛错 → reject 且**不排空**（close 未生效，动作建立在不确定状态上，交给重试）。
   * - `registry.drain` 同步抛错 → reject（排空没兑现即非成功）。
   * - 回调在 `CLOSE_DEADLINE_MS` 内没来 → 以 `ProxyCloseTimeoutError` reject：
   *   有界失败远好过 `runStop` 永久 pending（外层 grace 到点只会强退，core 连失败事实都报不出来）。
   *   定时器**保持 ref**：deadline 的职责是把挂起转成**可观测的**失败，一旦 unref，
   *   「loop 上再无其它 handle」时进程会静默退出、拒绝根本没人收——那正好毁掉本 deadline
   *   的存在意义。正常路径 resolve 时立刻 clearTimeout，不会拖慢退出。
   * - 仅「回调无 error」才 resolve；resolve 后子类才可清空自己的 server 引用。
   *
   * 已知代价（刻意的诚实性权衡）：Node 只在 handle 已空（从未 listen / 已关闭 / 正在关闭）时给
   * `ERR_SERVER_NOT_RUNNING`，即该错**等价于「已不再 listening」**；因此对这类 server 重试 `stop()`
   * 会再次 reject 而非转 `stopped`。这条路径只在「上一次 stop 已经失败」后才可能到达，调用方按
   * `error` 处理即可（`ProxyServer` 侧也据此丢弃旧 join 票据、重试时重新触发真实 `proxy.stop()`）。
   * @param server - 待关闭的底层服务；null/undefined 直接返回（幂等）
   */
  protected closeServer(
    server:
      | {
          close(cb: (error?: Error) => void): unknown;
          closeAllConnections?(): void;
        }
      | null
      | undefined,
  ): Promise<void> {
    if (!server) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      // 单一收口：settle 只生效一次并顺手清掉 deadline 定时器——迟到的 close 回调与超时
      // 竞争时不会「先 resolve 后 reject」，悬挂定时器也不会拖住正常退出
      let settled = false;
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        finish(() => reject(new ProxyCloseTimeoutError(CLOSE_DEADLINE_MS)));
      }, CLOSE_DEADLINE_MS);
      function finish(apply: () => void): void {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        apply();
      }

      try {
        server.close((error?: Error) => {
          finish(() => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      } catch (e) {
        // close 自身同步抛错（如自定义/伪 server）：转 reject；server 引用由子类保留，
        // 重试会真正重试到同一个实例，而不是对着已被洗掉的 null 引用假成功
        finish(() => reject(e));
        return;
      }
      // close 已拒绝新连接，随后排空存量；drain 若同步抛错就转 reject（排空没兑现即非成功）。
      // 走 finish 同样清掉 deadline 定时器：靠 executor 自然抛出的话，已 reject 的 promise
      // 还会留一个 ref 定时器把事件循环吊住 10s。
      try {
        this.registry.drain(server);
      } catch (e) {
        finish(() => reject(e));
      }
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
   * 统一鉴权入口 - 供所有子类调用
   * 流程：注入 onAuthEvent 转抛
   *       （Auth 审计事件 -> 本实例 "auth" 事件）
   *       -> 调用 auth.authenticate -> 异常视为不通过
   * @param ctx - 本次请求的鉴权上下文
   * @returns 鉴权结果：`{ passed, username }`；异常一律转 `{ passed: false }`
   */
  protected async authorize(ctx: AuthContext): Promise<AuthResult> {
    const prev = ctx.onAuthEvent;
    ctx.onAuthEvent = (e) => {
      try {
        this.emit("auth", e);
      } catch {
        // 忽略 emit 异常，保持鉴权流程
      }
      if (prev) {
        prev(e);
      }
    };

    try {
      return await this.auth.authenticate(ctx);
    } catch {
      return { passed: false };
    } finally {
      ctx.onAuthEvent = prev;
    }
  }
}
