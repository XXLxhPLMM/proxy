/**
 * @fileoverview 流量配额的内存实现（进程内账本，不落盘）
 * @module core/traffic/memory
 * @description
 * `TrafficAccount` 的默认实现：`Map<user, {windowKey, up, down}>`，单线程无锁。
 *
 * ## 窗口化：每用户槽位带一个窗口键，**滚动即清账**
 *
 * 槽位形如 `Map<user, {windowKey, up, down}>`：进入
 * `consume` / `usage` 时算一次当前窗口键，与槽位里的比对，**不同即用量清零并换键**。
 * （用量**只增不减**的形态在窗口语义确定之前是对的：先把「真用量」这件事做对。）
 *
 * **为什么是「惰性滚动」而不是定时器清账**：
 * - 账本是**纯内存**的，而 `consume` 是**同步**函数（无锁论证见下）。要在一个同步函数里
 *   「到点就清」就必须引入定时器/微任务，那会同时破坏两件事：① 无锁论证（引入让出点）
 *   ② 「没有后台任务」的干净性（进程退出时还要清理、停机时要摘、定时器还要 unref）。
 * - 清账的真实需求只是「**跨过边界后别拿旧账当新账**」，而这件事在**每次访问槽位时**判
 *   一次就完备了：没人访问的槽位清不清账在语义上不可观测（`usage` 一读就现算）。
 * - 于是窗口滚动的全部成本 = 每次 `consume` 多一次字符串比较与（跨窗时）一次写 Map，
 *   零定时器、零后台任务、零停机清理。
 *
 * **已用量绝不跨窗口继承**（裁决）：继承等于白送「等窗口翻页」的重叠额度——用户只要卡在
 * 边界前用满，等窗口一翻就又能用满一份，配额立刻失去意义。故跨窗是一律清零。
 *
 * ## 为什么无锁是安全的（不是「图省事」）
 *
 * `consume` 是**同步函数**（签名里没有 `Promise`，实现体内没有任何 `await`），而 Node 的
 * JS 回调永远跑在**同一个线程**的事件循环上。一次 `consume` 从「读 Map」到「写回累计值」
 * 到「比较上限」到「返回 verdict」之间**没有任何 await 点**，因此不可能在中间被另一个
 * `consume` 插入——不存在「读-改-写」被打断的交错窗口，也就不需要锁、也不存在
 * 「两个请求同时判定为未超限」的竞态。**惰性滚动没有改变这条论证**：窗口比对与清零
 * 同样在这段无 await 的同步区间内完成，「滚动 + 累加 + 判定」整体仍是原子的。
 *
 * 反过来说：如果哪天有人把 `consume` 改成 `async`（例如为了「顺便把账本落盘」而引入 IO），
 * 这条论证**立即失效**——交错窗口会出现，账本会少算。届时必须先补一把互斥（单进程内
 * 最小改动是改成「入队 + 微任务串行」），而不是继续依赖单线程。本文件因此把
 * 「`consume` 必须同步」写进类型与断言（护栏见 `tests/unit/traffic-account.test.ts`），
 * 并把「**不许为窗口滚动引入任何定时器**」一并锁进源码级断言——否则下一个来的人会
 * 很自然地想「起个 setInterval 清账吧」，那正好把无锁论证作废。
 *
 * **5b-2 的落盘没有破坏这条论证**（这正是本切片的核心约束）：`consume` 只往一个内存数组
 * 追加一条 delta，真正的 IO 在**账本自己的后台 flush** 里，于是 `consume` 的同步区间内
 * 仍然一个 `await` 都没有。落盘的定时器住在 `./flush-loop.ts`（全切片唯一的 `setTimeout`
 * 站点），账本 IO 住在 `./ledger.ts`——**两者都不在本文件里**，所以「本文件零 async/零
 * await/零定时器」那条护栏到 5b-2 依然是原话。
 *
 * ## 判定语义（裁决，不许在调用点各自解释）
 *
 * - 判定顺序固定 `bytesUp` → `bytesDown` → `bytesTotal`，**任一突破即拒**。
 * - **推论（必须知道）：「任一突破即拒」= 账号级封禁，不是单方向限流**。`bytesUp` 撞顶后，
 *   该用户的 `consume(..., "down", ...)` 同样返回 `allow:false`（归因仍报 `up`，因为那才是被
 *   突破的上限）。这是刻意的：若只封那一个方向，用户可以上传撞顶后改走下载继续白嫖。
 *   代价是**硬切之后该账号在当前窗口内彻底不可用**（跨过窗口边界后自动恢复）。
 * - **`usage` 与 `limit` 恒取同一个 scope 的两个数**（`total` 被突破时 `usage` 是总量），
 *   消费方据此能直接算出「超了多少」；报成别的 scope 的数会让那个减法静默给出错误答案。
 * - **`dir` 与 `scope` 可以不同**（本次流动 down、被突破的是 up）：`dir` 是本次流动方向，
 *   `scope` 是被突破的上限，两者都是如实事实，不许互相反推（见 `meter.ts` 的 `QuotaExceededHandler`）。
 * - **恰好等于上限放行**（`<=` 语义）：`bytesTotal: 100` 允许用户用满 100 字节。
 *   理由：配额是**上限**而不是「额度 + 1 的坑」；按 `>` 判定时，运维写
 *   `bytesTotal: 1073741824`（1GiB）得到的是「1GiB 减一个字节都传不完」，这是最难自查的
 *   off-by-one。反过来若用 `>=`，用户永远差一个字节用不完，行为同样反直觉。
 *   故判据是「累计值 **>** 上限才拒」。
 * - 0 = 该上限不生效；三个子字段全 0 / 未配 `quota` / 用户不存在 → **恒 allow**。
 *   这条是**显式分支**（`quota === undefined` 直接返回放行），不是「默认上限 0 恰好放行」
 *   的蒙混——护栏对此有独立断言。
 * - **未配配额也照常累加 usage**：「没有上限」≠「不计量」。唯一「不计量」的情形是**没有身份**
 *   （`meterStream` 一个监听器都不挂，见 `meter.ts`）。这样 `usage` 恒为真用量，将来给某个
 *   账号加上限即刻按真账判定，而不是给他一个「从 0 开始」的假象。
 * - 超限时**累计值照实累加**（不截断到上限）：账本是「真实用量」，日志里看到的 `usage`
 *   必须是真的，否则运维看到的数字是假的。
 *
 * ## 已知限制（记在这里免得被当成「没想过」）
 *
 * 账本是**纯内存、无淘汰**的 `Map`，槽位数 = 曾计量过的用户数。`users.json` 固定规模时天然
 * 有界；窗口滚动**只清用量、不删槽位**（删了就等于「清账」变成「除名」，两者语义不同）。
 * 但 `authType=jwt` 的 `sub` 由外部签发，理论上可产生任意多用户名 → 槽位单调增长。
 *
 * **落盘压缩解决了这条限制的「持久」那一半，未解决的那一半如实记在这里**：
 * - **已解决**：落盘账本（`./ledger.ts`）在**压缩**时按 `(用户, 窗口键)` 求和并**丢弃已过期
 *   窗口的条目**（`compactEntries`），所以「28 个 `sub` 跨 28 天」在压缩后文件行数降到 0，
 *   重启恢复时这些过期槽位**根本不会回到内存**。也就是说**磁盘上的账本是有界的**
 *   （阈值 8MiB，见 `DEFAULT_LEDGER_COMPACT_BYTES`），这才是真正会无界增长的那一份。
 * - **未解决**：**同一个长跑进程内**的内存 `Map` 仍不淘汰（本文件零 `.delete(` 仍是护栏）。
 *   换句话说要彻底解决需要重启一次进程——**这是自觉的取舍**：进程内淘汰必须先定义
 *   「被淘汰的用户拿到一份清零的账 = 凭空多出一份额度」的语义，而那属于配额窗口的设计
 *   （见文件头「为什么不加 LRU」）。跨重启的持久增长才是本切片认领的那一半。
 *
 * **刻意不加 LRU 之类的猜测性淘汰**：淘汰策略必须与配额窗口一起设计，否则会出现
 * 「配额还没过期、账本先被淘汰」这种比不淘汰更糟的行为——被淘汰的用户会拿到一份
 * 清零的账，等于凭空多出一份额度。护栏（`tests/unit/traffic-window.test.ts`）锁死
 * 「本文件不删槽位」：谁想加淘汰，必须先在那个文件里改掉这条护栏并说明淘汰语义。
 *
 * ## 落盘注入口：`consume` 仍同步，IO 全在账本侧
 *
 * `bindSink` 挂上来之后，`consume` 在累加完计数后会多一行 `this.sink?.record(...)`。它
 * **只是往内存数组 push 一下**（`TrafficSink.record` 是同步端口，无 Promise、无 IO），
 * 写盘由 `./ledger.ts` 的后台 flush 负责。三条性质因此全部保持：
 * ① `consume` 仍是**同步函数**（无 `async`/`await`，无 Promise 返回值）→ 上面那条无锁论证
 * 分毫未动；② `consume` 的**耗时与磁盘无关**（磁盘满 / 目录不可写都不影响判定与放行）；
 * ③ `consume` **绝不因账本失败而抛错**——写盘失败的可见形态是账本自己发的那条事件与
 * error 日志（`TrafficLedgerError`），不是代理拒服务。
 *
 * `seed(restored)` 是恢复期的**唯一**写入口（`runtime.start()` 里调一次），见该方法注释。
 */

