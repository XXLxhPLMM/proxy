/**
 * @fileoverview 配额用量的**进程内镜像**：判定热路径的落点（`UsageAccount` 的实现）
 * @module datasource/quota/mirror
 * @description
 * 状态只有 `Map<user, {windowKey, total}>`。它**不是真相**，是数据源那份共享存储的**镜像**：
 * 权威总量住在数据源侧，本文件靠两件事保持「只是个缓存」这个性质成立——
 * ① 周期性**回读**（`absorb`，数据源每轮把当前窗口的权威用量推过来），② 合并用 `max`
 * 而不是相加（见 {@link UsageMirror.absorb}）。
 *
 * ## 误差上界：一个声明过的量，不是「大概很快」
 *
 * 设落盘/回读周期为 `P`（`quotaFlushInterval`，runtime 相位现读）。任一字节从「真实发生」到
 * 「另一个进程的镜像看得见它」，要穿过两个各不超过 `P` 的等待：
 *
 * ```
 * t            t + P                    t + 2P
 * 写入方 consume  写入方那一轮落库        读出方那一轮回读到它
 * ```
 *
 * 写入方自己那一轮**排在回读之前**（`./sqlite-source.ts:runOnce` / `./jsonl-source.ts:runOnce`
 * 都是「先落盘、后扫描回读」），所以读出方看到的一定是「至少含这批字节」的那一份。故
 *
 * > **判定滞后的误差上界 = `2P`**，由 {@link mirrorLagBoundMs} 声明，被 `tests/unit/datasource/quota/drivers/registry.test.ts`
 * > 按「两个实例、写入方落库后读出方在 `2P` 内收敛」实测。
 *
 * 换句话说：**多进程判定仍然是每进程一份的**（见 `./types.ts` 文件头那条诚实记录），只是它
 * 现在的**偏差有界且可测**，而不是「永远看不到别人的字节」。这正是把总量搬到数据源这一侧的
 * 收益：偏差从「无界」变成「有界 + 可声明 + 可断言」。
 *
 * ## 窗口化：每用户槽位带一个窗口键，**滚动即清账**
 *
 * 槽位形如 `Map<user, {windowKey, total}>`：进入 `consume` / `usage` 时算一次当前窗口键，与
 * 槽位里的比对，**不同即用量清零并换键**。
 *
 * **为什么是「惰性滚动」而不是定时器清账**：
 * - `consume` 是**同步**函数（无锁论证见下）。要在一个同步函数里「到点就清」就必须引入
 *   定时器/微任务，那会同时破坏两件事：① 无锁论证（引入让出点）② 「本文件零后台任务」的
 *   干净性（进程退出时还要清理、停机时要摘、定时器还要 unref）。
 * - 清账的真实需求只是「**跨过边界后别拿旧账当新账**」，而这件事在**每次访问槽位时**判一次
 *   就完备了：没人访问的槽位清不清账在语义上不可观测（`usage` 一读就现算）。
 * - 于是窗口滚动的全部成本 = 每次 `consume` 多一次字符串比较与（跨窗时）一次写 Map，
 *   零定时器、零后台任务、零停机清理。
 *
 * **已用量绝不跨窗口继承**（裁决）：继承等于白送「等窗口翻页」的重叠额度——用户只要卡在
 * 边界前用满，等窗口一翻就又能用满一份，配额立刻失去意义。故跨窗是一律清零。
 *
 * **已知限制（未完全解决，不要假装已修）**：`authType=jwt` 的 `sub` 由外部签发，理论上可产生
 * 任意多用户名 → 槽位单调增长。落盘压缩解决了这条限制的「持久」那一半——数据源侧压缩/清理时
 * 按 `(用户, 窗口键)` 求和并**丢弃已过期窗口的条目**（`./jsonl-source.ts:compactEntries` /
 * `./sqlite-source.ts` 的 `DELETE`），故存储里那份是有界的；**未解决的是同一个长跑进程内的
 * 这个 `Map` 仍不淘汰**（本文件零 `.delete(` 是护栏）。窗口滚动**只清用量、不删槽位**：删槽位
 * 等于把「清账」变成「除名」，两者语义不同。刻意不加 LRU 之类猜测性淘汰——账本根本没有「过期」
 * 这个概念（窗口是**重置**不是**衰减**），而淘汰会造出「配额还没过期、账本先被淘汰」= 被淘汰
 * 的用户凭空多得一份额度。护栏 `tests/unit/datasource/quota/window-rollover.test.ts`（本限制留在文件头本身是契约）。
 *
 * ## 为什么无锁是安全的（不是「图省事」）
 *
 * `consume` 是**同步函数**（签名里没有 `Promise`，实现体内没有任何 `await`），而 Node 的
 * JS 回调永远跑在**同一个线程**的事件循环上。一次 `consume` 从「读 Map」到「写回累计值」
 * 到「比较上限」到「返回 verdict」之间**没有任何 await 点**，因此不可能在中间被另一个
 * `consume` 插入——不存在「读-改-写」被打断的交错窗口，也就不需要锁、也不存在「两个请求
 * 同时判定为未超限」的竞态。**惰性滚动没有改变这条论证**：窗口比对与清零同样在这段无 await
 * 的同步区间内完成，「滚动 + 累加 + 判定」整体仍是原子的。
 *
 * 反过来说：如果哪天有人把 `consume` 改成 `async`，这条论证**立即失效**——交错窗口会出现，
 * 账本会少算。届时必须先补一把互斥（单进程内最小改动是改成「入队 + 微任务串行」），而不是
 * 继续依赖单线程。本文件因此把「`consume` 必须同步」写进类型与断言（护栏见
 * `tests/unit/datasource/quota/consume-sync.test.ts`），并把「**不许为窗口滚动引入任何定时器**」一并锁进
 * 源码级断言——否则下一个来的人会很自然地想「起个 setInterval 清账吧」，那正好把无锁论证作废。
 *
 * **⚠️ 而「同步」不等于「无 IO」——这是上面那条论证的同一个漏洞的另一副面孔。**
 * `db.prepare("SELECT …").get(user)`（`DatabaseSync` 本来就是**同步**的）、`fs.readFileSync`
 * 这类调用里既没有 `await` 也没有定时器，于是上面那几条断言**一条都不会红**，而无锁论证已经
 * 悄悄从「单线程无让出点」退化成「跨连接共享内存」或「每 chunk 一次 SQL」。实测那两条路
 * 分别要 20.6 µs/chunk（1M 账号下占事件循环 16%）与 61 µs/chunk（47.6%）。
 *
 * 故本文件的边界是**两层**，都不许退让（护栏与完整取舍见 `tests/unit/datasource/quota/consume-sync.test.ts`
 * 第 ⑧ 条决策）：
 * - **零 `node:` 内置模块 import**。这是「只准相对引用本模块」的**正面声明**（绕不过去），
 *   同时把 SAB 的形状钉死为「**共享内存必须由装配点注入**，不许在这里 import」——这正是
 *   「对部署拓扑无感」在代码层的样子（进程各建各的、只共享注入进来的存储），而不是一句口号。
 * - **`consume` 体内零 IO / DB / 网络 / 阻塞等待**。因为一个叫 `store` 或 `cache` 的
 *   **注入**协作者照样能把 `SELECT` 带进来，import 面拦不住。
 *   `Atomics.load/store/add` 是 SAB 后端**要用的**（共享内存上的原子加减），不在禁用之列；
 *   真正会阻塞整个事件循环的只有 `Atomics.wait` / `waitAsync`。
 *
 * **回读没有破坏这条论证**：回读由数据源在自己的周期循环里**异步**做，结果经 `absorb` 一次性
 * 灌进这个 Map；`consume` 自己一次 IO 都不发起。热路径对「数据源那份」的依赖是**一个已经算好
 * 的数**，故 `consume` 的同步性与耗时和磁盘、数据库、文件全无关系。
 *
 * ## 判定语义（裁决，不许在调用点各自解释）
 *
 * - **只有一个上限**：`UsageQuota.bytes`（上传 + 下载**算在一起**）。**不分方向**。
 * - **为什么刻意只有合计、不分方向**：耗尽判定是**账号级封禁**（撞顶后该用户在当前窗口内
 *   彻底不可用，跨过窗口边界才恢复），不是「只封那一个方向」——否则用户可以上传撞顶后改走
 *   下载继续白嫖。既然分方向也封不住「另一半」，那么「只配一个方向的上限」实际得到的是「整号
 *   断网，且要先把那个方向撞满才触发」：**伪控制力 + 隐性运维坑**。真要分方向限流是限速/并发
 *   问题，答案在传输层与反向代理，不在这个字段。
 * - **推论（必须知道）：耗尽 = 账号在当前窗口内彻底不可用**。撞顶后
 *   `consume(..., "down", ...)` 同样返回 `allow:false`。代价是**硬切**（见 core 的计量落点）。
 * - **`usage` 与 `limit` 恒取同一个数**（合计累计 vs 上限），消费方据此能直接算出「超了多少」
 *   「还剩多少」（`limit - usage`）；报成别的口径会让那个减法静默给出错误答案。
 * - **`dir` 只是「本次流动方向」这个如实事实**，与判定无关。方向由挂点如实上报、**绝不从别处
 *   反推**；它进账本条目与 `usage.quota-exceeded` 事件，内存里不存。
 * - **恰好等于上限放行**（`<=` 语义）：`bytes: 100` 允许用户用满 100 字节。理由：配额是
 *   **上限**而不是「额度 + 1 的坑」；按 `>` 判定时，运维写 `bytes: 1073741824`（1GiB）得到
 *   的是「1GiB 减一个字节都传不完」，这是最难自查的 off-by-one。故判据是「累计值 **>** 上限
 *   才拒」。
 * - `bytes` 为 0 / 未配 `quota` / 用户不存在 → **恒 allow**。这条是**显式分支**
 *   （`quota === undefined` 直接返回放行），不是「默认上限 0 恰好放行」的蒙混——护栏对此有
 *   独立断言。
 * - **未配配额也照常累加 usage**：「没有上限」≠「不计量」。唯一「不计量」的情形是**没有身份**
 *   （计量落点一个监听器都不挂）。这样 `usage` 恒为真用量，将来给某个账号加上限即刻按真账判定，
 *   而不是给他一个「从 0 开始」的假象。
 * - 超限时**累计值照实累加**（不截断到上限）：账本是「真实用量」，日志里看到的 `usage` 必须是
 *   真的，否则运维看到的数字是假的。
 */

