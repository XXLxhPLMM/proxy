import type { AppConfig, ConfigStore } from "@/config/store.js";
import type { ConfigAccessor } from "@/core/config-access.js";
import type { EventHub } from "@/core/events/index.js";
import type { AuthProvider, ProxyCore, ProxyOptions, ProxyStats } from "@/core/types/proxy.js";
import type { Logger } from "@/utils/logger.js";

/** 库用户可覆盖的运行时服务（逐步扩展：access / routing / forwarding / errors）。 */
export interface RuntimeServices {
  auth: AuthProvider;
}

/** 创建库运行时所需的显式选项。 */
export interface ProxyRuntimeOptions {
  /**
   * 库模式显式配置。
   * - **绝不读 env / argv / .env / 文件**：没传的键一律用 defaults
   * - 传入的值覆盖 defaults；不传则全默认
   */
  config?: Partial<AppConfig>;
  /** 按名应用一个已注册 preset（与 config 合并，config 覆盖 preset）。不传则不用 preset。 */
  preset?: string;
  /** 依赖注入：覆盖任意服务；不传则用默认实现。 */
  services?: Partial<RuntimeServices>;
  /** 外部事件总线；不传则 runtime 自建一个（每 runtime 独立）。 */
  events?: EventHub;
  /** 日志端口；不传则 createNoopLogger()（零副作用、零落盘）。 */
  logger?: Logger;
  /** 启动期告警回调（如 mTLS 配了但证书读不到），库模式不打印只回调。 */
  onWarning?: (w: RuntimeWarning) => void;
}

/** 启动期非控制流告警。 */
export interface RuntimeWarning {
  code: string;
  message: string;
}

/** 库运行时的公开门面。 */
export interface ProxyRuntime {
  readonly runtimeId: string;
  /** 本 runtime 私有配置实例，与其它 runtime、全局单例互不影响。 */
  readonly config: ConfigStore;
  /** 配置访问器（core 内部读配置的入口）。 */
  readonly configAccessor: ConfigAccessor;
  readonly events: EventHub;
  readonly logger: Logger;
  readonly services: RuntimeServices;
  readonly options: Required<ProxyOptions>;
  /** 幂等。 */
  start(): Promise<void>;
  /** 幂等；排空连接 + 释放事件订阅，绝不退出宿主进程。 */
  stop(): Promise<void>;
  isRunning(): boolean;
  getStats(): ProxyStats;
  /** 已构建的协议核心；start 前后都可取（供高级用户订阅内部事件）。 */
  getProxy(): ProxyCore;
}
