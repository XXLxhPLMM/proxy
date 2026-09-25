import type { ConfigContext } from "@/config/index.js";
import type { AppConfig } from "@/config/index.js";
import type { EventHub } from "@/core/events/index.js";
import type { AuthProvider, ProxyCore, ProxyOptions, ProxyStats } from "@/core/types/proxy.js";
import type { Logger } from "@/utils/logger/index.js";

/** 库用户可覆盖的运行时服务（逐步扩展：access / routing / forwarding / errors）。 */
export interface RuntimeServices {
  readonly auth: AuthProvider;
}

interface ProxyRuntimeCommonOptions {
  /** 依赖注入：覆盖任意服务；不传则用当前 context 的默认实现。 */
  services?: Partial<RuntimeServices>;
  /** 外部事件总线；不传则 runtime 自建一个（每 runtime 独立）。 */
  events?: EventHub;
  /** 日志端口；不传则 createNoopLogger()（零副作用、零落盘）。 */
  logger?: Logger;
  /** 启动期告警回调（如 mTLS 配了但证书读不到），库模式不打印只回调。 */
  onWarning?: (w: RuntimeWarning) => void;
}

/**
 * runtime 构造来源二选一：
 * - `context`：直接复用 `await loadConfig()` 返回的 live store/accessor；
 * - `config`/`preset`：纯内存模式，runtime 内部新建私有 ConfigStore，不读任何来源；
 *   可传 `configDir` 作为所有相对路径的锚点（省略时仅捕获构造瞬间的 cwd）。
 */
export type ProxyRuntimeOptions = ProxyRuntimeCommonOptions &
  (
    | { context: ConfigContext; config?: never; preset?: never; configDir?: never }
    | { context?: never; config?: Partial<AppConfig>; preset?: string; configDir?: string }
  );

/** 启动期非控制流告警。 */
export interface RuntimeWarning {
  code: string;
  message: string;
}

/** 库运行时的公开门面。 */
export interface ProxyRuntime {
  readonly runtimeId: string;
  /** 本 runtime 的配置上下文；context 模式与调用方共享 store，纯内存模式由 runtime 自建。 */
  readonly context: ConfigContext;
  readonly events: EventHub;
  readonly logger: Logger;
  readonly services: Readonly<RuntimeServices>;
  readonly options: Readonly<Required<ProxyOptions>>;
  /** 幂等。 */
  start(): Promise<void>;
  /** 幂等；排空连接 + 释放事件订阅，绝不退出宿主进程。 */
  stop(): Promise<void>;
  isRunning(): boolean;
  getStats(): ProxyStats;
  /** 已构建的协议核心；start 前后都可取（供高级用户订阅内部事件）。 */
  getProxy(): ProxyCore;
}
