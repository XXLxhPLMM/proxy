import {
  createConfigContext,
  type ConfigAccessor,
  type ConfigContext,
} from "@/config/accessor.js";
import { bindAclFileEvents } from "@/config/acl.js";
import { keysByPhase } from "@/config/fields.js";
import { createJsonFileEventHandler } from "@/config/json-file-log.js";
import { applyPreset } from "@/config/preset.js";
import { ConfigStore } from "@/config/store.js";
import type { AppConfig, ConfigKey } from "@/config/store.js";
import { EventHub } from "@/core/events/index.js";
import { createProxy } from "@/core/server/factory.js";
import type {
  LifecycleState,
  ProxyCore,
  ProxyOptions,
  ProxyProtocol,
  ProxyStats,
} from "@/core/types/proxy.js";
import type { Logger } from "@/utils/logger.js";
import { createNoopLogger } from "@/utils/logger.js";
import type { JsonFileEvent } from "@/utils/json-file.js";
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

function createMemoryContext(store: ConfigStore): ConfigContext {
  return createConfigContext({
    store,
    configDir: process.cwd(),
    startupKeys: keysByPhase().startup,
  });
}

/**
 * 为每个 runtime 派生独立 accessor，并冻结 startup 字段。
 * runtime 字段仍逐次读取同一 store；启动字段改 store 只发布 restart-required，不改变当前监听语义。
 */
function bindRuntimeContext(source: ConfigContext): ConfigContext {
  const startup = new Set<ConfigKey>(source.startupKeys);
  const snapshot = new Map<ConfigKey, unknown>();
  for (const key of source.startupKeys) {
    snapshot.set(key, source.accessor.get(key));
  }
  const accessor: ConfigAccessor = {
    get: <K extends ConfigKey>(key: K): AppConfig[K] =>
      (startup.has(key) ? snapshot.get(key) : source.accessor.get(key)) as AppConfig[K],
  };
  return Object.freeze({ ...source, accessor });
}

function sourceName(context: ConfigContext): string {
  if (context.sources.envFiles.length > 0) {
    return "env-files";
  }
  if (context.sources.envKeys.length > 0) {
    return "environment";
  }
  return "memory";
}

/** 只把 TLS 字段交给真正需要它们的协议。 */
function tlsOptionsFor(protocol: ProxyProtocol, config: ConfigAccessor): TlsKeyCert {
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
  public readonly context: ConfigContext;
  public readonly events: EventHub;
  public readonly logger: Logger;
  public readonly services: RuntimeServices;
  public readonly options: Required<ProxyOptions>;

  private readonly proxy: ProxyCore;
  private readonly bridge: CoreEventBridge;
  private readonly warningHandler: ProxyRuntimeOptions["onWarning"];
  private readonly ownsEvents: boolean;
  private readonly startupKeys: ReadonlySet<ConfigKey>;
  private readonly unsubscribeConfig: () => void;
  private readonly unbindAclFileEvents: () => void;

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
          break;
        case "idle":
          break;
      }
      this.events.publish("lifecycle.changed", { next, prev });
    } catch {
      // 事件观察者不能反向打断 BaseProxy 的状态机。
    }
  };

  public constructor(options: ProxyRuntimeOptions = {}) {
    let baseContext: ConfigContext;
    if (options.context !== undefined) {
      baseContext = options.context;
    } else {
      const initialConfig =
        options.preset === undefined
          ? options.config
          : applyPreset(options.preset, undefined, options.config);
      baseContext = createMemoryContext(new ConfigStore(initialConfig));
    }

    this.context = bindRuntimeContext(baseContext);
    const config = this.context.accessor;
    const startupKeys = [...this.context.startupKeys];
    this.startupKeys = new Set(startupKeys);

    const protocolValue: unknown = config.get("proxyProtocol");
    if (!isProxyProtocol(protocolValue)) {
      throw new Error(`未知代理协议: ${String(protocolValue)}`);
    }
    const protocol = protocolValue;

    this.events = options.events ?? new EventHub({ onListenerError: () => undefined });
    this.ownsEvents = options.events === undefined;
    this.logger = options.logger ?? createNoopLogger();
    this.runtimeId = this.events.runtimeId;
    this.warningHandler = options.onWarning;

    const renderFileEvent = createJsonFileEventHandler(this.logger);
    const onFileEvent = (event: JsonFileEvent): void => {
      renderFileEvent(event);
      if (event.type === "error" || event.type === "missing") {
        this.events.publish("config.file-error", {
          path: event.path,
          error: event.error ?? "文件消失",
        });
      } else if (event.type === "recovered") {
        this.events.publish("config.file-recovered", { path: event.path });
      }
    };
    this.services = buildDefaultServices(config, options.services ?? {}, onFileEvent);
    this.unbindAclFileEvents = bindAclFileEvents(config, onFileEvent);

    this.unsubscribeConfig = this.context.store.onChange((changed) => {
      const restart: ConfigKey[] = [];
      const hot: ConfigKey[] = [];
      for (const key of changed) {
        (this.startupKeys.has(key) ? restart : hot).push(key);
      }
      if (hot.length > 0) {
        this.events.publish("config.changed", { keys: hot });
      }
      if (restart.length > 0) {
        this.events.publish("config.restart-required", { keys: restart });
      }
    });

    const normalizedOptions: Required<ProxyOptions> = {
      host: config.get("host"),
      port: config.get("port"),
      upstreamTimeout: config.get("upstreamTimeout"),
      tls: tlsOptionsFor(protocol, config),
      auth: this.services.auth,
      isWorker: false,
      config,
      logger: this.logger,
    };

    this.proxy = createProxy(protocol, normalizedOptions);
    this.options = this.proxy.options;

    const statefulProxy = this.proxy as unknown as StatefulProxy;
    statefulProxy.on("stateChange", this.onStateChange);

    this.bridge = new CoreEventBridge({ hub: this.events, protocol });
    this.bridge.attach(this.proxy as unknown as NodeEventEmitterWithProxyEvents);
  }

  public async start(): Promise<void> {
    try {
      this.events.publish("config.loaded", { source: sourceName(this.context) });
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
      this.bridge.subscription.dispose();
      this.unsubscribeConfig();
      this.unbindAclFileEvents();
      if (this.ownsEvents) {
        this.events.removeAll();
      }
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

/** 创建一个零 import 副作用的代理库运行时。 */
export function createProxyRuntime(options: ProxyRuntimeOptions = {}): ProxyRuntime {
  return new ProxyRuntimeImpl(options);
}
