/**
 * @fileoverview 身份工厂：显式注入的构造器 与 配置驱动的动态门面
 * @module core/identity/factory
 * @description
 * 两个工厂：
 * - `createIdentity(opts, config)`：薄封装 `FileAccountIdentity`，用 `config` 补齐未指定的
 *   `authLogging`；供已持有显式 `ConfigAccessor` 的调用方使用
 * - `createIdentityFromConfig(ctx, onFileEvent?)`：返回一个**动态对象**——每次 `identify` 与
 *   每次 `isOwnCredential` 都**现读** `authEnabled`/`authType`/`jwtSecret`/`authLogging` 与账号
 *   文件（经 mtime 节流热加载），输入**未变**时复用同一份 `FileAccountIdentity` 快照、变了才
 *   重建（记忆表 `liveSnapshots` 按 `ConfigAccessor` 隔离，判据是**输入的身份**、不是时间）。
 *   于是改配置或改 users.json 后下一次请求即生效，无需重建实例
 *
 * 职责：
 * - `createIdentity` / `createIdentityFromConfig` 两个工厂
 * - `defaultJwtVerify` 的**再导出**（从 `./token.js` 转出，让调用方一处 import 拿全）
 *
 * 设计要点：
 * - **三件套是构造期注入，不是逐方法传参**：`isOwnCredential` 跑在**出站头剥离热路径**上
 *   （每个 HTTP 转发请求的每个 `Authorization` 头都要判一次），逐方法传参等于把 DI 成本摊到
 *   全仓最热的路径上；而 `identify` 的 `IdentityContext` 由准入层逐请求构造、本就只装该请求的
 *   事实，把「进程级依赖」塞进去也没有位置。故身份插件**构造期持有** `CoreContext`，热路径上
 *   只多一次属性读。
 * - **⚠️ `ctx` 拿三件套，而文件观察面（发事件那一半）仍由唯一组装点注入**——这个分工刻意
 *   不对称，三件套的三个成员各有归属：
 *   - `ctx.config`：每次判定现读的真相源；
 *   - `ctx.logger`：**缺省观察面**。调用方没给 `onFileEvent` 时用它渲染账号文件的状态迁移
 *     （坏内容 / 消失 / 恢复 / 热加载各一行），于是**身份模块的账号文件出事不只是一件事件**
 *     ——库调用方未必订阅事件，但不订阅也会在自己的日志里看见；
 *   - `ctx.events`：**本模块刻意不直接 publish**，理由见下条。
 * - **⚠️ 文件观察面为什么不塞进 `CoreContext`、也不由本模块自注册**：`CoreContext` 是**只读
 *   三件套视图**，不是**订阅注册表**——把「我要订阅什么」放进一个「我有什么依赖」的对象，等于
 *   让它同时是依赖又是装配指令，两种关注点混成一份（且 `readonly` 视图一旦带注册入口，「只读」
 *   这个保证就在类型上失效了）。而订阅的**生命周期**（`runtime.start()` 建、`runtime.stop()`
 *   摘）由唯一组装点掌握：本模块若自己往 `ctx.events` 注册，就出现**第二个注册点**，后果是
 *   具体的——① 同一次文件迁移发两条 `config.file-error`（一条事实两个来源）；② `stop()` 的
 *   退订清单里没有这一轮，停机后残留监听。身份域与 ACL 域是**两轮**订阅、同一纪律（ACL 那边
 *   的入口是 `access-control.ts:bindAclFileEvents`，同样由 `runtime.start()` 统一装配）。故
 *   观察面经**形参**由 `runtime/services.ts:buildDefaultServices` 注入——那仍是唯一注册点。
 * - **动态门面的「快照」有两处，且职责不同**：① `snap` 那个构造期建的对象**只作 jwtVerify
 *   注入位**（`isEnabled`/`kind`/`isOwnCredential`/`identify` 一次都不经它；创建时即接内置
 *   HS256 校验器 `defaultJwtVerify`，外部注入优先）；② `live()` 按输入现造并**记忆**的那份
 *   才是真正被委派的对象。
 *   这样「热加载」与「注入位稳定」两个诉求各归其位。
 * - **⚠️ 快照是「按输入身份记忆」的，不是「按时间过期」的**：`isOwnCredential` 跑在
 *   **出站头剥离热路径**上，而出站凭证委派已放开到**每个出站头名都问一遍**——于是它从
 *   「每请求 1 次」变成「每请求约 N 次」（N = 出站头数，典型 17）——不记忆化就是每请求 +25 µs
 *   （一次委派一份完整快照）。记忆化把 17 次
 *   里的 16 次变成「比对六个输入后直接复用」，而**六个输入每次都现读、一个都不省**，所以
 *   「热改配置下次请求即生效」逐字不变。**失效判据只有输入身份**：`loadAuthUsers` 内容未变时
 *   返回**同一个**账号数组（`readJsonCached` 节流/未变更/缺失三个分支都回 `cached.value` 或
 *   缺省哨兵），内容变了才给出新对象；`jwtSecret` 之类标量按值比。**刻意零定时器 / 零 TTL /
 *   零轮询**——`core/traffic` 那条「定时器必然引入让出点 → 作废无锁论证」的教训在这里同样成立。
 * - **`isOwnCredential` 与 `identify` 共用同一个 live 构造闭包**：两者读的是**同一份**
 *   `authEnabled`/`authType`/`jwtSecret`/账号表。若判据读一份、识别读另一份，就会重演
 *   「凭证泄漏」的老问题（能过鉴权的凭证没被剥）。
 * - **core 零日志**：鉴权审计经 `IdentityContext.onAuthEvent` 上抛，本模块不直接写日志；账号
 *   文件那几行来自上面那个**缺省观察面**，写的是**注入的** `ctx.logger`，不碰全局 logger。
 *
 * 零副作用（`createIdentityFromConfig(ctx)` 构造期只做四件事：读三个配置键、建 `snap`、建
 * `live` 闭包、返回对象）：**不读文件、不起定时器、不注册任何订阅（含 `EventHub`）、不打日志、
 * 不碰 `process`**。记忆表 `liveSnapshots` 是**模块加载期**建的一个空 `WeakMap`（与
 * `access-control.ts` 的三张表同款），构造期既不读它也不写它。
 * `createJsonFileEventHandler(ctx.logger)` 是**纯建 handler**（只返回一个闭包，
 * 零 I/O、零注册），故构造期调用它不破这条铁律。
 *
 * 不负责：装配观察面（`runtime/services.ts`）、公共事件名与载荷
 * （`runtime/runtime.ts:fileEventHandler` 是那份映射的唯一实现）。
 *
 * 使用示例：
 * ```ts
 * import { createIdentity, createIdentityFromConfig } from "@/core/identity/factory.js";
 *
 * // 显式注入：只补一个 authLogging，故收 ConfigAccessor 而不是整个 ctx
 * const id = createIdentity({ enabled: true, type: "basic", accounts }, config);
 * // 配置驱动（runtime/CLI 内部用法）：三件套整体注入，观察面由组装点注入
 * const live = createIdentityFromConfig(ctx, fileEventHandler);
 * ```
 */

