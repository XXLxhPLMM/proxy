import { ConfigStore, defaults } from "@/config/store.js";
import { applyPreset } from "@/config/preset.js";
import { configAccessorFromStore } from "@/core/config-access.js";
import { EventHub } from "@/core/events/index.js";
import { createProxy } from "@/core/server/factory.js";
import type { ConfigAccessor } from "@/core/config-access.js";
import type {
  LifecycleState,
  ProxyCore,
  ProxyOptions,
  ProxyProtocol,
  ProxyStats,
} from "@/core/types/proxy.js";
import type { Logger } from "@/utils/logger.js";
import { createNoopLogger } from "@/utils/logger.js";
import type { TlsKeyCert } from "@/utils/cert.js";
import { CoreEventBridge } from "./bridge.js";
import type { NodeEventEmitterWithProxyEvents } from "./bridge.js";
import { buildDefaultServices } from "./services.js";
import type {
  ProxyRuntime,
  ProxyRuntimeOptions,
  RuntimeServices,
  RuntimeWarning,
} from "./types.js";

const PROXY_PROTOCOLS: readonly ProxyProtocol[] = [
  "http",
  "https",
  "socks4",
  "socks5",
  "sockss4",
  "sockss5",
];

/** BaseProxy 的公开接口不暴露 EventEmitter；runtime 只依赖这一条状态事件。 */
interface StatefulProxy extends ProxyCore {
  on(event: "stateChange", listener: (next: LifecycleState, prev: LifecycleState) => void): unknown;
}

function isProxyProtocol(value: unknown): value is ProxyProtocol {
  return typeof value === "string" && PROXY_PROTOCOLS.includes(value as ProxyProtocol);
}

/**
 * 只把 TLS 字段交给真正需要它们的协议。
 *
 * 明文 HTTP/SOCKS 的证书路径即使配置了也不会被读取；TLS 协议把路径快照传给
 * core，真正的文件读取仍由协议实现的启动钩子惰性完成。
 */