import type { QuotaWindow } from "./window.js";
import { quotaWindow, windowKey } from "./window.js";
import type {
  QuotaResolver,
  RestoredLedger,
  TrafficAccount,
  TrafficDirection,
  TrafficSink,
  TrafficUsage,
  TrafficVerdict,
} from "./types.js";

/** 未超限时的常量判定结果（共享单例：放行是绝大多数路径，别为它分配对象）。 */
const ALLOW: TrafficVerdict = Object.freeze({ allow: true });

/** 零用量常量（未知用户返回它，省一次分配）。 */
const ZERO_USAGE: TrafficUsage = Object.freeze({ up: 0, down: 0 });

/** 判定顺序与 scope 的一一对应：数组下标即判定顺序，禁止调换。 */
const SCOPES = ["up", "down", "total"] as const;

/**
 * 窗口口径的注入口（**由装配点解析**，本类不读配置、不读文件）
 * @description
 * - `resetHour`：窗口重置小时（本地时区 0..23），即 `QUOTA_RESET_HOUR`。**每次访问现调**，
 *   沿用本仓对 runtime 相位字段的既有约定（`logLevel` / `upstreamTimeout` 等同样现读），
 *   故热改 `store` 立即生效、不必重启。
 * - `now`：时钟源，**可注入且缺省为墙钟**。窗口边界是这类代码里最容易写错的地方，
 *   靠真实时钟只能写出「今天大概对」这种测不出回归的用例；生产路径不需要注入它
 *   （账本只用它算窗口键，且窗口滚动是**惰性**的，见文件头），故做成可选。
 */
