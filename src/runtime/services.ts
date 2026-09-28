import { createFileAccessControl } from "@/core/access-control.js";
import { createIdentityFromConfig } from "@/core/identity.js";
import type { ConfigAccessor, UserQuota } from "@/config/index.js";
import { loadAuthUsers, loadUserQuota } from "@/config/index.js";
import type { CoreContext } from "@/core/context.js";
import {
  MemoryTrafficAccount,
  quotaWindow,
  type QuotaWindow,
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
 * @description **模块级 `WeakSet` 而不是往 `RuntimeServices` 上加字段**——后者是
 * **公开面**（库调用方 `runtime.services` 拿到的就是它），把「这份 access 是不是替身」的装配
 * 元数据抬成「运行时契约的一部分」等于让调用方开始依赖它；而 WeakSet 的判据是**实例身份**，
 * 与 `services` 那个冻结包**零字段增量**。集合里装的就是注入实例本身，故「同一个替身对象被
 * 两个 runtime 共用」也照样判得出；未覆盖时集合里没有它 → `false`。
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
 * 账号表里是否至少有一个**非 0 的 `quota.bytes`**（= 真配了上限）
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
    if (q !== undefined && q.bytes > 0) {
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
 * 三个成员当前各自被谁用到（免得下一个人以为「传 ctx 是为了现在这三处」）：`ctx.config`
 * **三个默认实现全部**用到；`ctx.logger` 是身份的**缺省观察面**（runtime 路径总给
 * `onFileEvent`，故库调用方直构时才走这条）；`ctx.events` **当前三个默认实现都不直接
 * publish**，且这是刻意的（身份域不自己往 `ctx.events` 注册，ACL 走 `bindAclFileEvents`、
 * 账本错误走 `host.onLedgerError`）——**它在这里是「位置」而不是「当前调用」**：
 * 下一个需要发事件的服务插件不必再回头改这个签名。
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
 * 本模块因此**不自注册 ACL 文件订阅**（那是 `runtime.start()` 的活），对 `access` 只需要
 * `ctx.config`，不必另外拼观察面。
 *
 * **默认 traffic 是内存账本**（读同一份 `users.json` 的 `quota`）：`ProxyOptions.traffic`
 * 未注入时 core 只拿到**显式禁用档**（见 `BaseProxy`），故库调用方经 `services.traffic` 注入的
 * 替身一定是原样生效的。配额解析经 `loadUserQuota` 走账号表**同一条** 1s 节流读取路径
 * （与 `loadUserPolicy` 同一套性能论证：文件 IO 被摊薄到每文件最多 1s 一次 stat）。
 *
 * **窗口口径也在这里注入**：`quotaResetHour` 是 **runtime 相位**字段，故经 `ctx.config`
 * **现读**（闭包每次调用都取一次）——热改 `store` 立即生效、不必重启。时钟源 `Date.now`
 * 保持默认：账本内部只用它算窗口键，且窗口滚动是**惰性**的（每次访问槽位时比对），
 * 故既不需要注入时钟、也不需要任何定时器（见 `core/traffic/memory.ts` 文件头）。
 *
 * **落盘账本只在这里解析，且默认账本与默认内存账本同生共死**：调用方**显式注入**
 * `services.traffic` 时默认账本**一律不建**——替身意味着「这一本账由你管」，我们既不该把它的
 * delta 写进文件、也不该在它上面挂定时器；注入本类构造**零副作用**（只算出一个文件路径，
 * 目录/句柄/定时器全部由 `runtime.start()` 触发的 `ledger.open()` 创建）。
 *
 * **但 `overrides.trafficLedger` 是真注入位，两条分支都读它**（曾经两条都不读、传了等于没传）：
 * - **只注入账本** ⇒ 替身原样生效，且我们 `bindSink` 把它的 `record` 接进默认内存账本 →
 *   「保留内存判定、只换持久化后端」走得通。代价：**放弃重启恢复**（`onRestore → traffic.seed()`
 *   是 `JsonlTrafficLedger` 的构造选项，而那个内存账本是我们内部造的实例、调用方拿不到）。
 * - **`traffic` 与账本都注入** ⇒ 两个都原样生效，生命周期照常，数据接线归调用方（端口上没有
 *   `bindSink`，理由见 `core/traffic/types.ts:TrafficLedger`）。
 *
 * 两种组合都**不发启动期告警**：加第 4 条 `if` 分支已被 `runtime/types.ts:RuntimeWarning` 的注释
 * 裁决否掉（`acl-inert` / `quota-inert` 那批是既成事实，但那条裁决写的是「到第三条就该换机制」）。
 * 代价由上面这段与 `RuntimeServices.trafficLedger` 的注释承担。
 *
 * **返回冻结**（组装期解冻一次比让每个消费点各自小心便宜）、**本函数构造期零副作用**
 * （不 mkdir、不 open、不起定时器、不读文件、不打日志、不读 `process.env`——槽位由
 * `host.slot` 显式传）。
 */
export function buildDefaultServices(
  ctx: CoreContext,
  overrides: Partial<RuntimeServices> = {},
  onFileEvent?: (event: JsonFileEvent) => void,
  host: TrafficLedgerHost = {},
): RuntimeServices {
  const identity: IdentityProvider =
    overrides.identity ?? createIdentityFromConfig(ctx, onFileEvent);
  // 访问控制：只拿 `ctx.config`（观察面由 `bindAclFileEvents` 单独注册，本模块不自注册）。
  const access: AccessControl = overrides.access ?? createFileAccessControl(ctx.config);
  // ⚠️ **记下「这一份是不是调用方注入的」**：`acl-inert` 启动期告警的第二个判据就是它
  // （配了 `acl.json` ∧ access 被覆盖 ⇒ 那份文件不会生效）。记在模块级 `WeakSet` 而不是
  // `RuntimeServices` 上加字段，理由见文件头 `overriddenAccess` 的注释。必须在**解析出
  // access 之后**登记，且只在真被覆盖时登记。
  if (overrides.access !== undefined) {
    overriddenAccess.add(overrides.access);
  }
  const window: TrafficWindowSource = { resetHour: () => ctx.config.get("quotaResetHour") };

  if (overrides.traffic !== undefined) {
    return Object.freeze({
      identity,
      access,
      traffic: overrides.traffic,
      // 调用方接管了这一本账：**默认账本一律不建**。它若也注入了账本，替身**原样生效**，
      // 我们只管替身账本的生命周期（`open`/`close` 照常随 runtime 走）——**数据接线归调用方**：
      // `TrafficAccount` 端口上根本没有 `bindSink`（它是内存实现的具体方法），我们无法给一个
      // 陌生的 traffic 挂 sink；硬挂就得给逐请求端口加一个进程级方法，那条代价写在
      // `core/traffic/types.ts:TrafficLedger`。
      //
      // ⚠️ **这一行曾经根本不读 `overrides.trafficLedger`**：`RuntimeServices` 上有这个字段、
      // TypeScript 因此放行 `services: { trafficLedger: 替身 }`，而本函数从头到尾没碰过它——
      // 于是「传了等于没传」，且**没有任何告警**（`RuntimeWarning` 那条「到第三条就不再加 if 分支」
      // 的裁决在 `runtime/types.ts` 里）。护栏见 `tests/integration/traffic-ledger-runtime.test.ts`。
      trafficLedger: overrides.trafficLedger,
      outboundHeaders: overrides.outboundHeaders, // 出站改写策略：无缺省解析，原样透传
    });
  }

  const resolve = (user: string): UserQuota | undefined =>
    loadUserQuota(user, ctx.config, onFileEvent);
  const traffic = new MemoryTrafficAccount(resolve, window);

  // 落盘副本：窗口口径与判定侧**同一份**（`quotaWindow` + 现读 `quotaResetHour`），
  // 否则恢复出来的用量会算到与判定不同的窗口里。**注入优先**（`??`）：只换持久化后端、保留默认的
  // 内存判定，就是这个注入位存在的全部理由（下面那次 `bindSink` 会把替身接进数据面）。
  //
  // ⚠️ **只注入账本 = 换后端但放弃重启恢复**：`onRestore → traffic.seed()` 那条回灌通路是
  // `JsonlTrafficLedger` 的构造选项，而 `traffic` 是本函数内部造的实例、调用方**拿不到它**，
  // 所以注入进来的账本没有地方把恢复结果种回内存账本。需要重启恢复就把 `traffic` 一起注入，
  // 两个都归你管（见上面那个早返回分支）。
  const ledger =
    overrides.trafficLedger ??
    new JsonlTrafficLedger({
      dir: ctx.config.get("quotaLedgerDir"),
      slot: host.slot,
      flushMs: () => ctx.config.get("quotaFlushInterval"),
      resetHour: () => ctx.config.get("quotaResetHour"),
      windowFor: (user: string): QuotaWindow => quotaWindow(resolve(user)?.window),
      enabled: () => hasConfiguredQuota(ctx.config, onFileEvent),
      onRestore: (restored) => traffic.seed(restored),
      onError: host.onLedgerError,
    });
  // 两步绑定（顺序反过来就得写「用前未赋值」的闭包）。替身也走这一步——**这正是「只注入账本」这条路
  // 走得通的原因**：类型 `TrafficLedger` 在编译期就要求替身把 `record` 做出来（见 `types.ts`）。
  traffic.bindSink(ledger);

  return Object.freeze({
    identity,
    access,
    traffic,
    trafficLedger: ledger,
    outboundHeaders: overrides.outboundHeaders, // 出站改写策略：无缺省解析，原样透传
  });
}