import {
  createJsonFileEventHandler,
  loadAuthUsers,
  type AuthAccount,
  type ConfigAccessor,
} from "@/config/index.js";
import type { CoreContext } from "@/core/context.js";
import type { JsonFileEvent } from "@/utils/json-file/index.js";
import type { IdentityContext, IdentityOptions, IdentityProvider } from "@/core/types/identity.js";
import { FileAccountIdentity } from "./file-account.js";
import { defaultJwtVerify } from "./token.js";

export { defaultJwtVerify } from "./token.js";

/**
 * 创建身份提供者（工厂函数）
 * @description `FileAccountIdentity` 的薄工厂封装，便于按端口编程与测试时替换；
 * 用 `config` 补齐未指定的 `authLogging`（`enableLogging` 优先）
 *
 * **刻意仍收 `ConfigAccessor` 而不是 `CoreContext`**：本工厂只读**一个**配置键、不读文件、
 * **没有任何观察面**。给一个只碰 `config` 的端口递整个三件套，会让签名谎报它需要 logger 与
 * events——core 内「端口只声明真实需要」是纪律（`resolveRoute(dest, config)` 同理），
 * `createIdentityFromConfig` 才是那个真的三件套消费者。
 * @param opts - 身份选项，必须显式提供
 * @param config - 配置访问器，必须显式注入
 * @returns `IdentityProvider` 实例（实际为 `FileAccountIdentity`）
 * @example const id = createIdentity({ enabled: true, type: "basic", accounts: [{ username: "alice", password: "pw1" }] }, config);
 */
export function createIdentity(opts: IdentityOptions, config: ConfigAccessor): IdentityProvider {
  return new FileAccountIdentity({
    ...opts,
    enableLogging: opts.enableLogging ?? config.get("authLogging"),
  });
}

