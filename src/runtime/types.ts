import type { ConfigContext } from "@/config/index.js";
import type { AppConfig } from "@/config/index.js";
import type { EventHub } from "@/core/events/index.js";
import type { TrafficAccount, TrafficLedgerController } from "@/core/traffic/index.js";
import type { AccessControl, ProxyCore, ProxyOptions, ProxyStats } from "@/core/types/proxy.js";
import type { IdentityProvider } from "@/core/types/identity.js";
import type { ConnectorSource } from "@/core/forward/upstream/connector/index.js";
import type { Logger } from "@/utils/logger/index.js";
import type { StartupPreset } from "./presets.js";

/**
 * 库用户可覆盖的运行时服务（逐步扩展：routing / forwarding / errors）。
 *
 * **三项都走同一个形状：「配置驱动的默认实现 + 可覆盖替身」**，默认实现的解析**只在**
 * `services.ts:buildDefaultServices`（全项目唯一那处）。显式注入的替身**原样透传**到
 * `ProxyOptions` 与 `runtime.options`（护栏查对象同一性），故库调用方注入的替身一定生效，
 * core 侧的「`??` 显式 inert 档」永不触发。
 */
export interface RuntimeServices {
  /**
   * 身份提供者（`@/core/types/identity` 的 `IdentityProvider` 端口）。
   * 缺省 = 配置驱动门面 `createIdentityFromConfig(ctx)`（现读 `AUTH_*` 与 `users.json`），
   * 在 `services.ts:buildDefaultServices` 里解析——**全项目唯一**做这件事的地方。
   */
  readonly identity: IdentityProvider;
  /**
   * 访问控制服务（`@/core/types/proxy` 的 `AccessControl` 端口）。
   * 缺省 = 文件驱动实现 `createFileAccessControl(ctx.config)`（现读 `acl.json` / `users.json`
   * 的两层名单），同样在 `services.ts:buildDefaultServices` 里解析。
   *
   * **三个方法为什么必须是同步的（硬裁决，不是省事）**：`checkRoute` 被**四条入站通道**
   * （http / tunnel / upgrade / socks）在**拨号之前**调用，它的结果要立刻喂进「选哪个连接器 /
   * 拒绝应答 / 发 `route` 事件」这一串**同步**控制流。改成 `async` 会级联改掉整条转发链
   * （每条通道各多一个 `await` 边界、`resolveForwardTargets` 连带变 async、转发器入口签名与
   * 两阶段准入的时序全部要重排）——为「将来也许要查个远程策略」付这个代价不划算。
   * **需要远程查策略的诉求归 `IdentityProvider`**（`identify` 本来就是 `async`）：
   * 身份判定的结果本来就允许等，准入判定不允许。
   *
   * **与 `identity` 同为「现读 live store 的动态对象」**：热改配置或热改名单文件后**下次请求生效**，
   * 不必重建 runtime（编译缓存按 accessor 记忆、快照未变即复用，见 `core/access-control.ts`）。
   */
  readonly access: AccessControl;
  /**
   * 每用户流量配额服务。缺省 = 内存账本（现读 `users.json` 的 `quota`），在本目录
   * `services.ts:buildDefaultServices` 里解析——**全项目唯一**做这件事的地方。
   */
  readonly traffic: TrafficAccount;
  /**
   * `traffic` 的**落盘副本**：`runtime.start()` 开、`stop()` 收。
   *
   * **缺省即 undefined，且它与「默认内存账本」同生共死**：调用方显式注入 `services.traffic`
   * 时本字段恒为 undefined（那一本账归调用方管，我们不写它的文件、不给它起定时器）。
   * 没有配任何非全 0 `quota` 时 `open()` 会走**零成本档**（不建目录/不开句柄/不起定时器），
   * 但本字段**非 undefined** —— 「有没有账本对象」与「账本有没有真的启用」是两个问题，
   * 观测面靠 `open()` 之后的 `ledger.enabled` 回答。
   */
  readonly trafficLedger?: TrafficLedgerController;
}