import type { QuotaWindow } from "@/datasource/quota-window.js";
import { quotaWindow, windowKey } from "@/datasource/quota-window.js";
import { clampFlushIntervalMs } from "./flush-loop.js";
import type {
  QuotaResolver,
  UsageAccount,
  UsageDirection,
  UsageSink,
  UsageSnapshot,
  UsageVerdict,
} from "./types.js";

/** 未超限时的常量判定结果（共享单例：放行是绝大多数路径，别为它分配对象）。 */
const ALLOW: UsageVerdict = Object.freeze({ allow: true });

/** 零用量（未知用户返回它）。 */
const ZERO_USAGE = 0;

/**
 * 窗口与时钟的注入口（**由装配点解析**，本类不读配置、不读文件）
 * @description
 * - `resetHour`：窗口重置小时（本地时区 0..23）。**每次访问现调**，沿用本仓对 runtime 相位
 *   字段的既有约定，故热改 `store` 立即生效、不必重启。
 * - `now`：时钟源，**可注入且缺省为墙钟**（可注入的理由：窗口边界最容易写错，靠真实时钟只能
 *   写出测不出回归的用例）。
 */
export interface QuotaWindowSource {
  resetHour(): number;
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
const DEFAULT_WINDOW: QuotaWindowSource = { resetHour: () => 0, now: wallClock };

/** 单个用户在**当前窗口**内的槽位：`windowKey` 不同即视为新窗口（用量归零）。 */
interface Counters {
  windowKey: string;
  /** 双向**合计**已用字节（方向不切分：只有一个上限，判定不需要它）。 */
  total: number;
}

/**
 * 判定滞后的**误差上界**（ms）
 * @description
 * 推导见文件头那段时序图：写入方落库最多等一个周期 `P`，读出方回读最多再等一个 `P`，而
 * 写入方那一轮**先落盘后回读** ⇒ 读出方不会在写完之前读到它 ⇒ 上界是 `2P` 而不是 `3P`。
 *
 * **为什么必须是一个可测的量**：多进程判定偏差是这条链路的固有性质，藏起来只会让人以为
 * 「配了配额就是全集群一个数」。声明成函数 + 被断言覆盖，运维问「另一个进程的用量我
 * 最多晚多久生效」时才有答案。`P` 用 `clampFlushIntervalMs` 归一，与落盘循环**同一个夹取**，
 * 否则「上界算 1ms、实际夹到 1ms」这类偏差会让这个数失去意义。
 * @param flushMs - 落盘/回读周期（`quotaFlushInterval`，runtime 相位现读）
 */
export function mirrorLagBoundMs(flushMs: number): number {
  return clampFlushIntervalMs(flushMs) * 2;
}

/**
 * 用量的进程内镜像
 * @description 状态只有 `Map<user, {windowKey,total}>`；配额来自注入的 `QuotaResolver`
 * （装配层持有账号表读面），窗口口径来自注入的 `QuotaWindowSource`。本类不读配置、不读文件、
 * 不打日志。
 */
export class UsageMirror implements UsageAccount {
  private readonly totals = new Map<string, Counters>();

