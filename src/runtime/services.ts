import { createFileAccessControl } from "@/core/access-control.js";
import { createIdentityFromConfig } from "@/core/identity.js";
import type { ConfigAccessor, UserQuota } from "@/config/index.js";
import { loadAuthUsers, loadUserQuota } from "@/config/index.js";
import type { CoreContext } from "@/core/context.js";
import {
  MemoryTrafficAccount,
  quotaWindow,
  type QuotaWindow,
  type TrafficLedgerController,
  type TrafficLedgerError,
  type TrafficWindowSource,
} from "@/core/traffic/index.js";
import { JsonlTrafficLedger } from "@/core/traffic/index.js";
import type { IdentityProvider } from "@/core/types/identity.js";
import type { AccessControl } from "@/core/types/proxy.js";
import type { JsonFileEvent } from "@/utils/json-file/index.js";
import type { RuntimeServices } from "./types.js";

/**
 * 「配了访问控制」的**文件事实**判据与 `hasConfiguredQuota` 同层转出。
 * @description 实现住在 `@/config/index.js`（名单数据层），本文件只做**转出**：
 * `runtime.ts` 因此能从同一处取「配额是否配了」与「名单是否配了」两个启动期告警判据，
 * 而不需要知道它们各自住在哪个层。**判定实现只有一份**（告警与判定必须是同一个函数）。
 */
export { hasConfiguredAcl } from "@/config/index.js";

/**
 * 被 `overrides.access` 显式覆盖过的那一份访问控制实例。
 *
 * @description **模块级 `WeakMap` 而不是往 `RuntimeServices` 上加字段**——后者是
 * **公开面**（库调用方 `runtime.services` 拿到的就是它），加一个「这份 access 是不是替身」
 * 的装配元数据进去，等于把「装配期的一次决定」抬成「运行时契约的一部分」，调用方会开始
 * 依赖它；而 WeakMap 的判据是**实例身份**，与 `services` 那个冻结包**零字段增量**、调用方
 * 完全看不见（本文件是它的唯一写入方与唯一读取方）。
 *
 * 键为注入实例本身，故「同一个替身对象被两个 runtime 共用」也照样判得出（两条 runtime
 * 都把同一个 `access` 显式注入了）；未覆盖时表里没有这个键 → `false`。
 */
const overriddenAccess = new WeakSet<AccessControl>();

/**
 * 这一份 `AccessControl` 是否由调用方**显式注入**（而不是 `buildDefaultServices` 解析的默认实现）。
 *
 * @description 唯一的消费点是 `runtime.ts` 的 `acl-inert` 启动期告警判据：
 * 「`acl.json` 配了名单」∧「`access` 被覆盖」⇒ 那份文件不会生效。
 * ⚠️ **判据是「有没有显式注入」而不是「是不是 `createFileAccessControl` 造出来的」**——
 * 后者要靠 instanceof，跨模块副本 / 打包产物 / 测试替身全部会失配，症状是「明明注入了
 * 替身、告警却没响」。这是形状判定而不是身份判定。
 *
 * @param access - 当前 runtime 拿到的那个 `AccessControl` 实例
 * @returns 调用方显式注入了替身返回 `true`；走默认实现返回 `false`
 */
export function isAccessOverridden(access: AccessControl): boolean {
  return overriddenAccess.has(access);
}

/**
 * 落盘账本的装配位参数（`buildDefaultServices` 的第四个形参）
 * @description
 * **这一层是「core 不读 process.env」那条铁律的兑现点**：槽位号必须由 **CLI 的 env 快照**
 * 显式传进来（`src/cli.ts:main()` → `runServer(..., workerSlot)` → `ProxyServer` →
 * `createProxyRuntime({ trafficWorkerSlot })` → 这里的 `host.slot`），谁也不许自己去读
 * `process.env`。理由与其它 config 端口同源，但在这里更硬：槽位**会被拼进文件路径**，
 * 一次「猜来源」就是一次「写错文件/读别人的账」。
 */
export interface TrafficLedgerHost {
  /**
   * cluster 注入的 worker 槽位（`PROXY_WORKER_SLOT` 的值）。**稳定序号**：单进程/库模式
   * 缺省或非法一律归一为 `"0"`，cluster worker 为 `1..N`。
   */
  readonly slot?: string;
  /**
   * 写盘/压缩失败的旁路。runtime 注入它去发 `traffic.ledger-error` 公共事件（由同目录
   * `./event-log.ts:bindProxyEventLogs` 落一条 error 日志，CLI 与库共用）。
   * **刻意不传 logger**：本端口只发事实、落不落盘由 runtime 那一侧的绑定统一裁决
   * （`options.eventLogs`），服务插件不自己决定「要不要写日志」。
   */
  readonly onLedgerError?: (event: TrafficLedgerError) => void;
}