/**
 * 一份「输入 → 快照」的判定产物（`live()` 记忆表的值）
 * @description
 * 六个输入字段**逐字对应** `live()` 每次现读的那六样，**外加**造出来的快照本身。
 * 字段分成两类，判据因此也只有两类，二者都**不是时间**：
 * - **对象身份**（`accounts` / `jwtVerify`）：`loadAuthUsers` 在**内容未变**时返回**同一个**
 *   账号数组（`readJsonCached` 的节流命中 / 未变更 / 缺失三个分支都直接回 `cached.value` 或
 *   缺省哨兵 `EMPTY_ACCOUNTS`），内容变了才 `JSON.parse` 出一个**新数组**；`jwtVerify` 是注入位
 *   上的函数引用，注入即换引用。故「对象身份变了」精确等价于「输入变了」。
 * - **原始值**（`enabled` / `type` / `jwtSecret` / `enableLogging`）：标量没有身份可言，
 *   值相等即输入未变。
 */
interface LiveSnapshot {
  /** 现读到的账号表快照（`loadAuthUsers` 的返回对象，判据按**身份**比） */
  readonly accounts: AuthAccount[];
  /** 现读到的 `authEnabled` */
  readonly enabled: boolean;
  /** 现读到的 `authType` */
  readonly type: IdentityOptions["type"];
  /** 现读到的 `jwtSecret` */
  readonly jwtSecret: string;
  /** 现读到的 `authLogging` */
  readonly enableLogging: boolean;
  /** 注入位上当前的 `jwtVerify` 引用（判据按**身份**比，故外部注入后立即失效重建） */
  readonly jwtVerify: IdentityOptions["jwtVerify"];
  /** 由上面六样造出来的那份 `FileAccountIdentity` 快照 */
  readonly snapshot: FileAccountIdentity;
}

/**
 * `live()` 的记忆表：**按 `ConfigAccessor` 隔离**，输入未变即复用同一份快照
 * @description
 * 形态与 `core/access-control.ts:compiledCaches` 的编译缓存**逐字同构**（外层按 accessor
 * 隔离、内层按源对象身份判失效），理由与正确性论证也同源：
 * - **为什么按 accessor 而不是模块级单槽**：`credentials.ts:indexMemo` 那种单槽在两个
 *   accessor 交替判定时会互相挤掉；`compiledCaches` 已经在这个仓里证明过「按 accessor 分槽」
 *   才是隔离的正解。WeakMap 让条目随 accessor 一起被回收，不留悬垂引用。
 * - **为什么不需要定时器 / TTL / 轮询**：失效判据是**输入的身份**，输入没变就没有任何东西
 *   需要观察。本仓对 `core/traffic` 立过一条铁律「定时器必然引入让出点 → 作废无锁论证」，
 *   同一条教训在这里适用：这里要判的不是「时间过了没有」，而是「`readJsonCached` 有没有给出
 *   一份新对象」——那件事只可能由**下一次读取**发现，而下一次读取就在下一次判定里，于是
 *   「每次判定现读 → 变了就重建」本身就是完备的，不需要任何后台任务。
 * - **零副作用铁律不受影响**：本表是**模块加载期**建的一个空 WeakMap（`access-control.ts`
 *   的三张表同款），`createIdentityFromConfig` 的**构造期**不写它、不读它 —— 构造期仍然只做
 *   「读三个配置键、建两个闭包、返回一个对象」，不读文件、不起定时器、不注册订阅、不打日志、
 *   不碰 `process`。
 */
const liveSnapshots = new WeakMap<ConfigAccessor, LiveSnapshot>();