export interface TrafficWindowSource {
  /** 当前窗口重置小时（本地时区 0..23）。 */
  resetHour(): number;
  /** 当前时刻（毫秒时间戳）；省略即墙钟 `Date.now()`。 */
  now?(): number;
}

/** 墙钟：模块级单例（`now` 可选，故需要一个稳定的缺省实现）。 */
const wallClock = (): number => Date.now();

/**
 * 省略注入口时的窗口口径：`QUOTA_RESET_HOUR` 的缺省（午夜 0 点）+ 墙钟
 * @description 唯一组装点 `runtime/services.ts` **总是**注入真实 accessor 派生的 `resetHour`；
 * 这份缺省只服务「直构本类、不经 runtime」的低层调用方与单测，它的取值与 FIELDS 的
 * `def` 缺省逐字一致（`defaults.quotaResetHour === 0`），不是另造的一套默认值。
 */
const DEFAULT_WINDOW: TrafficWindowSource = { resetHour: () => 0, now: wallClock };

/** 单个用户在**当前窗口**内的槽位：`windowKey` 不同即视为新窗口（用量归零）。 */
interface Counters {
  windowKey: string;
  up: number;
  down: number;
}

/**
 * 内存账本实现
 * @description 状态只有 `Map<user, {windowKey,up,down}>`；配额来自注入的 `QuotaResolver`
 * （装配点持有 `ConfigAccessor` 与文件事件观察面），窗口口径来自注入的
 * `TrafficWindowSource`；本类不读配置、不读文件、不打日志。
 */