/**
 * 账号表里是否至少有一个**非全 0** 的 `quota`（= 真配了上限）
 * @description
 * 这是**落盘账本的零成本判据**（也是 `runtime.ts` 里 `quota-inert` 告警的判据，两者
 * 必须是**同一个**函数 —— 两处各写一份，迟早会出现「告警说没配、账本说配了」）。
 *
 * 全 0 的 `quota` 按契约等于「不限流」，与「没配」在语义上完全一样，故不计入。
 * 走 `loadAuthUsers`（与 `loadUserQuota` 同一条 1s 节流读取路径），启动期读一次不额外碰盘。
 * **判据是文件事实而不是配置猜测**：关鉴权 / 目录没配 都不影响「有没有人真被限流」。
 *
 * **签名刻意只收 `ConfigAccessor`**（而不是与 `buildDefaultServices` 一样收 `CoreContext`）：
 * 它是一份**纯判定**、不观察也不发布任何东西，故 `logger`/`events` 对它是纯多余参数。真要给它
 * 整个 ctx 就是「为了让签名看起来一致」而扩大依赖面。
 */
export function hasConfiguredQuota(
  config: ConfigAccessor,
  onFileEvent?: (event: JsonFileEvent) => void,
): boolean {
  const accounts = loadAuthUsers(config, onFileEvent);
  for (let i = 0; i < accounts.length; i++) {
    const q = accounts[i].quota;
    if (q !== undefined && (q.bytesUp > 0 || q.bytesDown > 0 || q.bytesTotal > 0)) {
      return true;
    }
  }
  return false;
}

/**
 * 装配 runtime 的默认服务。**全项目唯一**解析默认服务的地方（身份 / 访问控制 / 配额账本三样）。
 *
 * ## 为什么第一个形参是 `CoreContext` 而不是 `ConfigAccessor`
 *
 * 三件套（`config` / `logger` / `events`）是**每个服务插件都该拿到**的东西，而不是「装配点该
 * 操心的杂事」：身份插件的账号文件坏掉要能**渲染日志**（`ctx.logger`）与**发事件**
 * （`ctx.events`），访问控制同理。传一个裸 `ConfigAccessor` 等于逼**每个组装点自己**去拼
 * logger/events（`new EventHub()` + `createJsonFileEventHandler(logger)`，再决定哪一半给谁），
 * 那是「每个组装点各拼一次」的第二真相源：两个组装点就会得到两套观察面，而外部表现是
 * 「日志说名单没变、判定却换了」。本仓的既有纪律是**观察面由唯一组装点注入一次**
 * （`access-control.ts:bindAclFileEvents` 与身份工厂的 `onFileEvent` 形参都是这条），
 * 而**依赖三件套由 plugin 自己持有**——`ctx` 是这两条纪律唯一的交点。
 *
 * 顺带说清三个成员当前各自被谁用到（免得下一个人以为「传 ctx 是为了现在这三处」）：
 * - `ctx.config`：**三个默认实现全部**用到（身份现读 `AUTH_*` + 账号表；访问控制现读名单；
 *   配额账本经下面那些闭包现读 `quotaResetHour`/`quotaLedgerDir`/`quotaFlushInterval`）。
 * - `ctx.logger`：身份的**缺省观察面**（`createIdentityFromConfig` 在没给 `onFileEvent` 时用它
 *   渲染账号文件状态迁移；runtime 路径总给，故库调用方直构时才走这条）。
 * - `ctx.events`：**当前三个默认实现都不直接 publish**，且这是刻意的——身份域明确「不自己往
 *   `ctx.events` 注册」（否则与组装点的事件来源重复、`stop()` 退订清单漏一轮），
 *   ACL 的观察面走 `bindAclFileEvents`、账本错误走 `host.onLedgerError`。**它在这里是「位置」
 *   而不是「当前调用」**：下一个需要发事件的服务插件不必再回头改这个签名。
 *
 * ## 三项默认实现逐项说明
 *
 * **默认 identity 是动态门面**：`createIdentityFromConfig(ctx, fileEventHandler)` 每次
 * `identify`/`isOwnCredential` 都现读 live store + 账号文件（热改配置下次请求生效）。调用方
 * 显式注入的 identity 优先，且不会为了被覆盖的默认实现多做**任何**装配工作（`??` 左侧先判，
 * 右侧的表达式根本不求值）。
 *
 * **默认 access 是文件驱动的名单判定**：`createFileAccessControl(ctx.config)` —— 它**只收
 * `config`**，这是**刻意的**：`access-control.ts` 的观察面有且只有一个注册入口
 * （`bindAclFileEvents(config, handler)`，由 `runtime.start()` 那一轮订阅装），若工厂再收一个
 * `onFileEvent` 便利形参，就会出现**两个写同一个 `WeakMap` 的入口**——两个 handler 都装上了，
 * 而判定层只认后装的那个，先装的静默收不到事件。**少一个入口永远优于多一个便利形参。**
 * 本模块因此**不自注册 ACL 文件订阅**（那是 `runtime.start()` 的活），也正因如此本模块对
 * `access` 只需要 `ctx.config`，不需要另外拼观察面。
 *
 * **默认 traffic 是内存账本**（读同一份 `users.json` 的 `quota`）：这是全项目**唯一**解析
 * 默认流量配额服务的地方——`ProxyOptions.traffic` 未注入时 core 只拿到**显式禁用档**
 * （见 `BaseProxy`），故库调用方经 `services.traffic` 注入的替身一定是原样生效的。
 * 配额解析经 `loadUserQuota` 走账号表**同一条** 1s 节流读取路径（与 `loadUserPolicy` 同一套
 * 性能论证：文件 IO 被摊薄到每文件最多 1s 一次 stat，`consume` 每 chunk 调一次也不碰盘）。
 *
 * **窗口口径也在这里注入**：`quotaResetHour` 是 **runtime 相位**字段，故经
 * `ctx.config` **现读**（闭包每次调用都取一次）——热改 `store` 立即生效、不必重启。
 * 时钟源 `Date.now` 保持默认：账本内部只用它算窗口键，且窗口滚动是**惰性**的（每次访问槽位
 * 时比对），故既不需要注入时钟、也不需要任何定时器（见 `core/traffic/memory.ts` 文件头）。
 *
 * **落盘账本也只在这里解析，且与默认内存账本同生共死**：调用方**显式注入**
 * `services.traffic` 时账本**一律不建**（`trafficLedger: undefined`）——替身意味着「这一本
 * 账由你管」，我们既不该把它的 delta 写进文件、也不该在它上面挂定时器。注入本类构造**零
 * 副作用**：只算出一个文件路径，目录/句柄/定时器全部由 `runtime.start()` 触发的
 * `ledger.open()` 创建。
 *
 * **返回冻结**：`RuntimeServices` 是只读视图，组装期解冻一次（`Object.freeze`）比让每个消费点
 * 各自小心便宜。**本函数构造期零副作用**：不 mkdir、不 open、不起定时器、不读文件、不打日志、
 * 不读 `process.env`（槽位由 `host.slot` 显式传）。
 */
