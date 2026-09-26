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
import { ACL_INERT_DETAIL, QUOTA_INERT_DETAIL } from "@/core/log-events.js";
import { EventHub, type EventListener, type EventSubscription } from "@/core/events/index.js";
import { createProxy } from "@/core/server/factory.js";
import { createConnectorSource } from "@/core/forward/upstream/connector/index.js";
import type { ProxyCore, ProxyOptions, ProxyProtocol, ProxyStats } from "@/core/types/proxy.js";
import type { Logger } from "@/utils/logger/index.js";
import { createNoopLogger } from "@/utils/logger/index.js";
import type { JsonFileEvent } from "@/utils/json-file/index.js";
import type { TlsKeyCert } from "@/utils/tls/index.js";
import { CoreEventBridge } from "./bridge.js";
import { RuntimeContext } from "./context.js";
import { bindLifecycleLog, bindProxyEventLogs } from "./event-log.js";
import { buildDefaultServices, hasConfiguredAcl, hasConfiguredQuota, isAccessOverridden } from "./services.js";
import type {
  ProxyRuntime,
  ProxyRuntimeOptions,
  RuntimeServices,
  RuntimeWarning,
} from "./types.js";

/**
 * 合法入站协议的**穷尽表**：`satisfies Record<ProxyProtocol, true>` 使新增协议成员时
 * **编译失败**而不是静默漏一个合法值（判据表与类型恒等，与 `core/access-control.ts`
 * 的编译缓存同一手法：穷尽性靠编译期钉住，不靠运行时查表）。
 */
const PROXY_PROTOCOL_TABLE = {
  http: true,
  https: true,
  socks4: true,
  socks5: true,
  sockss4: true,
  sockss5: true,
} satisfies Record<ProxyProtocol, true>;

/**
 * 协议字面量判据：**全目录唯一一份**（`./presets.js` 的 `pickStartupPreset` 经**同目录相对路径**
 * 从这里 import，不引 barrel、不引 `@/runtime/index.js`，故不产生目录自环）。
 * @description
 * 派生自 {@link PROXY_PROTOCOL_TABLE} 的键，**不另抄一份字面量数组**（抄一份就多一处会漂移的
 * 地方）。用 `hasOwnProperty` 而不是 `in`：`in` 会沿原型链命中，`"toString"` / `"constructor"`
 * 这类注册项名会被当成合法协议；也不用数组 `includes`——它没有原型链问题，却要再抄一份列表。
 *
 * **两个调用点、两种失败语义（刻意不合并成一处）**：
 * - 本文件 `protocolFor`（**构造期 fail-closed**）：表外值**抛错**，`未知代理协议: <值>`。
 * - `presets.js:pickStartupPreset`（库路径按 store 现合成预设）：表外值**不 throw**，把非法值
 *   原样带出去，交给 `protocolFor` 报**那同一条** fail-closed 错误——同一个错误信息在两处各写
 *   一份是最容易漂移的那种重复。
 */