export class MemoryTrafficAccount implements TrafficAccount {
  private readonly totals = new Map<string, Counters>();

  /** 时钟源：`window.now` 缺省即墙钟（在构造期归一，不在热路径上反复判 undefined）。 */
  private readonly clock: () => number;

  /**
   * 落盘注入口（可后绑定，见 {@link bindSink}）
   * @description
   * **刻意留成可后绑定而不是构造期必填**：账本需要在**装配点**（`runtime/services.ts`）与
   * 端口 resolver 一起组装，而它自己又要把恢复结果回注给本对象（`seed`）。先建账本再建
   * 账本要的对象会把闭包写成「用前未赋值」，后绑定是这件事唯一诚实的形状。
   *
   * 未绑定 = **不落盘**（单测与「不注入账本」的低层调用方就是这个形态）：判定语义完全
   * 不变，`consume` 依然同步，账本缺席只是「重启后不恢复」。
   */
  private sink: TrafficSink | undefined;

  /**
   * @param resolve - 配额解析端口（**每次 consume 现调**，走 1s 节流缓存，与
   *   `loadUserPolicy` 同一套性能论证：文件读取被 `readJsonCached` 摊薄到每文件最多 1s 一次 stat）
   * @param window - 窗口口径注入口（缺省 = 午夜重置 + 墙钟，见 `DEFAULT_WINDOW`）
   */
  public constructor(
    private readonly resolve: QuotaResolver,
    private readonly window: TrafficWindowSource = DEFAULT_WINDOW,
  ) {
    this.clock = window.now ?? wallClock;
  }

  /**
   * 绑定落盘注入口（装配点用；`TrafficAccount` 端口**刻意不含**这个方法）
   * @description
   * 不在端口上的理由同 `MemoryTrafficAccount.size`：端口是「用量与判定」的契约，
   * 「把这本账写到哪去」是装配决策，混进端口会让每个替身都被迫实现两个与判定无关的方法。
   * 绑定后**立即生效**：`consume` 之后新产生的字节全部进落盘队列。
   */
  public bindSink(sink: TrafficSink): void {
    this.sink = sink;
  }

  /**
   * 把落盘账本恢复出来的用量播种进槽位
   * @description
   * 只在 `runtime.start()` 里调一次（账本 `open()` 完成之后、`core.start()` 之前），
   * 保证「恢复完成」早于「开始收流量」。
   *
   * **为什么是 `set` 而不是「与既有值相加」**：这是重启恢复的语义——磁盘上的账本就是
   * 全部真相，本对象此刻也**还没有**任何本次进程的新计数。写成相加会出现「同一批字节
   * 被算两次」（同一次 run 里 `start → stop → start` 就会触发）。
   *
   * **仍然交给惰性滚动兜一道**：写入的 `windowKey` 可能是**读取那一刻之前**的窗口（停机
   * 期间跨过了边界），`slotFor` 的键比对会把这份旧账清零——那条既有路径因此同时是
   * 「恢复数据过期」的唯一处理点，本方法不需要（也不该）自己判窗口。
   *
   * **零淘汰不变式不受影响**：本方法只 `set`、从**不** `delete`（见文件头「已知限制」）。
   * 过期窗口的槽位是在**账本文件的压缩**里消失的（`./ledger.ts:compactEntries`），恢复时
   * 因此根本不会读到它们。
   */
  public seed(restored: RestoredLedger): void {
    for (const [user, usage] of restored) {
      this.totals.set(user, {
        windowKey: usage.windowKey,
        up: usage.up,
        down: usage.down,
      });
    }
  }

  /**
   * 账本槽位数（= 曾计量过的用户数）
   * @description 只读观测口径，供「账本规模有界」护栏与 5b-2 的落盘压缩使用；
   * **刻意不进 `TrafficAccount` 端口**——端口是「用量与判定」的契约，规模诊断不是它的语义。
   */
  public get size(): number {
    return this.totals.size;
  }

  public consume(user: string, dir: TrafficDirection, bytes: number): TrafficVerdict {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return ALLOW;
    }