  /** 时钟源：`window.now` 缺省即墙钟（在构造期归一，不在热路径上反复判 undefined）。 */
  private readonly clock: () => number;

  /**
   * 数据源注入口（可后绑定，见 {@link bindSink}）
   * @description
   * **刻意留成可后绑定而不是构造期必填**：数据源需要在**装配点**（`runtime/services.ts`）与
   * 端口 resolver 一起组装，而它自己又要把回读结果回注给本对象（`absorb`）。先建数据源再建
   * 镜像会把闭包写成「用前未赋值」，后绑定是这件事唯一诚实的形状。
   *
   * 未绑定 = **不落盘**（单测与「不注入数据源」的低层调用方就是这个形态）：判定语义完全
   * 不变，`consume` 依然同步，数据源缺席只是「重启后不恢复、也没有多进程共享」。
   */
  private sink: UsageSink | undefined;

  /**
   * @param resolve - 配额解析端口（**每次 consume 现调**，走 1s 节流缓存，与
   *   `loadUserPolicy` 同一套性能论证：文件读取被 `readJsonCached` 摊薄到每文件最多 1s 一次 stat）
   * @param window - 窗口口径注入口（缺省 = 午夜重置 + 墙钟，见 `DEFAULT_WINDOW`）
   */
  public constructor(
    private readonly resolve: QuotaResolver,
    private readonly window: QuotaWindowSource = DEFAULT_WINDOW,
  ) {
    this.clock = window.now ?? wallClock;
  }

