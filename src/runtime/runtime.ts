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
import { QUOTA_INERT_DETAIL } from "@/core/log-events.js";
import { EventHub, type EventListener, type EventSubscription } from "@/core/events/index.js";
import { createProxy } from "@/core/server/factory.js";
import type {
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
import { RuntimeContext } from "./context.js";
import { buildDefaultServices, hasConfiguredQuota } from "./services.js";
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

  /** 传给 core 的依赖上下文持有者（`CoreContext` 的可变实现）。 */
  private readonly dependencies: RuntimeContext;

  private readonly proxy: ProxyCore;
  private readonly warningHandler: ((warning: RuntimeWarning) => void) | undefined;
  private readonly ownsEvents: boolean;
  private readonly startupKeys: ReadonlySet<ConfigKey>;
  private readonly fileEventHandler: (event: JsonFileEvent) => void;

  /** 这些订阅只在本 runtime 的 active 轮次存在；stop 后必须清空，下一轮重新创建。 */
  private bridge: CoreEventBridge | undefined;
  private unsubscribeConfig: (() => void) | undefined;
  private unbindAclFileEvents: (() => void) | undefined;
  private lifecycleSubscription: EventSubscription | undefined;
  private subscriptionsActive = false;

  /**
   * `lifecycle.changed` 的观察者：core 每次状态跃迁直接发这条公共事实，本 runtime 只把
   * `starting/running/stopping/stopped` 翻译成对应的 `runtime.*`。
   *
   * @description **刻意不再发 `lifecycle.changed`**：core 已经是这条事实的唯一来源，
   * 这里再发一遍就是「一条事实两个来源」。故 `next`/`prev` 从信封读、事件本身原样透出。
   * 整体 try/catch：观察者不能反向打断 `BaseProxy` 的状态机。
   */
  private readonly onLifecycleChanged: EventListener<"lifecycle.changed"> = (e) => {
    try {
      switch (e.data.next) {
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
    this.dependencies = new RuntimeContext({
      config: this.context.accessor,
      logger: this.logger,
      events: this.events,
    });
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

    this.services = buildDefaultServices(config, options.services ?? {}, this.fileEventHandler, {
      // 槽位号：**只**来自 CLI 的 env 快照（`PROXY_WORKER_SLOT` → runServer → ProxyServer
      // → 本选项）。runtime 自己绝不读 `process.env`：槽位会拼进账本文件名。
      slot: options.trafficWorkerSlot,
      onLedgerError: (event) => {
        // 落盘失败只发事实，**不落日志**：日志是 CLI 面（`bindProxyEventLogs` 订阅这条事件
        // 落一条 error），库调用方订阅不到就什么也不输出 —— 与「日志落盘归 server 层」同纪律。
        this.events.publish("traffic.ledger-error", { path: event.path, error: event.error });
      },
    });

    const protocol = protocolFor(config);
    const normalizedOptions: ProxyOptions = {
      host: config.get("host"),
      port: config.get("port"),
      upstreamTimeout: config.get("upstreamTimeout"),
      tls: tlsOptionsFor(protocol, config),
      auth: this.services.auth,
      // 配额服务（显式注入优先，缺省是 services 里那份内存账本）：与 auth 同一根装配线，
      // 保证「组装点解析的默认实现」真的落到了 core ——core 侧的 `?? 显式禁用档` 永不生效
      traffic: this.services.traffic,
      isWorker: false,
      // 依赖上下文的持有者：三件套的缺省解析只在上面那两行做过一次，
      // 这里把已解析好的 config/logger/events 收成单个必填 ctx 传给 core
      ctx: this.dependencies,
    };

    this.proxy = createProxy(protocol, normalizedOptions);
    this.options = this.proxy.options;

    // 只报告本次归一化新产生的 warning；context.warnings 中的 loadConfig warning 不重复旁路发送。
    this.reportNormalizationWarnings(normalizationWarnings);
  }

  public async start(): Promise<void> {
    try {
      this.activateSubscriptions();
      this.events.publish("config.loaded", { source: sourceName(this.context) });
      this.reportQuotaGate();
      // 账本**必须在 core.start() 之前**开完：恢复 + 启动期压缩都读同一个文件，
      // 「先收流量再恢复」会让本进程的增量与恢复出来的账互相覆盖。
      await this.openTrafficLedger();
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
      // 落盘账本最后一次落盘：**排在排空之后**（排空期间还有在途字节在计量），
      // 且排在 releaseSubscriptions 之前（账本的 `onError` 要经这条总线发事件）。
      await this.closeTrafficLedger();
      this.releaseSubscriptions();
      if (this.ownsEvents) {
        this.events.removeAll();
      }
    }
  }

  /**
   * 开落盘账本（幂等；零成本档下 `open()` 立刻返回，什么都不建）
   * @description
   * 抛错**绝不让启动失败**：账本是配额功能的增强面，磁盘坏了不该让整个代理起不来。
   * 失败事实已经由账本自己经 `onLedgerError` 上报（→ `traffic.ledger-error` 事件 →
   * CLI 的 error 日志），这里只是再兜一层。
   */
  private async openTrafficLedger(): Promise<void> {
    const ledger = this.services.trafficLedger;
    if (ledger === undefined) {
      return;
    }
    try {
      await ledger.open();
    } catch (error) {
      this.publishRuntimeError(error);
    }
  }

  /**
   * 收落盘账本（幂等：摘定时器 → 最后一次落盘 → 关句柄）
   * @description
   * **停机必须落盘是正确性要求**，不是整洁工作：队列里那些「已计入内存判定、还没进磁盘」
   * 的字节如果丢掉，用户靠反复「用一点、Ctrl+C」就能把配额窗口内的额度一次次刷新。
   * `ProxyServer.stop()` 在与 `logger.flush()` 同一个位置也调一次（幂等空转），
   * 让「先落账本、再落日志」在 CLI 面上是显式次序。
   */
  private async closeTrafficLedger(): Promise<void> {
    const ledger = this.services.trafficLedger;
    if (ledger === undefined) {
      return;
    }
    try {
      await ledger.close();
    } catch (error) {
      this.publishRuntimeError(error);
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
    let lifecycleSubscription: EventSubscription | undefined;
    let unsubscribeConfig: (() => void) | undefined;
    let unbindAclFileEvents: (() => void) | undefined;
    try {
      // 生命周期观察面：core 的 `setState` 现在**直接**发布 `lifecycle.changed`，
      // 本 runtime 只把它翻译成 `runtime.*`（不再自己发 `lifecycle.changed`，避免一条事实两个来源）。
      // 它与 bridge 同属「每轮 start 建立 / stop 释放」的订阅组——泄漏就等于停机后监听残留。
      lifecycleSubscription = this.events.subscribe("lifecycle.changed", this.onLifecycleChanged);
      // 传 `RuntimeContext`（`CoreContext` 的实现）而非 core emitter：
      // 桥接器要在**core 当前那条总线**上订阅 `pipe`，并用同一个 `ctx.config`
      // 接请求终态 publisher——两者都只能从依赖上下文取，不再需要 `as unknown as` 强转。
      bridge.attach(this.dependencies);
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
      this.lifecycleSubscription = lifecycleSubscription;
      this.unsubscribeConfig = unsubscribeConfig;
      this.unbindAclFileEvents = unbindAclFileEvents;
      this.subscriptionsActive = true;
    } catch (error) {
      // 正常装配路径不抛错；若第三方 hook 在中途失败，仍不留下半轮订阅。
      bridge.subscription.dispose();
      try {
        lifecycleSubscription?.dispose();
      } catch {
        // 清理失败不能遮蔽原始装配错误。
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
      this.bridge = undefined;
      this.lifecycleSubscription = undefined;
      this.unsubscribeConfig = undefined;
      this.unbindAclFileEvents = undefined;
      this.subscriptionsActive = false;
      throw error;
    }
  }

  /** 释放本轮 runtime 自己的订阅；外部 EventHub 与旧 bridge 都不在这里处理。 */
  private releaseSubscriptions(): void {
    const bridge = this.bridge;
    const lifecycleSubscription = this.lifecycleSubscription;
    const unsubscribeConfig = this.unsubscribeConfig;
    const unbindAclFileEvents = this.unbindAclFileEvents;
    this.bridge = undefined;
    this.lifecycleSubscription = undefined;
    this.unsubscribeConfig = undefined;
    this.unbindAclFileEvents = undefined;
    this.subscriptionsActive = false;

    try {
      bridge?.subscription.dispose();
    } catch {
      // 退订失败不应阻断 stop 或其它清理。
    }
    try {
      lifecycleSubscription?.dispose();
    } catch {
      // 同上。
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

  /**
   * 启动期告警：未开鉴权 → 没有身份 → `users.json` 的 `quota` 整体不生效
   * @description
   * **为什么必须告警**：配了配额却没开鉴权，是一个「看起来生效、实际完全不计量」的配置
   * （core 侧一个监听器都不挂）。不告警就等于给运维假的安全感——这与 4a 对
   * `acl.clientIp` fail-closed 的判断同源。
   *
   * **触发条件刻意收窄到「真的配了非零配额」**：关鉴权本身是绝大多数部署的常态，没配配额时
   * 报这条 warn 纯属噪音（而且会淹没真正需要看的告警）。判据是**文件事实**（账号表里至少有一个
   * 非全 0 的 `quota`），不是配置猜测——`authEnabled=false` 单独不足以说明「有东西没生效」。
   *
   * 放在 `start()` 而不是构造函数：只有真要跑的 runtime 才需要被告知。
   * 文案取 `core/log-events.ts:QUOTA_INERT_DETAIL`（与 CLI 落盘的 `[quota-inert]` 行是同一句话）。
   */
  private reportQuotaGate(): void {
    const handler = this.warningHandler;
    if (handler === undefined || this.context.accessor.get("authEnabled")) {
      return;
    }
    if (!hasConfiguredQuota(this.context.accessor, this.fileEventHandler)) {
      return;
    }
    try {
      handler({ code: "quota-inert", message: QUOTA_INERT_DETAIL });
    } catch {
      // 告警回调是旁路，不应让启动失败。
    }
  }

  private reportNormalizationWarnings(warnings: readonly string[]): void {    if (this.warningHandler === undefined) {
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
