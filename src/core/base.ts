/**
 * 代理基类 - 统一生命周期与状态管理
 * 职责：
 * - 归一化 ProxyOptions（port/host 兜底）
 * - 维护 startedAt 时间戳与运行态统计
 * - 约束子类必须实现 start/stop/isRunning，复用 getStats
 * 设计：
 * - 不持有任何 server 实例，由子类自行管理 http.Server / net.Server / tls.Server
 * - 仅提供 markStarted/markStopped 供子类在 listen/close 成功回调中调用
 */

import type { ProxyOptions, ProxyProtocol, ProxyStats } from "./types.js";
import type { AuthContext, AuthProvider } from "./auth.js";
import { Auth } from "./auth.js";

export abstract class BaseProxy {
  /** 协议标识，由子类通过 super(protocol) 传入 */
  readonly protocol: ProxyProtocol;

  /** 归一化后的选项，保证 port/host 必有值，避免子类重复判空 */
  readonly options: Required<ProxyOptions>;

  /** 鉴权提供者，默认 AllowAll，子类通过 authorize() 统一调用 */
  protected readonly auth: AuthProvider;

  /** 最近一次启动成功的时间戳，未启动或已停止为 undefined */
  protected startedAt?: number;

  /**
   * 构造基类
   * @param protocol - 协议标识，决定 getStats 展示与工厂注册 key
   * @param options - 外部注入的端口与地址，未传则使用 3000 / 0.0.0.0，auth 未传则默认放行
   */
  constructor(protocol: ProxyProtocol, options: ProxyOptions = {}) {
    this.protocol = protocol;
    this.options = {
      port: options.port ?? 3000,
      host: options.host ?? "0.0.0.0",
      auth: options.auth ?? new Auth({ enabled: false }),
    } as Required<ProxyOptions>;
    this.auth = this.options.auth;
  }

  /**
   * 启动代理服务
   * 要求：幂等实现，重复调用不得抛错或重复监听
   */
  abstract start(): Promise<void>;

  /**
   * 停止代理服务
   * 要求：幂等实现，关闭后 markStopped，释放端口
   */
  abstract stop(): Promise<void>;

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
   * 流程：构造 AuthContext -> 调用 auth.authenticate -> 异常视为不通过
   * @param ctx - 本次请求的鉴权上下文
   * @returns 是否通过
   */
  protected async authorize(ctx: AuthContext): Promise<boolean> {
    try {
      return !!(await this.auth.authenticate(ctx));
    } catch {
      return false;
    }
  }
}