  /**
   * 绑定数据源注入口（装配点用；`UsageAccount` 端口**刻意不含**这个方法）
   * @description
   * 不在端口上的理由：端口是「用量与判定」的契约，「这本账写到哪去」是装配决策，混进端口
   * 会让每个替身都被迫实现两个与判定无关的方法。绑定后**立即生效**：`consume` 之后新产生的
   * 字节全部进落盘队列。
   */
  public bindSink(sink: UsageSink): void {
    this.sink = sink;
  }

  /**
   * 吸收一次回读（数据源在 `open()` 时与此后每轮周期各推一次）
   * @description
   * **合并用 `max` 而不是相加，这是「镜像不是权威」的全部内容。** 三种情形它都要对：
   * - 本镜像的数**比回读值大**（本进程还有未落库的字节）⇒ 取本地的。相加 = 重复计账，
   *   而重复计账的直接后果是用户莫名其妙提前撞顶。
   * - 本镜像的数**比回读值小**（别的进程刚写进去）⇒ 取权威的。这正是多进程共享的收益。
   * - 两者相等 ⇒ 无操作。
   *
   * ⚠️ **窗口键不一致时不合并**：那一刻说明「本镜像认为当前是哪个窗口」与「数据源认为」已经
   * 分叉（最常见的原因是两侧时钟跨过了边界），此时取 `max` 会让**上一个窗口**的巨额用量
   * 污染新窗口——那是凭空多送额度。跳过之后，本镜像会在下一次 `consume`/`usage` 的惰性滚动
   * 里换到新键（用量归零），下一轮回读再对齐，代价是**至多一个周期**的少算（偏松，不偏严）。
   *
   * **本方法只在 `open()` 之前与周期循环里被调用**（都不在请求热路径上），故它可以写 Map；
   * 「零淘汰不变式」不受影响：只 `set`、从**不** `delete`。
   */
  public absorb(snapshot: UsageSnapshot): void {
    for (const [user, usage] of snapshot) {
      const current = this.totals.get(user);
      if (current === undefined) {
        // 本进程还没碰过这个用户：权威值即真相，直接立槽（不经过 `slotFor` 的键比对——
        // 回读值自带的 `windowKey` 就是数据源那一侧的口径，而本进程此刻还没有自己的口径可冲突）
        this.totals.set(user, { windowKey: usage.windowKey, total: usage.total });
        continue;
      }
      if (current.windowKey !== usage.windowKey) {
        continue;
      }
      if (usage.total > current.total) {
        current.total = usage.total;
      }
    }
  }