/**
 * 从配置创建身份提供者（动态版，热加载）
 * @description
 * 每次 `identify()` **与每次 `isOwnCredential()`** 都重读 `ctx.config` 的
 * `authEnabled`/`authType`/`jwtSecret`/`authLogging` 与账号文件（账号文件经 mtime 节流
 * 热加载），改配置或改 users.json 后下一次请求即生效，无需重建实例。
 *
 * **六个输入每次都现读、一个都不省**；省掉任何一样都会让上面那条「热改即生效」退化成
 * 「要重建实例才生效」。读完才去问记忆表 `liveSnapshots`（按 `ConfigAccessor` 隔离）：
 * 输入**逐项未变**就复用上一份快照，变了才 `new` 一份。判据是**输入的身份**
 * （账号数组对象身份 + 四个标量值 + 注入位上的 `jwtVerify` 引用），**不是时间** ——
 * 零定时器 / 零 TTL / 零轮询，理由见 `LiveSnapshot` 与文件头。
 *
 * 因此两层记忆叠在一起，热路径上不重建任何 Map 也不重建任何实例：
 * ① 凭证索引按**账号快照对象身份**记忆（`helpers/credentials:credentialIndexesFor`）
 * ② 身份快照按**六个输入的身份**记忆（本文件的 `liveSnapshots`）
 *
 * `jwtVerify` 注入位在创建时即接内置 HS256 校验器 `defaultJwtVerify`（生产链路无需外部
 * 注入），外部经 `provider.jwtVerify` setter 注入的实现覆盖快照——显式注入优先。注入位也
 * **进了记忆表的判据**（按函数引用比），故注入后下一次判定即生效，不必等另一样输入变化。
 *
 * **构造期零副作用**：不读文件、不起定时器、不注册任何订阅、不打日志、不碰 `process`。
 * @param ctx - 公共三件套（配置读取 / 日志 / 事件总线），构造期持有；`isOwnCredential` 在
 *   出站头剥离热路径上逐请求调用，故走构造注入而非逐方法传参
 * @param onFileEvent - 账号文件变更观察面（**由唯一组装点注入**：`runtime/services.ts`
 *   转发公共 `config.file-error`/`file-recovered`/`file-reloaded`）。省略时本模块用
 *   `ctx.logger` 自建缺省观察面（只有日志、没有事件）
 * @returns `IdentityProvider` 实例（动态代理）
 * @example const id = createIdentityFromConfig(ctx, fileEventHandler); // runtime 内部用法
 * @example const id = createIdentityFromConfig(ctx); // 库调用方：账号文件出问题有日志、无事件
 */
