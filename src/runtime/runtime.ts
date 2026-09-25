import path from "node:path";
import {
  ConfigStore,
  applyPreset,
  createConfigContext,
  createJsonFileEventHandler,
  prepareRuntimeConfigStore,
  type AppConfig,
  type ConfigAccessor,
  type ConfigContext,
  type ConfigKey,
} from "@/config/index.js";
import { bindAclFileEvents } from "@/core/access-control.js";
import { EventHub } from "@/core/events/index.js";
import { createProxy } from "@/core/server/factory.js";
import type {
  LifecycleState,
  ProxyCore,
  ProxyOptions,
  ProxyProtocol,
  ProxyStats,
} from "@/core/types/proxy.js";
import type { Logger } from "@/utils/logger/index.js";
import { createNoopLogger } from "@/utils/logger/index.js";
import type { JsonFileEvent } from "@/utils/json-file/index.js";
import type { TlsKeyCert } from "@/utils/tls/index.js";
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
 * 为每个 runtime 派生独立 accessor，并冻结 startup 字段。
 * runtime 字段仍逐次读取同一 store；启动字段改 store 只发布 restart-required，不改变当前监听语义。
 */
function bindRuntimeContext(source: ConfigContext): ConfigContext {
  const startup = new Set<ConfigKey>(source.startupKeys);
  const snapshot = new Map<ConfigKey, unknown>();
  for (const key of source.startupKeys) {
    snapshot.set(key, source.accessor.get(key));
  }
  const accessor: ConfigAccessor = Object.freeze({
    get: <K extends ConfigKey>(key: K): AppConfig[K] =>
      (startup.has(key) ? snapshot.get(key) : source.accessor.get(key)) as AppConfig[K],
  });
  return Object.freeze({ ...source, accessor });
}

