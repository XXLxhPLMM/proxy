/**
 * 代理基类 - 统一生命周期与状态管理
 * 职责：
 * - 归一化 ProxyOptions（port/host 兜底）
 * - 维护 startedAt 时间戳与运行态统计
 * - 提供 doStart/doStop 钩子约束与默认 isRunning（server.listening），复用 getStats
 * 设计：
 * - 仅持弱类型 server 引用（只读 listening 判运行态）与共享 ConnRegistry：建服/排空细节归子类
 * - 仅提供 markStarted/markStopped 供子类在 listen/close 成功回调中调用
 */

import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import type {
  LifecycleState,
  ProxyEventMap,
  ProxyOptions,
  ProxyProtocol,
  ProxyStats,
} from "../types/proxy.js";
import type { AuthContext, AuthProvider, AuthResult } from "../types/auth.js";
import { Auth } from "../auth.js";
import { globalConfigAccessor } from "../config-access.js";
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
 * 代理基类 - 统一生命周期状态机与钩子编排
 * 状态流转：idle -> starting -> running -> stopping -> stopped
 *          （可重入 starting）
 * 异常分支：任意环节抛错 -> error，需外部重试或重启
 * 事件：ProxyEventMap 全量类型化
 *       （stateChange/forward/auth/pipe/...），
 *       emit/on 两头编译期检查，事件契约见 types/proxy.ts
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
   * @param options - 外部注入的端口与地址，未传则使用 3000 / 0.0.0.0，
   *                  auth 未传则默认放行；config 未传则落到全局单例访问器
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
      // 缺省全局单例：归一化后 options.config 恒非空，子类可无条件透传给转发器/鉴权
      config: options.config ?? globalConfigAccessor,
    } as Required<ProxyOptions>;
    this.auth = this.options.auth;
  }

  /**
   * 内部状态跃迁并发出事件
   * 相同状态直接跳过，避免重复触发 stateChange
   * @param next - 目标生命周期状态
   */
  protected setState(next: LifecycleState): void {
    const prev = this._state;
    if (prev === next) {
      return;
    }
    this._state = next;
    this.emit("stateChange", next, prev);
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
   * `drain` 收到具备原生 `closeAllConnections()` 的实例（http.Server）走原生优化，
   * 否则（含 net/tls.Server 的 SOCKS 分支）手动逐条销毁——由 `ConnRegistry.drain` 内部分流，
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