export function buildDefaultServices(
  ctx: CoreContext,
  overrides: Partial<RuntimeServices> = {},
  onFileEvent?: (event: JsonFileEvent) => void,
  host: TrafficLedgerHost = {},
): RuntimeServices {
  const identity: IdentityProvider =
    overrides.identity ?? createIdentityFromConfig(ctx, onFileEvent);
  // 访问控制：只拿 `ctx.config`（观察面由 `bindAclFileEvents` 单独注册，本模块不自注册，
  // 理由见上面那段注释）。缺省实现同样是**现读 live store** 的动态对象：热改配置下次请求生效。
  const access: AccessControl = overrides.access ?? createFileAccessControl(ctx.config);
  // ⚠️ **记下「这一份是不是调用方注入的」**：`acl-inert` 启动期告警的第二个判据就是它
  // （配了 `acl.json` ∧ access 被覆盖 ⇒ 那份文件不会生效）。**记在模块级 `WeakSet` 而不
  // 是 `RuntimeServices` 上加字段** —— 后者是公开面，装配元数据不该进那里（理由见文件
  // 头 `overriddenAccess` 的注释）。必须在**解析出 access 之后**登记，且只在真被覆盖时登记。
  if (overrides.access !== undefined) {
    overriddenAccess.add(overrides.access);
  }
  const window: TrafficWindowSource = { resetHour: () => ctx.config.get("quotaResetHour") };

  if (overrides.traffic !== undefined) {
    // 注入替身 = 这一本账归调用方：不解析默认账本、不建落盘副本、不起定时器
    return Object.freeze({ identity, access, traffic: overrides.traffic, trafficLedger: undefined });
  }

  const resolve = (user: string): UserQuota | undefined =>
    loadUserQuota(user, ctx.config, onFileEvent);
  const traffic = new MemoryTrafficAccount(resolve, window);

  // 落盘副本：窗口口径与判定侧**同一份**（`quotaWindow` + 现读 `quotaResetHour`），
  // 否则恢复出来的用量会算到与判定不同的窗口里。
  const ledger = new JsonlTrafficLedger({
    dir: ctx.config.get("quotaLedgerDir"),
    slot: host.slot,
    flushMs: () => ctx.config.get("quotaFlushInterval"),
    resetHour: () => ctx.config.get("quotaResetHour"),
    windowFor: (user: string): QuotaWindow => quotaWindow(resolve(user)?.window),
    enabled: () => hasConfiguredQuota(ctx.config, onFileEvent),
    onRestore: (restored) => traffic.seed(restored),
    onError: host.onLedgerError,
  });
  // 两步绑定（账本要回注恢复结果给账本的对象 → 先建对象再建账本，最后把账本挂上去）
  traffic.bindSink(ledger);

  return Object.freeze({
    identity,
    access,
    traffic,
    trafficLedger: ledger as TrafficLedgerController,
  });
}