/** 配置来源只报告最高优先级的一类，混合来源不重复列出。 */
function sourceName(context: ConfigContext): string {
  if (context.sources.argvKeys.length > 0) {
    return "argv";
  }
  if (context.sources.envKeys.length > 0) {
    return "environment";
  }
  if (context.sources.envFiles.length > 0) {
    return "env-files";
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
  public readonly services: Readonly<RuntimeServices>;
  public readonly options: Readonly<Required<ProxyOptions>>;

  private readonly proxy: ProxyCore;
  private readonly warningHandler: ((warning: RuntimeWarning) => void) | undefined;
  private readonly ownsEvents: boolean;
  private readonly startupKeys: ReadonlySet<ConfigKey>;
  private readonly fileEventHandler: (event: JsonFileEvent) => void;

  /** 这些订阅只在本 runtime 的 active 轮次存在；stop 后必须清空，下一轮重新创建。 */
  private bridge: CoreEventBridge | undefined;
  private unsubscribeConfig: (() => void) | undefined;
  private unbindAclFileEvents: (() => void) | undefined;
  private subscriptionsActive = false;

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
    let normalizationWarnings: readonly string[];

    if (options.context !== undefined) {
      // context 模式必须复用同一 live store；重建 runtime 时重新应用热改后的启动 URL，
      // 但保留加载器已经记录的来源、startupKeys 与旧 warnings。
      const prepared = prepareRuntimeConfigStore(options.context.store, options.context.configDir);
      normalizationWarnings = prepared.warnings;
      baseContext = createConfigContext({
        store: options.context.store,
        configDir: options.context.configDir,
        sources: options.context.sources,
        warnings: [...options.context.warnings, ...prepared.warnings],
      });
    } else {
      const initialConfig =
        options.preset === undefined
          ? options.config
          : applyPreset(options.preset, undefined, options.config);
      // 纯内存模式没有可回查的宿主来源；只在构造瞬间捕获一次 cwd，之后 chdir 不影响路径。
      const configDir = path.resolve(options.configDir ?? process.cwd());
      const store = new ConfigStore(initialConfig);
      const prepared = prepareRuntimeConfigStore(
        store,
        configDir,
        Object.keys(initialConfig ?? {}),
      );
      normalizationWarnings = prepared.warnings;
      baseContext = createConfigContext({
        store,
        configDir,
        warnings: prepared.warnings,
      });
    }

    this.context = bindRuntimeContext(baseContext);
    const config = this.context.accessor;
    const startupKeys = [...this.context.startupKeys];
    this.startupKeys = new Set(startupKeys);

    this.events = options.events ?? new EventHub({ onListenerError: () => undefined });
    this.ownsEvents = options.events === undefined;
    this.logger = options.logger ?? createNoopLogger();
    this.runtimeId = this.events.runtimeId;
    this.warningHandler = options.onWarning;

    const renderFileEvent = createJsonFileEventHandler(this.logger);
    this.fileEventHandler = (event: JsonFileEvent): void => {
      renderFileEvent(event);
      if (event.type === "error" || event.type === "missing") {
        this.events.publish("config.file-error", {
          path: event.path,
          error: event.error ?? "文件消失",
        });
      } else if (event.type === "recovered") {
        this.events.publish("config.file-recovered", { path: event.path });
      } else if (event.type === "reloaded") {
        this.events.publish("config.file-reloaded", { path: event.path });
      }
    };

    this.services = buildDefaultServices(config, options.services ?? {}, this.fileEventHandler);

    const protocol = protocolFor(config);
    const normalizedOptions: ProxyOptions = {
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

    // stateChange 是 core 生命周期本身的观察面，不随事件 bridge 的每轮重建而丢失。
    const statefulProxy = this.proxy as unknown as StatefulProxy;
    statefulProxy.on("stateChange", this.onStateChange);

    // 只报告本次归一化新产生的 warning；context.warnings 中的 loadConfig warning 不重复旁路发送。
    this.reportNormalizationWarnings(normalizationWarnings);
  }

  public async start(): Promise<void> {
    try {
      this.activateSubscriptions();
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
      this.releaseSubscriptions();
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

  /** 每一轮 start 建立一组新的 core/store/ACL 订阅；重复 start 不叠加。 */
  private activateSubscriptions(): void {
    if (this.subscriptionsActive) {
      return;
    }

    const bridge = new CoreEventBridge({ hub: this.events, protocol: this.proxy.protocol });
    let unsubscribeConfig: (() => void) | undefined;
    let unbindAclFileEvents: (() => void) | undefined;
    try {
      bridge.attach(this.proxy as unknown as NodeEventEmitterWithProxyEvents);
      unsubscribeConfig = this.context.store.onChange((changed) => {
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
      unbindAclFileEvents = bindAclFileEvents(this.context.accessor, this.fileEventHandler);
      this.bridge = bridge;
      this.unsubscribeConfig = unsubscribeConfig;
      this.unbindAclFileEvents = unbindAclFileEvents;
      this.subscriptionsActive = true;
    } catch (error) {
      // 正常装配路径不抛错；若第三方 hook 在中途失败，仍不留下半轮订阅。
      bridge.subscription.dispose();
      try {
        unsubscribeConfig?.();
      } catch {
        // 清理失败不能遮蔽原始装配错误。
      }
      try {
        unbindAclFileEvents?.();
      } catch {
        // 同上。
      }
      this.bridge = undefined;
      this.unsubscribeConfig = undefined;
      this.unbindAclFileEvents = undefined;
      this.subscriptionsActive = false;
      throw error;
    }
  }

  /** 释放本轮 runtime 自己的订阅；外部 EventHub 与旧 bridge 都不在这里处理。 */
  private releaseSubscriptions(): void {
    const bridge = this.bridge;
    const unsubscribeConfig = this.unsubscribeConfig;
    const unbindAclFileEvents = this.unbindAclFileEvents;
    this.bridge = undefined;
    this.unsubscribeConfig = undefined;
    this.unbindAclFileEvents = undefined;
    this.subscriptionsActive = false;

    try {
      bridge?.subscription.dispose();
    } catch {
      // 退订失败不应阻断 stop 或其它清理。
    }
    try {
      unsubscribeConfig?.();
    } catch {
      // 同上。
    }
    try {
      unbindAclFileEvents?.();
    } catch {
      // 同上。
    }
  }

  private reportNormalizationWarnings(warnings: readonly string[]): void {
    if (this.warningHandler === undefined) {
      return;
    }
    for (const message of warnings) {
      try {
        this.warningHandler({ code: "config-normalized", message });
      } catch {
        // warning 回调是旁路，不应让 runtime 构造失败。
      }
    }
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

function protocolFor(config: ConfigAccessor): ProxyProtocol {
  const value: unknown = config.get("proxyProtocol");
  if (!isProxyProtocol(value)) {
    throw new Error(`未知代理协议: ${String(value)}`);
  }
  return value;
}

/** 创建一个零 import 副作用的代理库运行时。 */
export function createProxyRuntime(options: ProxyRuntimeOptions = {}): ProxyRuntime {
  return new ProxyRuntimeImpl(options);
}