    // 配额现读（users.json 既有 1s 节流路径）；未配 / 用户不存在 → 窗口取缺省 month，
    // 仍照常计量（见文件头「没有上限 ≠ 不计量」）。
    // 时刻只取一次：窗口键与落盘 delta 的 `ts` **必须是同一个时刻**，否则同一批字节会被
    // 判定分到窗口 A、却按窗口 B 落盘（重启恢复后用量就错了）。
    const now = this.clock();
    const quota = this.resolve(user);
    const current = this.slotFor(user, quotaWindow(quota?.window), now);

    if (dir === "up") {
      current.up += bytes;
    } else {
      current.down += bytes;
    }

    // 落盘队列：**同步入队**（`TrafficSink.record` 是纯数组 push，无 Promise、无 IO），
    // 真正的写盘由账本自己的后台 flush 负责 —— consume 的同步性因此分毫未动。
    this.sink?.record(user, dir, bytes, now);

    // 配额未配 / 用户不存在 / 文件读不到有效内容 → 恒 allow（显式分支，见文件头裁决）
    if (quota === undefined) {
      return ALLOW;
    }

    // 判定顺序：bytesUp → bytesDown → bytesTotal（数组下标即顺序，改这里必须同步改测试）
    const observed: readonly number[] = [current.up, current.down, current.up + current.down];
    const limits: readonly number[] = [quota.bytesUp, quota.bytesDown, quota.bytesTotal];
    for (let i = 0; i < SCOPES.length; i++) {
      const limit = limits[i];
      if (limit > 0 && observed[i] > limit) {
        return { allow: false, reason: "quota", scope: SCOPES[i], usage: observed[i], limit };
      }
    }

    return ALLOW;
  }

  public usage(user: string): TrafficUsage {
    const quota = this.resolve(user);
    // 从未计量过的用户：**不建槽**。读一次不该凭空长出一个槽位（规模有界性的一部分）
    if (!this.totals.has(user)) {
      return ZERO_USAGE;
    }
    // 已计量过 → 同样比对窗口键：跨窗即清零，故这里可能返回零
    const current = this.slotFor(user, quotaWindow(quota?.window), this.clock());
    return { up: current.up, down: current.down };
  }

  /**
   * 取该用户**当前窗口**的槽位，必要时惰性滚动（清零 + 换键）
   * @description
   * 这是 5a 欠下的「窗口过期清账」的全部实现，**没有第二个机制**：
   * 键相同 → 原样返回既有槽位（不写 Map）；键不同 → 建一个零用量槽位替换掉。
   * 刻意**不删槽位**：清账 ≠ 除名，删槽会让「用户是否存在过用量」这个事实丢失，
   * 也会让「反复读一个未知用户」变成无限增长。
   *
   * @param now - 与 `consume` 记录到落盘队列的是**同一个时刻**（见 `consume` 注释）
   */
  private slotFor(user: string, window: QuotaWindow, now: number): Counters {
    const key = windowKey(now, window, this.window.resetHour());
    const current = this.totals.get(user);
    if (current !== undefined && current.windowKey === key) {
      return current;
    }
    const fresh: Counters = { windowKey: key, up: 0, down: 0 };
    this.totals.set(user, fresh);
    return fresh;
  }
}

/** 造一个内存账本（装配点用；单测也用它 + 一个闭包当 `QuotaResolver` 替身）。 */
export function createMemoryTrafficAccount(
  resolve: QuotaResolver,
  window?: TrafficWindowSource,
): TrafficAccount {
  return new MemoryTrafficAccount(resolve, window);
}

/**
 * 显式**禁用档**（null object）：不计量、不判定、恒放行
 * @description
 * 与 `BaseProxy` 里 `auth ?? new Auth({ enabled: false })` **完全同构**的既有先例：
 * 「服务被直构、没注入这个服务」有一个语义明确的正确答案——计量关掉——而不是让
 * 「忘注入」变成运行期怪问题。它**不是**「默认的内存实现」：内存实现（读 users.json 的
 * 真实配额）只在唯一组装点 `createProxyRuntime` 里解析，见 `runtime/services.ts`。
 * @example new HttpForwarder(ctx, INERT_TRAFFIC_ACCOUNT) // 低层直构转发器时的显式禁用
 */
export function inertTrafficAccount(): TrafficAccount {
  return {
    consume: () => ALLOW,
    usage: () => ZERO_USAGE,
  };
}
