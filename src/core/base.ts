/**
 * 代理基类 - 统一生命周期与状态管理
 * 职责：
 * - 归一化 ProxyOptions（port/host 兜底）
 * - 维护 startedAt 时间戳与运行态统计
 * - 约束子类必须实现 start/stop/isRunning，复用 getStats
 * 设计：
 * - 不持有任何 server 实例：裸 server 由 DirectServerProxy 持有，包装类（如 HttpServer）由子类自行管理
 * - 仅提供 markStarted/markStopped 供子类在 listen/close 成功回调中调用
 */

import { EventEmitter } from "node:events";
import type http from "node:http";
import net from "node:net";
import type tls from "node:tls";
import type { Duplex } from "node:stream";
import type { LifecycleState, ProxyOptions, ProxyProtocol, ProxyStats } from "./types.js";
import type { AuthContext, AuthProvider } from "./auth.js";
import { Auth } from "./auth.js";
import { getLogger } from "@/utils/logger.js";
import { HTTP_400_BAD_REQUEST } from "@/utils/constants.js";
import { logBadRequest } from "@/server/log/events-log.js";

/**
 * 代理基类 - 统一生命周期状态机与钩子编排
 * 状态流转：idle -> starting -> running -> stopping -> stopped（可重入 starting）
 * 异常分支：任意环节抛错 -> error，需外部重试或重启
 * 事件：stateChange(state, prev) 供上层观测
 */
export abstract class BaseProxy extends EventEmitter {
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

  /** 当前生命周期状态，初始 idle */
  private _state: LifecycleState = "idle";

  /** 只读状态暴露 */
  get state(): LifecycleState {
    return this._state;
  }

  /**
   * 构造基类
   * @param protocol - 协议标识，决定 getStats 展示与工厂注册 key
   * @param options - 外部注入的端口与地址，未传则使用 3000 / 0.0.0.0，auth 未传则默认放行
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

  /** 内部状态跃迁并发出事件 */
  protected setState(next: LifecycleState): void {
    const prev = this._state;
    if (prev === next) return;
    this._state = next;
    this.emit("stateChange", next, prev);
  }

  // ── 生命周期钩子（子类可选覆盖） ──
  /** start 前：校验配置/加载证书 */
  async onBeforeStart(): Promise<void> {}
  /** start 后：注册探针/日志 */
  async onStarted(): Promise<void> {}
  /** stop 前：优雅排空 */
  async onBeforeStop(): Promise<void> {}
  /** stop 后：清理资源 */
  async onStopped(): Promise<void> {}

  /**
   * 启动代理服务 - 模板方法：编排状态机 + 钩子
   * 子类仅需实现 doStart/doStop 真实建服逻辑
   */
  async start(): Promise<void> {
    if (this._state === "running" || this._state === "starting") return; // 幂等：已在运行/启动中直接返回
    if (this.isRunning()) {
      this.setState("running"); // server 已 listening 但状态未同步时校正
      return;
    }
    this.setState("starting"); // 进入启动态
    try {
      await this.onBeforeStart(); // 前置钩子：如加载证书/校验配置
      await this.doStart(); // 子类建服
      this.markStarted(); // 记录 startedAt
      this.setState("running"); // 标记运行
      await this.onStarted(); // 后置钩子：日志/探针
    } catch (e) {
      this.setState("error"); // 异常转 error 态
      throw e;
    }
  }

  /**
   * 停止代理服务 - 模板方法
   */
  async stop(): Promise<void> {
    if (this._state === "idle" || this._state === "stopped" || this._state === "stopping") return; // 幂等：未启动/已停止直接返回
    if (!this.isRunning() && this._state !== "running" && this._state !== "error") {
      this.setState("stopped"); // 无 server 且非运行态，直接标记停止
      return;
    }
    this.setState("stopping"); // 进入停止态
    try {
      await this.onBeforeStop(); // 前置：优雅排空拒绝新连接
      await this.doStop(); // 子类关服
      this.markStopped(); // 清空 startedAt
      this.setState("stopped");
      await this.onStopped(); // 后置：清理资源
    } catch (e) {
      this.setState("error");
      throw e;
    }
  }

  /** 子类实现：真实建服 */
  protected abstract doStart(): Promise<void>;
  /** 子类实现：真实关服 */
  protected abstract doStop(): Promise<void>;

  /**
   * 是否处于监听态
   * 子类通常以 server?.listening 判断
   */
  abstract isRunning(): boolean;

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
   * 流程：注入 onAuthEvent 转抛（Auth 审计事件 -> 本实例 "auth" 事件）-> 调用 auth.authenticate -> 异常视为不通过
   * @param ctx - 本次请求的鉴权上下文
   * @returns 是否通过
   */
  protected async authorize(ctx: AuthContext): Promise<boolean> {
    const prev = ctx.onAuthEvent;
    ctx.onAuthEvent = (e) => {
      try {
        this.emit("auth", e);
      } catch {}
      prev?.(e);
    };
    try {
      return !!(await this.auth.authenticate(ctx));
    } catch {
      return false;
    } finally {
      ctx.onAuthEvent = prev;
    }
  }
}

/**
 * 直连 server 代理基类 - 持有裸 server 实例的子类用它（tls/socks）
 * 与 BaseProxy 的分工：
 * - BaseProxy：纯生命周期状态机 + 鉴权，不碰任何 server
 * - DirectServerProxy：再加裸 server 持有 + listen/close/错误挂载（stopServer/startListening/attachErrorHandlers）
 * - HttpProxy 一系：生命周期由 HttpServer/HttpsServer 包装类管理（start/close/started），
 *   包装类不是 http.Server，硬塞进 server 字段只能靠 cast 撒谎，所以它们不继承这一层
 */
export abstract class DirectServerProxy extends BaseProxy {
  /** 底层 server 实例，未启动时为 null */
  protected server: http.Server | tls.Server | net.Server | null = null;

  /**
   * 启动 server 监听 - 统一 listen Promise 包装，消除子类重复
   * @param server - 需要 listen 的 server（http.Server / tls.Server / net.Server）
   * @param port - 监听端口
   * @param host - 监听地址
   */
  protected async startListening(
    server: { listen: (port: number, host: string, cb: () => void) => net.Server; off: (event: string, listener: (...args: unknown[]) => void) => void; once: (event: string, listener: (err: Error) => void) => void },
    port: number,
    host: string,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  }

  /**
   * 挂载 server 运行期错误处理器 - 日志输出，不抛至进程
   * @param server - 需要挂载处理器的 server
   * @param clientErrorEvent - 客户端错误事件名，http 为 "clientError"，tls/socks 为 "tlsClientError"
   */
  protected attachErrorHandlers(
    server: { on: (event: string, listener: (...args: unknown[]) => void) => void },
    clientErrorEvent: string = "clientError",
  ): void {
    server.on("error", (...args: unknown[]) => {
      const err = args[0] as Error;
      this.setState("error");
      this.log.error(`server error (${this.options.host}:${this.options.port}):`, err);
    });
    server.on(clientErrorEvent, (...args: unknown[]) => {
      const err = args[0] as Error;
      const socket = args[1] as Duplex;
      logBadRequest(this.log, `${clientErrorEvent}: ${err.message}`);
      try {
        socket.end(HTTP_400_BAD_REQUEST);
      } catch {}
    });
  }

  /**
   * 优雅关闭 server - 统一 close Promise 包装
   */
  protected async stopServer(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => (this.server as { close: (cb: () => void) => void }).close(() => resolve()));
    this.server = null;
  }
}