export function isProxyProtocol(value: unknown): value is ProxyProtocol {
  return (
    typeof value === "string" && Object.prototype.hasOwnProperty.call(PROXY_PROTOCOL_TABLE, value)
  );
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
  /**
   * 事件 → 落盘绑定（`./event-log.js`）是否开启；缺省 `true`。
   * @description 它**不是**兼容开关，是一个真实的正交能力位：库调用方自己已把同一批事实
   * 桥进自己的日志/遥测（重复落一遍是噪音），或压根不想让代理事件进自己那个 logger。
   */
  private readonly eventLogsEnabled: boolean;
  /**
   * 本进程是不是 cluster 子进程；缺省 `false`（单进程 / 库模式）。
   * @description 唯一用途是 `isWorker: true` 时**不落** `[lifecycle] state …` 那一行
   * （它是 master 独有的日志）。**runtime 自己绝不读 `cluster.isWorker`**——那一条通道在
   * runtime 抽出时曾被 `normalizedOptions` 里那个 `isWorker: false` 常量截断，本项把它接回来
   * （同一个手法与同一个理由见 `trafficWorkerSlot`）。
   */
  private readonly isWorker: boolean;

  /** 这些订阅只在本 runtime 的 active 轮次存在；stop 后必须清空，下一轮重新创建。 */
  private bridge: CoreEventBridge | undefined;
  private unsubscribeConfig: (() => void) | undefined;
  private unbindAclFileEvents: (() => void) | undefined;
  private lifecycleSubscription: EventSubscription | undefined;
  /** 事件落盘订阅的统一退订点（幂等闭包，归属由闭包自己携带 —— 见 `./event-log.js` 的说明）。 */
  private unbindEventLogs: (() => void) | undefined;
  /** `[lifecycle] state …` 那一行的退订点（同一个闭包形态；与上面那族同轮装配、同轮释放）。 */
  private unbindLifecycleLog: (() => void) | undefined;
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
    this.eventLogsEnabled = options.eventLogs ?? true;
    this.isWorker = options.isWorker ?? false;

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

    // ── 具名启动预设（`assembly`）的消费点：整个文件只有这一段读它 ──
    //
    // **优先级链（三层，逐层覆盖）：显式 options > assembly > 配置 / 缺省。**
    // - `services`：**逐字段**合并（`{...assembly?.services, ...options.services}`）而非整体替换。
    //   四项服务彼此正交，调用方只想换身份实现时不该连带丢掉预设声明的流量账本；
    //   逐字段合并也让「显式注入某一项」与「预设声明其余项」能同时成立。
    // - `protocol` / `connectors`：assembly 是**程序化**决策（库调用方在代码里点名要哪个
    //   协议服务器 / 哪套上游接入），配置是**声明式**决策（env / argv / 内存对象）——
    //   前者天然比后者具体，故 assembly 覆盖配置。
    // - 显式 `options.services` / `options.connectors` 又盖过 assembly：调用方已经拿到
    //   组装点，最贴近「这一次运行真正要什么」的那句话。
    //
    // ⚠️ **assembly 不读 `process.env`、不读 argv、不碰文件**。env 的影响**全部收敛在
    // `loadConfig`**：库层再读一次就是「协议由两处决定」的第二真相源（这是
    // `presets.ts:pickStartupPreset` 注释里那条纪律的同一个理由）。
    const assembly = options.assembly;
    const serviceOverrides: Partial<RuntimeServices> = {
      ...assembly?.services,
      ...options.services,
    };

    // `this.dependencies`（`CoreContext` 的实现）必须**先于**本调用存在：它就是
    // `buildDefaultServices` 的第一个形参。构造顺序上它在 logger/events 缺省解析**之后**、
    // 这里**之前**（见上方 `this.dependencies = new RuntimeContext({...})`）。
    this.services = buildDefaultServices(
      this.dependencies,
      serviceOverrides,
      this.fileEventHandler,
      {
        // 槽位号：**只**来自 CLI 的 env 快照（`PROXY_WORKER_SLOT` → runServer → ProxyServer
        // → 本选项）。runtime 自己绝不读 `process.env`：槽位会拼进账本文件名。
        slot: options.trafficWorkerSlot,
        onLedgerError: (event) => {
          // 写盘失败**只发事实、不在这里落日志**：落盘那一跳统一由
          // `./event-log.ts:bindProxyEventLogs` 收（`activateSubscriptions` 里装配、
          // `eventLogs: false` 可关），这样 CLI 与库共用同一份、且不会有两个落点。
          this.events.publish("traffic.ledger-error", { path: event.path, error: event.error });
        },
      },
    );

    // 配置值**无论是否被 assembly 覆盖都要先校验**：`ConfigStore` 零校验，库路径能把
    // `"ftp"` 这类表外值塞进 store，而 `ConfigContext.config` 快照 / `logConfig` 仍会原样
    // 打印它。一个「配了、没生效、也不报错」的值比启动报错坏得多（与 core 侧
    // `upstreamProtocol` fail-closed 同源）。覆盖只改变**用哪个值**，不改变**是否校验**。
    const configuredProtocol = protocolFor(config);
    const protocol = assembly?.protocol ?? configuredProtocol;

    // 上游接入来源：**必须在 `createProxy` 之前解析**。
    // `createConnectorSource` 本身是零分配的惰性门面（查表与构造都推迟到第一次真被问），
    // 故构造期调它**不产生任何副作用**；但 `ConnectorSource.upstream()` 会**记忆**
    // `upstreamProtocol`（startup 相位字段）——同一个 source 永远只认第一次看到的值。
    // 因此解析必须落在 core 构造之前，且整个 runtime 生命周期内**只解析一次**：
    // 解析两次就有两个 source 各记一份协议，「一个进程一个真相源」当场被破。
    //
    // 与 `BaseProxy` 构造期的 `options.connectors ?? createConnectorSource(options.ctx)` **同构**
    // （同一个工厂、同一个 ctx），**刻意不做配置驱动的二次解析**：那属于「缺省解析只允许在
    // `createProxyRuntime()` 里做一次」这条铁律。core 侧那一份缺省档只服务**直构 core** 的
    // 低层调用方；runtime 在这里解析一次并**显式注入**，于是「库调用方注入的替身」与
    // 「配置驱动的默认值」落在同一条装配线上。
    const connectors =
      options.connectors ??
      assembly?.connectors?.(this.dependencies) ??
      createConnectorSource(this.dependencies);

    const normalizedOptions: ProxyOptions = {
      host: config.get("host"),
      port: config.get("port"),
      upstreamTimeout: config.get("upstreamTimeout"),
      tls: tlsOptionsFor(protocol, config),
      // 三个服务端口（身份 / 访问控制 / 流量配额）一律取**已解析好的那一份**：
      // 与 `createConnectorSource` 同理，core 侧的 `?? 显式 inert 档` 因此永不生效，
      // 保证「组装点解析的默认实现」真的落到了 core。
      identity: this.services.identity,
      access: this.services.access,
      traffic: this.services.traffic,
      connectors,
      // worker 身份由调用方显式申报（`ProxyServer` 经 `cluster.isWorker` 传下来）。
      // runtime 零 `cluster` 零 `process`，「本进程是不是子进程」没有别的来源；
      // `[lifecycle]` 那行 master-only 的门就靠这一位。
      isWorker: this.isWorker,
      // 依赖上下文的持有者：三件套（config / logger / events）的缺省解析只在上面
      // `options.events ?? new EventHub(...)` 与 `options.logger ?? createNoopLogger()`
      // 那两行做过一次，这里把已解析好的它们收成单个必填 ctx 传给 core
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
      // 名单失效告警**紧跟配额告警**（同一轮启动期报告，顺序：先配额后名单），
      // 且同样排在账本 open 与 core.start() 之前 —— 两条都是「一次性事实」，
      // 都要在任何可能抛错的步骤之前报出去，否则启动失败时运维连「配置有洞」都不知道。
      this.reportAclGate();
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
    let unbindEventLogs: (() => void) | undefined;
    let unbindLifecycleLog: (() => void) | undefined;
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
      // 事件 → 落盘绑定（`./event-log.js`）。**刻意落在本循环里、而不是构造期**：
      // 上面那组就是「start 重建、stop 全退」的唯一权威（`subscriptionsActive` 幂等旗标
      // 与 `releaseSubscriptions` 的对称清理都只管这一组），绑定漏在外面就会在
      // `start → stop → start` 之后**叠加**——每轮多一份订阅，同一条 `[forward]` 落 N 次。
      //
      // 总线取 `this.dependencies.events`（**当前**那条）而不是构造期的 `this.events`：
      // 与 `CoreEventBridge.attach(ctx)` 里的 `ctx.events` 同一条纪律 —— `RuntimeContext.setEvents()`
      // 能在运行期换总线，core 发布时读的也是 `ctx.events`，取错会「core 发新总线、落盘听旧总线」
      // 而静默丢整段日志。退订由闭包携带归属（各 `EventSubscription.dispose()` 记着自己的 hub），
      // 换总线也不会退错。
      if (this.eventLogsEnabled) {
        unbindEventLogs = bindProxyEventLogs(this.dependencies.events, this.logger);
        // `[lifecycle] state …` 那一行（**服务期**那一族，与上面 11 条同轮装配、同轮释放）。
        // 判据与 `bindProxyEventLogs` 完全同源：零 `process` 触点、落盘不拥有进程、文本契约
        // 搬完之后 CLI 那几行逐字不变。⚠️ **`isWorker` 档零行**（那一行是 cluster master 独有的，
        // worker 的 ready 面走 IPC 上报由 master 汇总）；`protocol` 从**本 runtime 自己的 core
        // 实例**取，不另配一份、不从配置重读。
        if (!this.isWorker) {
          unbindLifecycleLog = bindLifecycleLog(
            this.dependencies.events,
            this.logger,
            this.proxy.protocol,
          );
        }
      }
      this.bridge = bridge;
      this.lifecycleSubscription = lifecycleSubscription;
      this.unsubscribeConfig = unsubscribeConfig;
      this.unbindAclFileEvents = unbindAclFileEvents;
      this.unbindEventLogs = unbindEventLogs;
      this.unbindLifecycleLog = unbindLifecycleLog;
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
      try {
        unbindEventLogs?.();
      } catch {
        // 同上。
      }
      try {
        unbindLifecycleLog?.();
      } catch {
        // 同上。
      }
      this.bridge = undefined;
      this.lifecycleSubscription = undefined;
      this.unsubscribeConfig = undefined;
      this.unbindAclFileEvents = undefined;
      this.unbindEventLogs = undefined;
      this.unbindLifecycleLog = undefined;
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
    const unbindEventLogs = this.unbindEventLogs;
    const unbindLifecycleLog = this.unbindLifecycleLog;
    this.bridge = undefined;
    this.lifecycleSubscription = undefined;
    this.unsubscribeConfig = undefined;
    this.unbindAclFileEvents = undefined;
    this.unbindEventLogs = undefined;
    this.unbindLifecycleLog = undefined;
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
    try {
      // 幂等闭包：与「装配失败回滚」那条路径可能各调一次，第二次是空转。
      unbindEventLogs?.();
    } catch {
      // 同上。
    }
    try {
      // 同上（`[lifecycle]` 那一族的退订点，形状与幂等语义完全一致）。
      unbindLifecycleLog?.();
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

  /**
   * 启动期告警：调用方注入了自定义 `access` → `acl.json` 的名单不会生效
   * @description
   * **这一条与「`access` 缺省」无关**——`ProxyOptions.access` 已经是**编译期必填**，
   * core 侧不再存在「缺省放行」这回事（`OPEN_ACCESS_CONTROL` 已整体删除）。这里报的是
   * 另一件事，也是端口化之后**唯一**残留的静默失效形态：
   *
   * > 调用方经 `services.access`（或 `assembly.services.access`）注入了自己的实现
   * > ⇒ `buildDefaultServices` **不会**去解析 `createFileAccessControl(config)`
   * > ⇒ `acl.json` 里那份名单**根本没被读**。
   *
   * 这**是**正当用法（端口的意义就是换实现），但运维视角是「我配了名单怎么没生效」，
   * 所以值得一条启动期信号。
   *
   * **判据两个都必须成立**（与 `quota-inert` 同一手法：文件事实，不是猜配置）：
   * ① `hasConfiguredAcl` —— `acl.json` 真配了内容（整份缺失 / 四组全空 / **读失败** 一律
   *    `false`，代价是「压根不知道配没配」时不告警，见 `config/files/acl.ts` 的取舍说明）；
   * ② `isAccessOverridden` —— `access` 确实来自调用方注入。
   * 少任何一条都变成噪音：① 缺了就是「没配名单也在报」，② 缺了就是「没配名单的部署狂报」。
   *
   * **产出时机与 `reportQuotaGate` 同一处**（`start()` 的报告阶段，排在账本 open 与
   * `core.start()` 之前），且**只报一次**（启动期一次性事实，不是每请求）。`quota-inert`
   * 那条的产出时机与生命周期**一字未改**。
   * 文案取 `core/log-events.ts:ACL_INERT_DETAIL`（与 CLI 落盘的 `[acl-inert]` 行是同一句话）。
   */
  private reportAclGate(): void {
    if (this.warningHandler === undefined || !isAccessOverridden(this.services.access)) {
      return;
    }
    if (!hasConfiguredAcl(this.context.accessor, this.fileEventHandler)) {
      return;
    }
    try {
      this.warningHandler({ code: "acl-inert", message: ACL_INERT_DETAIL });
    } catch {
      // 告警回调是旁路，不应让启动失败（与 reportQuotaGate 同纪律）。
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