interface ProxyRuntimeCommonOptions {
  /** 依赖注入：覆盖任意服务；不传则用当前 context 的默认实现。 */
  services?: Partial<RuntimeServices>;
  /** 外部事件总线；不传则 runtime 自建一个（每 runtime 独立）。 */
  events?: EventHub;
  /** 日志端口；不传则 createNoopLogger()（零副作用、零落盘）。 */
  logger?: Logger;
  /**
   * **事件 → 落盘绑定**（`./event-log.js`）是否开启。**缺省 `true`。**
   *
   * @description
   * 开启时本 runtime 在 `start()` 里把 11 类公共事实事件绑到注入的 `logger` 上
   * （`[{kind}] headers` / `[forward]` / `[auth] deny` / `[route]` / `[event-code]` 等那批落盘行），
   * 随 `stop()` 一起退订，`start → stop → start` 不叠加。**CLI 与库走的是同一份绑定**，
   * 所以日志行一条不多一条不少。
   *
   * 显式 `false` = 不绑定，两种真实场景：
   * 1. **调用方自己已接了事件桥**（`runtime.events.subscribe("pipe", …)` → 自己的遥测/日志）。
   *    代理事实落两遍是噪音，而 `pipe` 那 14 个变体 + `auth.decided` 的完整载荷它都拿得到。
   * 2. **不想让代理事件进自己那个 logger**：`logger` 是宿主应用级 logger（同一个
   *    Electron 主进程 / 服务进程里还跑着别的东西），`[proxy]` 前缀的逐请求行会淹掉它。
   *
   * ⚠️ **它不是兼容开关、不是「关掉就回到某个旧行为」**：CLI 一直是**恒绑定**的，本项
   * 缺省同样是 `true`，故「CLI 现状」这条恒等式由缺省值兑现、不靠这个开关。
   * 另：传了 `logger` 就意味着「我给了代理一个日志端口」，缺省绑上正是那个端口的预期语义；
   * 不想要就得显式说 `false`——**沉默不等于同意**。
   *
   * ⚠️ **不绑 ≠ 事件没了**：事件仍照常发布在 `runtime.events` 上（`traffic.ledger-error`、
   * `access.*`、`route.selected` 等公共契约一条不少），本项只关掉「事件 → 这一个 logger」这一跳。
   *
   * ⚠️ **「绑了」也不等于「有落盘」——落盘还取决于有没有注入真实 logger**：runtime 缺省
   * `logger` 是 {@link ProxyRuntimeCommonOptions.logger | `createNoopLogger()`}，而 noop logger
   * **零落盘**。于是库调用方若配了 `logFile` 却没显式 `createLogger({ config })` 注入，
   * 本项缺省 `true` 也照样**一行不写**。方向是安全的（「缺席 = 不写盘」而不是「缺席 = 全写」），
   * 但它足以让人误判成 bug，故写在这里：`LOG_FILE` / `LOG_FILE_LEVEL` 是 **logger 的**配置，
   * 不是 runtime 的——**要落盘就得给一个带文件 sink 的 logger**（CLI 走的就是
   * `cli.ts` 里那一步）。`runtime/AGENTS.md`「零副作用铁律」要求缺省必须是 noop，
   * 「库默认替我建个会写文件的 logger」不在授权范围内。
   */
  eventLogs?: boolean;
  /**
   * **本进程是否是 cluster 子进程**（缺省 `false` = 单进程 / 库模式）。
   *
   * @description
   * **只为一件事存在**：`[lifecycle] state …` 那一行是 **cluster master 独有**的日志，
   * `true` 时本 runtime **不落这一行**（其余代理事件照旧落盘——`bindProxyEventLogs` 不看本项）。
   * 传进来之后 `runtime.options.isWorker` 也随之如实——**别把它归一成常量**，
   * 那会让 `ProxyOptions.isWorker` 变成一个「归一了但永远没人读」的死字段。
   *
   * ⚠️ **它必须是显式参数，且 `runtime/**` 绝不读 `cluster.isWorker`**——与
   * {@link ProxyRuntimeOptions.trafficWorkerSlot} 同一手法：那一位是「槽位会被拼进账本文件名，
   * 自己猜来源 = 写错文件」，这一位是「worker 身份决定一行日志落不落盘，自己猜来源 = 每个
   * worker 每轮启停多四行噪音」。**库调用方没有 cluster 这个概念，所以只能由调用方申报。**
   * 传递链是 `ProxyServer.isWorker()`（`cluster.isWorker`，或测试注入的 `isWorker` 覆盖）
   * → `ProxyServer.createRuntime()` → 本选项 → `runtime.ts` 的装配判断。
   */
  isWorker?: boolean;
  /** 启动期告警回调（如 mTLS 配了但证书读不到），库模式不打印只回调。 */
  onWarning?: (w: RuntimeWarning) => void;
  /**
   * **流量配额账本的槽位号**。
   *
   * **它必须是显式参数，且 `runtime/**` 绝不读 `process.env`**：槽位会被拼进账本文件名
   * （`worker-<slot>.jsonl`），「自己猜来源」意味着「写错文件 / 读别人的账」。传递链是
   * `cli.ts` 的 env 快照 → `runServer(context, { trafficWorkerSlot })` → `ProxyServer` → 本选项 →
   * `services.ts` → `core/traffic/ledger.ts`。env 名 `PROXY_WORKER_SLOT` 的**唯一写入方**是
   * `server/cluster.ts` 的 fork（`core → server` 是被禁方向，所以这一环天然在 core 之外）。
   *
   * 省略 = 单进程/库模式（归一为 `"0"`）。非法值（非 `1..9999` 纯数字）同样归一为 `"0"`
   * —— 槽位会拼进文件路径，非数字内容一律按**路径穿越面**拒绝（见 `normalizeSlot`）。
   */
  trafficWorkerSlot?: string;
  /**
   * **上游接入来源**（`ConnectorSource`）：装配期已定死的「直连 / 走上游」两档。
   *
   * **可注入**，故它排在选项上而不是 `services` 里：它不是「服务」而是「装配期解析出的
   * 两张连接器引用」，与 `traffic` 那种**进程级可变状态**不同类（`services` 里的三项都是
   * 「一个判定/计量端口」，`connectors` 是「协议到连接器的那次查表结果」）。
   *
   * 解析次序在 `runtime.ts`：`options.connectors ?? assembly?.connectors?.(ctx) ??
   * createConnectorSource(ctx)`，**整个 runtime 生命周期只解析一次**——`ConnectorSource.upstream()`
   * 会记忆 `upstreamProtocol`（startup 相位），解析两次就有两个 source 各记一份协议，
   * 「一个进程一个真相源」当场被破。与 `BaseProxy` 构造期的
   * `options.connectors ?? createConnectorSource(options.ctx)` 刻意同构：runtime 解析一次并
   * **显式注入**，于是 core 侧那份缺省档只服务**直构 core** 的低层调用方、永不生效。
   * 本选项**原样透传**：`runtime.options.connectors` 与注入的实例是同一对象。
   */
  connectors?: ConnectorSource;
  /**
   * **具名启动预设**（`StartupPreset`）：一档**程序化**的装配决策（协议服务器 / 服务替身 /
   * 上游接入），由库调用方在代码里点名要哪一档。
   *
   * ⚠️ **它与 `@/config/presets.ts` 的 `ProxyPreset` 是两样东西**（那边是**配置值**打包
   * `name + Partial<AppConfig>`，经 accessor 现读；这边装的是**服务实例工厂**）。
   * 名字的错开与对照表在 `./presets.ts` 文件头。
   *
   * **消费点在构造期**（协议与连接器都是 startup 相位事实，构造后不再变）：`runtime.ts` 里
   * 那一段是唯一读它的地方，优先级链是**三层逐层覆盖**「显式 `options` > `assembly` >
   * 配置 / 缺省」，逐字段细则见那一段注释。
   *
   * **与 `services` / `connectors` 的关系**：后两者是**单点**替身（注入什么就是什么），
   * 本项是**一档组合**（一次给全协议 + 四项服务 + 上游接入，且它们之间应当自洽——比如
   * 「协议是 sockss5」与「服务替身是一整套自研实现」只有配成同一档才有意义）。
   * ⚠️ **注意预设的 `connectors` 是工厂 `(ctx) => ConnectorSource`、本选项的 `connectors`
   * 是实例**：`ctx` 只有装配期（`this.dependencies` 建好之后）才存在，预设要能**声明意图**
   * 而不绑死某次运行的依赖三件套。两处形状不同不是不一致，别「顺手统一」。
   *
   * **它位于 common options 而不在二选一那一侧**：两种来源（`context` / 纯内存 `config`）
   * 都能叠加预设——「复用宿主的 live store，但协议这一档由我在代码里点名」是成立的组合。
   *
   * **取值与展开规则以 `./presets.ts` 的 `StartupPreset` 为准**，本文件只负责挂位、不另写一份
   * 形状（两处各写一份就会出现「文档说 A、展开做 B」）。
   */
  assembly?: StartupPreset;
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

/**
 * 启动期非控制流告警。
 *
 * @description `code` 刻意是**自由 `string`** 而不是闭合字面量集：它是库调用方与 CLI 之间的
 * 一条**旁路通知面**（`onWarning`），收口到联合类型等于逼着每加一条告警就改一次下游的全部
 * `switch`——而下游的正确反应恰恰是「不认识的 code 就先不处理」。库调用方**必须自己**决定
 * 哪些 code 值得升级成自己的告警面（`src/server/index.ts` 的 CLI 档**刻意不整体转发**，
 * 只接 `quota-inert` 与 `acl-inert` 两条，见那里注释里的理由与复核）。
 *
 * **今天 runtime 会发出的 code**（新增一条必须在这里登记，否则下游无从发现）：
 * - `"quota-inert"` —— 未开鉴权 + 账号表里真配了非全 0 `quota` → 配额整体不生效。
 *   文案常量 `core/log-events.ts:QUOTA_INERT_DETAIL`。
 * - `"acl-inert"` —— 调用方显式注入了 `services.access` + `acl.json` 真配了名单 →
 *   那份文件不会生效。文案常量 `core/log-events.ts:ACL_INERT_DETAIL`。
 * - `"config-normalized"` —— 构造期归一（典型是 `UPSTREAM_URL` 拆项覆盖）产生的 warning。
 * - `"start-failed"` —— 启动抛错，`message` 是原始错误文本。
 */
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