export function createIdentityFromConfig(
  ctx: CoreContext,
  onFileEvent?: (event: JsonFileEvent) => void,
): IdentityProvider {
  const config = ctx.config;
  // ⚠️ 这个 `snap` **只作 jwtVerify 注入位**，与 `live()` 造的那份被委派的快照是**两回事**：
  // isEnabled/kind/isOwnCredential/identify 一次都不经它（判据全走 `live()`）；它的三个配置键
  // 字段（同源事实）只是为了形状完整，真正被读的只有 `jwtVerify` 这一个 public 字段。
  // 注入位默认接内置 HS256 校验器：不接的话 matchJwtToken 恒抛错、AUTH_TYPE=jwt 生产恒 deny
  const snap = new FileAccountIdentity({
    enabled: config.get("authEnabled"),
    type: config.get("authType"),
    jwtSecret: config.get("jwtSecret"),
    jwtVerify: defaultJwtVerify,
  });

  // 缺省观察面：调用方没给 onFileEvent 时，用注入的 logger 渲染账号文件的状态迁移
  // （坏内容 / 消失 / 恢复 / 热加载各一行）。纯建 handler——只返回一个闭包，零 I/O、零注册，
  // 故构造期调用它不违反「core 构造期零副作用」。
  //
  // ⚠️ 调用方给了 onFileEvent 就**原样透传、绝不包一层**。这看着像可以省的样板，实际是正确性
  // 问题：`readJsonCached` 的事件去重状态按 **onEvent 回调身份**隔离
  // （`utils/json-file/subscriber.ts` 的 `WeakMap<回调, Map<键, 状态>>`），包一层等于给同一份
  // users.json 多挂一个订阅者 → 每次状态迁移**报两次**：组装点的 fileEventHandler 自己也会渲染
  // 一遍，于是 `[config] 用户账号文件 读取失败…` 这类日志行与 config.file-* 事件全部翻倍。
  // live() 每个请求都跑，故这个回调身份必须是**构造期唯一一个**。
  const observeFileEvent = onFileEvent ?? createJsonFileEventHandler(ctx.logger);

  // 每次判定现造一份 live 快照：`isOwnCredential` 与 `identify` **共用这一个闭包**，
  // 保证「能过鉴权的凭证」与「出站会被剥掉的凭证」读的是同一份 authEnabled/authType/
  // jwtSecret/账号表——两者读两份真相就是凭证泄漏的根源
  //
  // ⚠️ 「每次判定现造」指的是**每次判定都现读输入**，不是「每次判定都 new 一个实例」：
  // 六个输入逐字现读（一个都不少，`config.get` 与 `loadAuthUsers` 每次都调）之后才去问记忆表，
  // 输入与上一份**逐项相同**就直接复用上一份快照。这不是「缓存判定结果」，而是「省掉重复的
  // 快照构造」——判定本身每次都照跑，快照里没有一毫秒级的过期时间。
  //
  // 为什么会成为性能问题（实测，17 头典型请求、扣掉 harness 基线）：出站凭证委派已放开到
  // **每个出站头名都问**一次（`helpers/headers.ts:isStrippableOutboundHeader`），于是
  // `isOwnCredential` 的调用次数从「每请求 1 次」变成「每请求约 N 次」（N = 出站头数，典型 17），
  // 而每次委派都要一份完整快照 —— 内置四插件只被调 1 次所以看不出来，而 CLI 与
  // `createProxyRuntime` 走的就是这条配置驱动动态门面，17 次就
  // 把「每调用一份完整快照」放大成每请求 +25 µs。记忆化之后那 17 次里只有**第一次**真的构造。
  const live = (): FileAccountIdentity => {
    // ① 现读输入。**六样一个都不许省**：省掉任何一样都会让「热改配置 / 改 users.json /
    // 外部换注入的 jwtVerify」这条能力退化成「要重建实例才生效」，而那正是动态门面的存在理由。
    // 读在**记忆判定之前**，于是 `loadAuthUsers` 抛错时抛错时机与形态逐字不变（异常语义不变）。
    const enabled = config.get("authEnabled") as boolean;
    const type = config.get("authType") as IdentityOptions["type"];
    const accounts = loadAuthUsers(config, observeFileEvent);
    const jwtSecret = config.get("jwtSecret") as string;
    const enableLogging = config.get("authLogging") as boolean;
    const jwtVerify = snap.jwtVerify;

    // ② 按「输入的身份」判失效（不是按时间）：对象身份 + 原始值，见 `LiveSnapshot` 的说明。
    //    六项全中才复用 —— 少比一项就是一处能悄悄失效的热加载。
    const memo = liveSnapshots.get(config);
    if (
      memo !== undefined &&
      memo.accounts === accounts &&
      memo.enabled === enabled &&
      memo.type === type &&
      memo.jwtSecret === jwtSecret &&
      memo.enableLogging === enableLogging &&
      memo.jwtVerify === jwtVerify
    ) {
      return memo.snapshot;
    }

    // ③ 输入变了（或首次）→ 造一份新快照并记进表。只读共享、跨会话并发安全（Node 单线程、
    //    这里没有 await 点），与 `compiledCaches` 的并发论证同一条。
    const snapshot = new FileAccountIdentity({
      enabled,
      type,
      accounts,
      jwtSecret,
      jwtVerify,
      enableLogging,
    });
    liveSnapshots.set(config, {
      accounts,
      enabled,
      type,
      jwtSecret,
      enableLogging,
      jwtVerify,
      snapshot,
    });
    return snapshot;
  };

  // 交叉类型带上 jwtVerify：既保留 IdentityProvider 的形状校验（getter 拼错会报错），
  // 又让注入位的 getter/setter 全程有类型（相对 Object.defineProperty 的 any 描述符）
  const dynamic: IdentityProvider & { jwtVerify?: IdentityOptions["jwtVerify"] } = {
    get kind() {
      return config.get("authType") as string;
    },
    get isEnabled() {
      // 端口口径「本实例会不会拒绝任何人」：`none` 已并进 FileAccountIdentity.isEnabled，
      // 这里**只读它一个字段**。调用方（曾见 core/server/socks-session.ts:151）自己再判一次
      // `kind !== "none"` 就是把同一个事实抄成第二份真相——漏改不会红，只会让 none 模式在
      // 某个消费点上表现与 isEnabled 不一致
      return live().isEnabled;
    },
    // 透传快照的 jwtVerify getter/setter，以便外部注入后动态生效
    get jwtVerify() {
      return snap.jwtVerify;
    },
    set jwtVerify(v: IdentityOptions["jwtVerify"]) {
      snap.jwtVerify = v;
    },
    // 出站凭证判据同样现读（不吃快照）：改 AUTH_TYPE / JWT_SECRET 后，剥离判据与识别同步生效
    isOwnCredential(name: string, value: string): boolean {
      return live().isOwnCredential(name, value);
    },
    // 形参刻意叫 `identityCtx` 而非 `ctx`：全仓 `ctx` 一律指 `CoreContext`（本工厂已构造期持有
    // 一个），同名会遮蔽它——写 `ctx.config` 时拿到的是 `IdentityContext`，而 tsc 未必立刻报错
    // 每次判定都重读访问器与账号文件（输入没变时复用同一份快照，见上面的 `live()`）；jwtVerify
    // 沿用注入位的当前值（默认内置 defaultJwtVerify，显式注入优先）
    async identify(identityCtx: IdentityContext) {
      return live().identify(identityCtx);
    },
  };
  return dynamic;
}