  /**
   * 镜像槽位数（= 曾计量过的用户数）
   * @description 只读观测口径，供「账本规模有界」护栏与诊断使用；**刻意不进 `UsageAccount`
   * 端口**——端口是「用量与判定」的契约，规模诊断不是它的语义。
   */
  public get size(): number {
    return this.totals.size;
  }

  public consume(user: string, dir: UsageDirection, bytes: number): UsageVerdict {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return ALLOW;
    }

    // 配额现读（账号表既有 1s 节流路径）；未配 / 用户不存在 → 窗口取缺省 month，
    // 仍照常计量（见文件头「没有上限 ≠ 不计量」）。
    // 时刻只取一次：窗口键与落盘 delta 的 `ts` **必须是同一个时刻**（否则同一批字节会被判定
    // 分到窗口 A、却按窗口 B 落盘）。
    const now = this.clock();
    const quota = this.resolve(user);
    const current = this.slotFor(user, quotaWindow(quota?.window), now);

    // **只有一个合计上限，故方向不参与判定**：`dir` 只作为落盘事实透给数据源（排障时能
    // 看出这批字节是上传还是下载吃掉的），内存里不分桶累加。
    current.total += bytes;

    // 落盘队列：**同步入队**（`UsageSink.record` 是纯数组 push，无 Promise、无 IO），
    // 真正的写盘由数据源自己的周期循环负责 —— consume 的同步性因此分毫未动。
    this.sink?.record(user, dir, bytes, now);

    // 配额未配 / 用户不存在 / 文件读不到有效内容 → 恒 allow（显式分支，见文件头裁决）
    if (quota === undefined) {
      return ALLOW;
    }

    // 判定：单一合计上限，判据是「累计 **>** 上限才拒」（恰好等于放行）
    const limit = quota.bytes;
    if (limit > 0 && current.total > limit) {
      return { allow: false, reason: "quota", usage: current.total, limit };
    }

    return ALLOW;
  }

  public usage(user: string): number {
    const quota = this.resolve(user);
    // 从未计量过的用户：**不建槽**。读一次不该凭空长出一个槽位（规模有界性的一部分）
    if (!this.totals.has(user)) {
      return ZERO_USAGE;
    }
    // 已计量过 → 同样比对窗口键：跨窗即清零，故这里可能返回零
    const current = this.slotFor(user, quotaWindow(quota?.window), this.clock());
    return current.total;
  }

  /**
   * 取该用户**当前窗口**的槽位，必要时惰性滚动（清零 + 换键）
   * @description
   * 「窗口过期清账」的**全部实现，没有第二个机制**：键相同 → 原样返回既有槽位（不写 Map）；
   * 键不同 → 建一个零用量槽位替换掉。刻意**不删槽位**：清账 ≠ 除名，删槽会让「用户是否
   * 存在过用量」这个事实丢失，也会让「反复读一个未知用户」变成无限增长。
   *
   * @param now - 与 `consume` 记录到落盘队列的是**同一个时刻**（见 `consume` 注释）
   */
  private slotFor(user: string, window: QuotaWindow, now: number): Counters {
    const key = windowKey(now, window, this.window.resetHour());
    const current = this.totals.get(user);
    if (current !== undefined && current.windowKey === key) {
      return current;
    }
    const fresh: Counters = { windowKey: key, total: 0 };
    this.totals.set(user, fresh);
    return fresh;
  }
}

/** 造一个用量镜像（装配点用；单测也用它 + 一个闭包当 `QuotaResolver` 替身）。 */
export function createUsageMirror(resolve: QuotaResolver, window?: QuotaWindowSource): UsageAccount {
  return new UsageMirror(resolve, window);
}

/**
 * 显式**禁用档**（null object）：不计量、不判定、恒放行
 * @description
 * 「服务被直构、没注入这个服务」有一个语义明确的正确答案——计量关掉（与 `BaseProxy` 里
 * `identity ?? noneIdentity()` **完全同构**的既有先例）——而不是让「忘注入」变成运行期怪问题。
 * 它**不是**「默认的镜像实现」：读账号表真实配额的那个镜像只在唯一组装点
 * `createProxyRuntime` 里解析，见 `runtime/services.ts`。
 * @example new HttpForwarder(ctx, INERT_USAGE_ACCOUNT) // 低层直构转发器时的显式禁用
 */
export function inertUsageAccount(): UsageAccount {
  return {
    consume: () => ALLOW,
    usage: () => ZERO_USAGE,
  };
}