function tlsOptionsFor(protocol: ProxyProtocol, config: ConfigStore): TlsKeyCert {
  if (protocol !== "https" && protocol !== "sockss4" && protocol !== "sockss5") {
    return {};
  }
  return {
    key: config.get("tlsKey"),
    cert: config.get("tlsCert"),
    ca: config.get("tlsCa"),
    passphrase: config.get("tlsPassphrase"),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ProxyRuntimeImpl implements ProxyRuntime {
  public readonly runtimeId: string;
  public readonly config: ConfigStore;
  public readonly configAccessor: ConfigAccessor;
  public readonly events: EventHub;
  public readonly logger: Logger;
  public readonly services: RuntimeServices;
  public readonly options: Required<ProxyOptions>;

  private readonly proxy: ProxyCore;
  /**
   * core 事件 → 公共事件的桥接器。
   *
   * @description 内部机制，**不暴露到 `ProxyRuntime` 公共接口**：库用户只通过 `runtime.events`
   * 观察请求事实，不该操心 core 事件的形状。停机时随 stop() 一并解绑。
   */
  private readonly bridge: CoreEventBridge;
  private readonly warningHandler: ProxyRuntimeOptions["onWarning"];

  private readonly onStateChange = (next: LifecycleState, prev: LifecycleState): void => {
    try {
      switch (next) {
        case "starting":
          this.events.publish("runtime.starting", this.endpoint());
          break;
        case "running":
          this.events.publish("runtime.started", this.endpoint());
          break;
        case "stopping":
          this.events.publish("runtime.stopping", undefined);
          break;
        case "stopped":
          this.events.publish("runtime.stopped", undefined);
          break;
        case "error":
          // 具体错误由 start/stop 的 catch 发布；这里只报告状态跃迁，避免伪造错误对象。
          break;
        case "idle":
          break;
      }
      this.events.publish("lifecycle.changed", { next, prev });
    } catch {
      // 事件观察者不能反向打断 BaseProxy 的状态机；EventHub 自身也会隔离 listener 异常。
    }
  };

  public constructor(options: ProxyRuntimeOptions = {}) {
    // preset、调用方配置与 defaults 都只在内存中合并，绝不触发 loader 或任何 IO。
    const initialConfig =
      options.preset === undefined
        ? options.config
        : applyPreset(options.preset, undefined, options.config);
    this.config = new ConfigStore({ ...defaults, ...(initialConfig ?? {}) });
    this.configAccessor = configAccessorFromStore(this.config);

    const protocolValue: unknown = this.config.get("proxyProtocol");
    if (!isProxyProtocol(protocolValue)) {
      throw new Error(`未知代理协议: ${String(protocolValue)}`);
    }
    const protocol = protocolValue;

    this.services = buildDefaultServices(this.configAccessor, options.services ?? {});
    this.events = options.events ?? new EventHub({ onListenerError: () => undefined });
    this.logger = options.logger ?? createNoopLogger();
    this.runtimeId = this.events.runtimeId;
    this.warningHandler = options.onWarning;

    const normalizedOptions: Required<ProxyOptions> = {
      host: this.config.get("host"),
      port: this.config.get("port"),
      upstreamTimeout: this.config.get("upstreamTimeout"),
      tls: tlsOptionsFor(protocol, this.config),
      auth: this.services.auth,
      isWorker: false,
      config: this.configAccessor,
    };

    this.proxy = createProxy(protocol, normalizedOptions);
    this.options = this.proxy.options;

    const statefulProxy = this.proxy as unknown as StatefulProxy;
    statefulProxy.on("stateChange", this.onStateChange);

    // core 的 auth/pipe 事实桥进公共 EventHub（库事件面）；`bindProxyEventLogs` 那条是 CLI 日志面，互不 import。
    this.bridge = new CoreEventBridge({ hub: this.events, protocol });
    this.bridge.attach(this.proxy as unknown as NodeEventEmitterWithProxyEvents);
  }

  public async start(): Promise<void> {
    try {
      await this.proxy.start();
    } catch (error) {
      this.publishRuntimeError(error);
      this.publishStartupWarning(error);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    try {
      await this.proxy.stop();
    } catch (error) {
      this.publishRuntimeError(error);
      throw error;
    } finally {
      // 先解绑 core 监听（桥接器不再是 core 的观察者），再清 EventHub 订阅：
      // 顺序反了会在「已清 hub、仍挂 core 监听」的窗口里把事件发到空总线。
      this.bridge.subscription.dispose();
      // EventHub 是 runtime 的观察面；停止后释放全部订阅，避免宿主复用 runtime 时悬挂观察者。
      this.events.removeAll();
    }
  }

  public isRunning(): boolean {
    return this.proxy.isRunning();
  }

  public getStats(): ProxyStats {
    return this.proxy.getStats();
  }

  public getProxy(): ProxyCore {
    return this.proxy;
  }

  private endpoint(): { host: string; port: number; protocol: ProxyProtocol } {
    const options = this.proxy.options;
    return { host: options.host, port: options.port, protocol: this.proxy.protocol };
  }

  private publishRuntimeError(error: unknown): void {
    try {
      this.events.publish("runtime.error", { error });
    } catch {
      // 观察者异常不能改变原始 start/stop 错误。
    }
  }

  private publishStartupWarning(error: unknown): void {
    if (!this.warningHandler) {
      return;
    }
    const warning: RuntimeWarning = {
      code: "start-failed",
      message: errorMessage(error),
    };
    try {
      this.warningHandler(warning);
    } catch {
      // 告警回调是旁路，不应替换启动错误或阻断 stop 清理。
    }
  }
}

/**
 * 创建一个零副作用的代理库运行时。
 *
 * 构造阶段只建立私有配置、服务、事件观察面和未监听的协议核心；真正的 server
 * 监听、连接排空和状态机仍完全委托给 BaseProxy 及其协议实现。
 */
export function createProxyRuntime(options: ProxyRuntimeOptions = {}): ProxyRuntime {
  return new ProxyRuntimeImpl(options);
}
