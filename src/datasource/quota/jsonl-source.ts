/**
 * @fileoverview 用量数据源的 **json 驱动**：单文件 JSONL，delta 追加 + 回读 + 压缩
 * @module datasource/quota/jsonl-source
 * @description
 * 用量镜像是**纯内存**的：进程一停，所有用量归零。这对「配了配额」的部署是最糟的故障形态
 * —— 用户每次重启都能白拿一份满额。本模块给这本账一个**持久**副本：
 *
 * - 文件：`<quotaUsageDir>/usage.jsonl`，**一行一条增量**：
 *   `{ ts, u, d, b }`（时刻 / 用户 / 方向 `"up"|"down"` / 字节数）。
 * - **只写增量，绝不写绝对值**：绝对值一律在**读取时按 `(用户, 窗口键)` 求和**得到。写绝对值
 *   等于让「谁最后写」成为唯一真相 —— 两个 flush 交错就会互相覆盖，且崩溃后留下的绝对值无法
 *   与已追加的增量对账。
 *
 * **多进程**：文件**不分槽**，所有进程写同一个 `usage.jsonl`。⚠️ 实时判定仍然是每进程一份的
 * —— 镜像只按周期回读一次（见 `./mirror.ts:mirrorLagBoundMs`），而这里的回读**是全文件解析**，
 * 于是「别人写的字节何时对我可见」完全由周期决定，与存储无关。本档与 sqlite 档在这条上
 * **完全相同**。
 *
 * 本档独有一处窄差别：压缩是「读全量 → 求和 → 写 `.tmp` → `rename`」，而「无并发压缩」的
 * 论证**只在单进程内**成立（Node 单线程 + Promise 链串行）；两个进程同时越过阈值时后者
 * `rename` 覆盖前者的基线 → 丢 delta。sqlite 档的累加是数据库内部的原子 UPSERT，没有这个
 * 窗口。这条差别**不改变判定语义**（丢的是存储里的量，判定靠镜像，镜像有自己的累计），
 * 但它让「存储里的总量」在两个进程同时压缩时短暂偏小——所以 json 档是**备选档**而不是缺省档
 * 之外的第一选择。
 *
 * ## 回读：按游标**增量**读，代价是 O(本轮新增) 而不是 O(全文件)
 *
 * 镜像每轮周期都要回读一次（否则它就不是缓存而是权威）。JSONL 没有「按主键取一行」这种东西，
 * 但它是**只追加**的 —— 于是「上次读到第几字节」就是一条天然水位线。本档据此维护三个状态
 * （`readCursor` 行边界位置 / `readGuard` 尾部哨兵 / `authoritative` 累积求和），每轮**只读
 * `[readCursor, EOF)` 里到最后一个完整 `\\n` 为止的那一段**，折进累积值后发布。
 *
 * 实测（8MiB 阈值 = 151303 条 entry / 2000 用户，周期 5s）：
 *
 * | | 全量读 | 增量读 |
 * | --- | --- | --- |
 * | 每轮新增 1000 条 | 246.5 ms（占事件循环 4.93%） | 1.6 ms |
 * | 每轮新增 10000 条 | 246.5 ms | 16.3 ms |
 *
 * 那 246.5 ms 里有 187.1 ms 是逐行 `JSON.parse`、59.4 ms 是求和——**都不是 IO**，所以调大周期
 * 省不掉它，只能不重复做。
 *
 * **「不重复做」换来的代价是状态**：游标一旦指错就是**重复计账**（用户莫名其妙提前撞顶），
 * 所以三种情况一律**全量重建**而不是猜：文件比游标短、游标为零、以及**游标前哨兵对不上**
 * （压缩换文件）。哨兵那条不是多余的：压缩**也可能让文件变大**（每用户原本只有一条时
 * `compactEntries` 给 up/down 各一条），只比大小会漏认，而漏认的后果正是游标落进新内容中段。
 * 文件头那句「无并发压缩的论证只在单进程内成立」在这里多出一条出口：另一个进程压缩过之后，
 * 本进程靠哨兵认出并重建——压缩丢 delta 的问题仍在（那是 `rename` 覆盖，与游标无关），
 * 但**读**不会读到错位的账。
 *
 * **sqlite 档没有这条路**：它的累加是原地 UPSERT，**没有追加位点**，要增量读就得加 changelog
 * 表（写放大翻倍）或 `PRAGMA data_version` 探测（只告诉你「有人写了」，不告诉你「谁」）。故它
 * 保留 O(全表) 的回读，而那一趟本来就必须做（清理过期窗口要用同一批行）。
 *
 * **两个压缩安全点**（Windows 上 `rename` 覆盖一个**仍打开**的文件必然 `EPERM`）：压缩要
 * 「读全量 → 求和 → 写 `.tmp` → `fs.rename` 覆盖」，故流程被钉死为
 * `flush → close 句柄 → 压缩 → 重开句柄`，且压缩的**两个**触发点都在这个顺序里：
 * ① **启动时**：`open()` 里「读完立刻压缩，**然后**才开 append 句柄」（此时根本没有句柄）；
 * ② **运行期按文件大小阈值**（默认 8MiB）：在落盘成功之后判断，超阈值则在**同一轮**里把
 * 压缩做完（关句柄 → 压 → 重开）。全程**没有并发压缩的可能**：Node 单线程 + 轮次经一条
 * Promise 链串行化，所以「单线程，无并发」不是假设而是结构事实。
 *
 * **崩溃安全：`.tmp` + `rename`**：压缩永远先写 `<file>.tmp` 再 `rename` 覆盖 `<file>`。
 * `rename` 在同一卷上是原子的，所以**崩溃点只有两种**：`.tmp` 写了一半（`rename` 未发生 → 原
 * 文件完好）或 `rename` 已完成（`.tmp` 已消失）。中间不存在「原文件被截断成半个」的态。启动时
 * 顺手把残留的 `.tmp` 删掉（best-effort，失败只报告不阻断）——本模块**从不读** `.tmp`，所以即使
 * 删不掉，残留的 `.tmp` 也永远不可能污染原文件。
 *
 * **压缩丢弃已过期窗口的条目**：`compactEntries` 按 `(用户, 窗口键)` 求和，并且**只保留该用户
 * 当前窗口的那一条**，过期窗口的条目在这里消失。这正是「`authType=jwt` 的 `sub` 无限增长」这条
 * 限制的**持久那一半**的答案——28 个 `sub` 跨 28 天之后，一次压缩就把文件清空，重启回读时这些
 * 过期槽位**根本不会回到镜像**。**保留的那一条带 `maxTs` 而不是压缩时刻**：`ts` 必须落在它
 * 所属的窗口内，重新压缩才会算出同一个键 → **压两次结果逐字节相同**（幂等）。若写成「压缩
 * 时刻」，两次压缩间隔只要跨过窗口边界就会产出不同内容，幂等这条护栏也就测不出东西了。
 *
 * **写盘失败韧性**（写失败 `EACCES` / `ENOSPC` / … 时的正确形态只有一种，理由是「重试可能
 * 重复计一次账」，故宁可慢也不能重）：**内存计数继续走 + 未落盘 delta 累积留待下次重试 + 发一条
 * 可见事实**。三条都必要：把服务拒了等于「磁盘满 → 代理全挂」（配额功能不该有能力打垮数据面）；
 * 静默吞掉则让运维以为配额持久化了。整批 delta 会被放回队首（`this.pending = batch.concat(
 * this.pending)`，不用 `unshift` —— 大批次上 `unshift(...batch)` 会打爆调用栈），下次原样重试。
 *
 * **落盘是无条件的**：`open()` 不按「有没有人配配额」设门。门在这里会让**内存判定与落盘脱钩**
 * ——账号表是每 chunk 现读的，运行中热加一个 `quota.bytes` 会让判定立刻封顶，而落库因为启动时
 * 判据为 false 而永远不开始（`record()` 全程 no-op），于是「在判定、零落库、账本文件压根不存在」
 * 且日志一条不出。一条不变量管住：**在判定 ⇒ 一定在记账**。
 */

import fsp from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import { startFlushLoop, type FlushLoopHandle } from "./flush-loop.js";
import { windowKey, type QuotaWindow } from "@/datasource/quota-window.js";
import type {
  UsageDirection,
  UsageSnapshot,
  UsageSourceController,
  UsageSourceSpec,
  UsageSink,
  WindowUsage,
} from "./types.js";

/** 运行期压缩阈值（默认 8MiB）：账本文件超过它就在下一轮里压缩。 */
export const DEFAULT_USAGE_COMPACT_BYTES = 8 * 1024 * 1024;

/**
 * 账本文件名（**只算路径，不碰磁盘**）：`<dir>/usage.jsonl`
 * @description **刻意没有任何进程标识的位置**：分槽（旧的 `worker-<slot>.jsonl`）让配额判定
 * 从「账号级封禁」退化成「每进程一份封禁」，那是一个真实的配额逃逸，所以「按 worker 分槽」
 * 这个选项在这里**不存在**——给了就等于让它复活。
 */
export const JSONL_USAGE_FILE_NAME = "usage.jsonl";

/** 账本目录 + 共享文件名（**只算路径，不碰磁盘**）：`<dir>/usage.jsonl` */
export function sharedUsageFileName(dir: string): string {
  return path.join(dir, JSONL_USAGE_FILE_NAME);
}

/** 账本临时文件（压缩用）：`<file>.tmp`。本模块**从不读**它（见文件头「崩溃安全」）。 */
function tmpPathOf(file: string): string {
  return `${file}.tmp`;
}

/**
 * 游标哨兵长度（字节）
 * @description 取 64 是因为一条 entry 是 `{"ts":…,"u":…,"d":"up","b":…}`，64 字节足以覆盖任何
 * 真实用户名的一段 —— 判据是「**不等就重读**」，误判方向是**偏保守**（多读一次全量）而不是
 * 漏读，故长度不足只会让重读变频繁，不会有正确性风险。
 */
const CURSOR_GUARD_BYTES = 64;

/** 一行账本条目（**增量**，不是绝对值）。 */
export interface UsageEntry {
  /** 记账时刻（毫秒时间戳）。窗口归属由它经 `windowKey()` 算出，故它必须与判定时刻同一个。 */
  readonly ts: number;
  readonly u: string;
  /** 方向：`up` = 客户端→上游，`down` = 上游→客户端。 */
  readonly d: UsageDirection;
  /** 本次字节数（恒为正整数；0/负数没有落盘意义）。 */
  readonly b: number;
}

/** 序列化：键序固定 `ts/u/d/b`，行尾带 `\n`（崩溃时最后一行最多是残缺的一行，读时跳过）。 */
function encodeEntry(entry: UsageEntry): string {
  return `${JSON.stringify({ ts: entry.ts, u: entry.u, d: entry.d, b: entry.b })}\n`;
}

/**
 * 反序列化一行；**任何不合法的内容都返回 undefined（跳过）而不是抛错**
 * @description 账本文件可能是**残缺的**（崩溃在写一半、被人手改过、从别的实现迁过来）。
 * 抛错等于「一行脏数据让整个账本打不开」→ 配额整体失效；跳过只丢掉那一行的额度——最坏是
 * 少算一点用量，**绝不会**把一份完整的账变成读不出来。
 */
function decodeEntry(line: string): UsageEntry | undefined {
  if (line.length === 0) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const o = raw as { ts?: unknown; u?: unknown; d?: unknown; b?: unknown };
  if (typeof o.ts !== "number" || !Number.isFinite(o.ts)) {
    return undefined;
  }
  if (typeof o.u !== "string" || o.u.length === 0) {
    return undefined;
  }
  if (o.d !== "up" && o.d !== "down") {
    return undefined;
  }
  if (typeof o.b !== "number" || !Number.isFinite(o.b) || o.b <= 0) {
    return undefined;
  }
  return { ts: o.ts, u: o.u, d: o.d, b: o.b };
}

/** 解析整份账本文本（跳过残缺行）。 */
export function parseUsageEntries(text: string): UsageEntry[] {
  const out: UsageEntry[] = [];
  for (const line of text.split("\n")) {
    const entry = decodeEntry(line);
    if (entry !== undefined) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * 压缩：按 `(用户, 窗口键)` 求和，**丢弃已过期窗口的条目**
 * @description
 * 与回读（`./JsonlUsageSource.foldText`，私有）用**同一条**「只认当前窗口」的判据（同一个
 * `windowKey(entry.ts, 窗口类型, resetHour)` 比较），两处判据刻意不合并成一份带副作用的函数：
 * 一条产出可写回文件的条目、一条产出回读结果，但它们对「什么算过期」必须有同一个定义，否则会
 * 出现「回读算进来的量比压缩保留的量多」。
 * 保留条目的 `ts` 取**幸存条目里的最大 ts**（不是压缩时刻）：`ts` 必须落在该窗口内，再压一次
 * 算出的窗口键相同 → **压两次结果逐字节相同**（幂等）；顺带也让「这条用量最早/最晚发生在什么
 * 时候」这个诊断事实留在文件里。
 *
 * 每个用户产出至多**两条**（`up` 一条、`down` 一条）—— 一条 entry 只能有一个方向。某方向求和
 * 为 0 就不产出那一条（0 字节的条目对回读毫无贡献）。
 */
export function compactEntries(
  entries: readonly UsageEntry[],
  windowFor: (user: string) => QuotaWindow,
  resetHour: number,
  nowMs: number,
): UsageEntry[] {
  interface Acc {
    window: QuotaWindow;
    key: string;
    up: number;
    down: number;
    ts: number;
  }
  const acc = new Map<string, Acc>();
  for (const entry of entries) {
    let cur = acc.get(entry.u);
    if (cur === undefined) {
      const window = windowFor(entry.u);
      cur = {
        window,
        key: windowKey(nowMs, window, resetHour),
        up: 0,
        down: 0,
        ts: entry.ts,
      };
      acc.set(entry.u, cur);
    }
    if (windowKey(entry.ts, cur.window, resetHour) !== cur.key) {
      continue;
    }
    if (entry.d === "up") {
      cur.up += entry.b;
    } else {
      cur.down += entry.b;
    }
    if (entry.ts > cur.ts) {
      cur.ts = entry.ts;
    }
  }
  const out: UsageEntry[] = [];
  for (const [user, cur] of acc) {
    if (cur.up > 0) {
      out.push({ ts: cur.ts, u: user, d: "up", b: cur.up });
    }
    if (cur.down > 0) {
      out.push({ ts: cur.ts, u: user, d: "down", b: cur.down });
    }
  }
  return out;
}

/** json 驱动的构造选项（`UsageSourceSpec` + 本驱动自己的注入位） */
export interface JsonlUsageSourceOptions extends UsageSourceSpec {
  /**
   * 账本文件名（**共享**，不带任何进程标识）
   * @description 缺省 {@link JSONL_USAGE_FILE_NAME}。**刻意不提供「按 worker 分槽」的选项**
   * —— 那是本仓换掉的一个真实配额逃逸（见 {@link sharedUsageFileName} 的注释），给了就等于
   * 让它复活。
   */
  readonly fileName?: string;
  /** 运行期压缩阈值字节数（默认 {@link DEFAULT_USAGE_COMPACT_BYTES}）。 */
  readonly compactBytes?: () => number;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR")
  );
}

const wallClock = (): number => Date.now();

/**
 * JSONL 用量数据源
 * @description
 * 同时实现两个面：**`UsageSink`**（给镜像入队增量）与 **`UsageSourceController`**（给
 * `runtime.start/stop` 驱动开/关）。两个面分开的理由是两个调用方、两种失败代价。状态只有：
 * `file`（构造期算好的路径）、`handle`（append 句柄）、`pending`（未落盘队列）、`size`
 * （文件字节数）、`compactedAt`（上次压缩后的字节数，用于「压不动就别反复压」）。
 */
export class JsonlUsageSource implements UsageSink, UsageSourceController {
  /** 账本文件路径（构造期纯计算，**不碰磁盘**）。 */
  public readonly file: string;

  private handle: FileHandle | undefined;
  private pending: UsageEntry[] = [];
  private size = 0;
  private compactedAt = 0;
  private active = false;
  private loop: FlushLoopHandle | undefined;
  /** 排空链：保证任何两轮严格串行（压缩因此不可能并发，见文件头）。 */
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * 已消费到的字节位置。**恒为某一行 `\\n` 之后**，故它永远是行边界 —— 这是「按偏移增量读」
   * 能成立的前提（从行边界起读，绝不会把一个多字节字符劈成两半）。
   * @description 尾行可能残缺（别人正写、我们读到一半），那一段**不消费**：停在最后一个完整
   * `\\n` 即可，下一轮从同一个位置重读，残缺的那行自然补齐。
   */
  private readCursor = 0;

  /**
   * 游标**之前**最多 {@link CURSOR_GUARD_BYTES} 个字节，用来认出「文件被重写过」
   * @description 压缩是「写 `.tmp` + `rename` 覆盖」，它既可能让文件**变小**（常态）也可能
   * **变大**（每用户原本只有 1 条时，`compactEntries` 会给 up/down 各一条）。所以**光比
   * `st_size` 与 `readCursor` 的大小关系认不全**：文件变大时游标会落进新内容的中段，读出来的
   * 是别人的重复计账。一段内容哨兵把这一整类认全，且比对是 O(1)。
   */
  private readGuard = "";

  /**
   * 累积的**当前窗口**权威用量（回读只 fold 新增，故它必须常驻）
   * @description 它就是「按 `(用户, 窗口键)` 求和」的增量维护形式。**内层 `WindowUsage` 对象
   * 永不原地改**（每次 fold 建新对象），发布时再发一份新的 Map —— 于是「每轮一份独立快照」
   * 这个可观测契约与全量求和时逐字一致，而调用方不可能因为「上一轮的快照被这一轮改了」而
   * 看到自己手里的数在变。
   */
  private authoritative = new Map<string, WindowUsage>();

  /** 压缩成功后置位：**下一轮 `readBack` 必须重建**（文件已被换掉，游标与累积值双双失效）。 */
  private cursorStale = false;

  private readonly dir: string;
  private readonly clock: () => number;
  private readonly windowFor: (user: string) => QuotaWindow;
  private readonly threshold: () => number;

  public constructor(private readonly options: JsonlUsageSourceOptions) {
    // 目录是 startup 相位：**只在这里读一次**（运行中改目录 = 已打开的句柄仍指向旧文件）
    this.dir = options.dir();
    this.file = path.join(this.dir, options.fileName ?? JSONL_USAGE_FILE_NAME);
    this.clock = options.now ?? wallClock;
    this.windowFor = options.windowFor;
    this.threshold = options.compactBytes ?? ((): number => DEFAULT_USAGE_COMPACT_BYTES);
  }

  /** 是否已启用（`open()` 成功且未 `close()`）。 */
  public get enabled(): boolean {
    return this.active;
  }

  /** 未落盘的增量条数（观测口径：写盘失败后它会累积）。 */
  public get queued(): number {
    return this.pending.length;
  }

  /**
   * 启动数据源：建目录 → **回读一次**（= 重启恢复）→ 压缩 → **然后**才开 append 句柄 → 起周期循环
   * @description
   * **无条件建**：不按「有没有人配配额」设门。门在这里的后果是「内存判定与落盘脱钩」——
   * 账号表是每 chunk 现读的，运行中热加一个 `quota.bytes` 会让判定立刻生效，而落库因为
   * 启动时那一次判据是 false 而**永远不开始**，于是「在判定、零落库、账本文件压根不存在」，
   * 且没有任何一条告警。一条不变量管住这一层：**在判定 ⇒ 一定在记账**。
   *
   * 顺序不可调换：**回读与压缩都在开句柄之前**（否则 Windows 上 rename 覆盖打开的文件 →
   * `EPERM`），而**回读在压缩之前**（读到的必须是压缩前的全量 —— 压缩与回读的过滤判据完全
   * 相同，所以顺序不影响正确性，但「先读后压」让「读到的是什么」只取决于文件内容、不取决于
   * 是否压过）。
   * 幂等：`open()` 在已启用时直接返回。
   */
  public async open(): Promise<void> {
    if (this.active) {
      return;
    }
    try {
      await fsp.mkdir(this.dir, { recursive: true });
    } catch (error) {
      this.report(error);
      return;
    }

    const text = await this.readText();
    this.size = Buffer.byteLength(text, "utf8");
    await this.discardStaleTmp();

    // 启动这一次是**全量重建**：游标从 0 起、累积值从空起，之后才有「按偏移增量读」可依。
    // （重启后没有上一个进程留下的游标可言，而这次全量读的成本只在进程启动付一次。）
    this.resetCursor();
    this.foldText(text);
    this.publish(new Map(this.authoritative));

    // 启动期压缩：**读完立刻压，此时还没有 append 句柄**（第一个安全点）。
    // `reopen=false`：句柄由下面那一行统一开，压缩自己不再开第二个（那会泄漏一个句柄，
    // 而 Windows 上泄漏的打开句柄会让后续任何 `rename` 覆盖本文件直接 EPERM）。
    await this.compact(false);

    this.handle = await this.openAppend();
    if (this.handle === undefined) {
      return;
    }
    this.active = true;
    this.loop = startFlushLoop(
      () => {
        void this.sync();
      },
      this.options.flushMs,
    );
  }

  /**
   * 入队一条增量（`UsageSink` 端口，被 `UsageMirror.consume` 在**同步区间内**调用）
   * @description
   * 真的只是 `pending.push`。**无 Promise、无 IO、无 await** —— 所以 `consume` 的同步性与它的
   * 耗时都和磁盘无关。未启用（未 open / 已 close）时**直接丢弃**：让队列
   * 无限增长才是 bug（那会让「没配配额」反而吃内存）。
   */
  public record(user: string, dir: UsageDirection, bytes: number, ts: number): void {
    if (!this.active) {
      return;
    }
    if (bytes <= 0 || !Number.isFinite(bytes)) {
      return;
    }
    this.pending.push({ ts, u: user, d: dir, b: bytes });
  }

  /**
   * 跑一轮（周期定时器与停机路径共用）：**先落盘（必要时压缩），再回读**
   * @description
   * 顺序是语义的一部分（见 `./mirror.ts:mirrorLagBoundMs`）：落盘在前 ⇒ 同一轮的回读一定含本
   * 进程这批字节。压缩在回读之前也安全：压缩保留的就是「各用户当前窗口的合计」，求和结果与
   * 压缩前逐字相同——**压缩与回读对「什么算过期」必须是同一个定义**（见 {@link compactEntries}）。
   *
   * 走一条**Promise 链**而不是「一个 in-flight Promise + 一个 want 标志」：后者在第二个调用者
   * 到达时只能返回**已经起跑的那一轮**，而那一轮未必包含它刚入队的 delta（调用者会拿到
   * 「我跑完了」的假保证）。链式写法让**每个调用者拿到的都是自己那一轮之后**的 Promise，且
   * 严格串行 —— 压缩因此不存在并发可能。
   *
   * 链上两个 handler 都是 `runOnce`：`runOnce` 内部整体 try/catch、**永不 reject**，故失败不会
   * 污染链；两个 handler 相同是为了让「前一轮 reject」也不会卡死后续。
   */
  public sync(): Promise<void> {
    const next = this.tail.then(
      () => this.runOnce(),
      () => this.runOnce(),
    );
    this.tail = next;
    return next;
  }

  /**
   * 优雅停机：摘定时器 → **最后一轮**（落盘 + 回读）→ 关句柄
   * @description
   * 幂等（第二次调用是空转）。停机必须落盘是**正确性要求**（理由见文件头）：队列里那些「已计入
   * 镜像判定、还没进磁盘」的字节如果丢掉，用户就能靠反复「用一点、Ctrl+C」把配额窗口内的额度
   * 一次次刷新。`active` 刻意在排空**之后**才置 false —— 提前置位会让 `runOnce` 直接 return，
   * 等于把最后一次落盘静默跳过。
   */
  public async close(): Promise<void> {
    this.loop?.stop();
    this.loop = undefined;
    await this.sync();
    await this.closeHandle();
    this.active = false;
  }

  /** 一轮：补开句柄 → 追加本批 → 达阈值则压缩 → 回读。全程不抛。 */
  private async runOnce(): Promise<void> {
    if (!this.active) {
      return;
    }
    try {
      if (this.handle === undefined) {
        // 上一次开句柄失败过（目录被删、权限被改）——**每轮都补试一次**，
        // 否则「一次开失败」会变成「此后再也不落盘」。
        this.handle = await this.openAppend();
      }
      // ⚠️ **回读与句柄无关**（它另开一次读），所以**句柄补不开时也照做**：把回读挂在
      // 「落盘成功之后」会让一次瞬时的 `EACCES` 顺带把镜像的回读也停掉，而那一停就是
      // 「判定再也不知道别人写了多少」——偏差从「有界」退化成「无界」，且没有任何告警。
      if (this.handle !== undefined) {
        if (this.pending.length === 0) {
          // 队列空也要判阈值：上一轮可能写失败过（size 没涨）或有未达阈值的遗留
          if (this.needCompact()) {
            await this.compact(true);
          }
        } else {
          await this.appendPending();
          if (this.needCompact()) {
            await this.compact(true);
          }
        }
      }
      // 回读在最后：**它看到的是「本轮刚落稳 + 已压缩」的那份文件**，于是 `max` 合并在本进程
      // 这一侧恒为无操作（见 `./mirror.ts:absorb`）。
      await this.readBack();
    } catch (error) {
      // 压缩/补开句柄那一层的失败（它们自己已经 report 过，这里只兜 unforeseen）
      this.report(error);
    }
  }

  /** 把队列整批追加到文件。失败把整批放回队首并上报（**不是丢弃**）。 */
  private async appendPending(): Promise<void> {
    const handle = this.handle;
    if (handle === undefined) {
      return;
    }
    const batch = this.pending;
    this.pending = [];
    try {
      const text = batch.map(encodeEntry).join("");
      await handle.write(text, undefined, "utf8");
      this.size += Buffer.byteLength(text, "utf8");
    } catch (error) {
      // **未落盘的 delta 留待下次重试**：整批放回队首。
      // 用 `concat` 而不是 `unshift(...batch)`——大批次上展开调用会打爆调用栈。
      // 顺序也重要：必须排在期间新入队的那些**之前**（那批字节发生得更早）。
      this.pending = batch.concat(this.pending);
      this.report(error);
    }
  }

  /**
   * 回读一次当前窗口的权威用量并推给镜像
   * @description 走的是**与启动期恢复同一份** `foldText`（恢复那一轮 = 游标归零后 fold 全量，
   *   运行期这一轮 = 从游标处 fold 新增）——两个用途共用一条判据，所以「恢复算进来的量」与
   *   「回读算进来的量」不可能分叉。
   *   代价是 O(本轮新增) 而不是 O(全文件)，机制见文件头「回读：按游标增量读」。
   */
  private async readBack(): Promise<void> {
    try {
      const grew = await this.consumeFromCursor();
      // 没读到任何完整新行时**不发布**：那多半是「本轮没有新字节」，发一份与上一轮逐字相同的
      // 快照只是白跑一趟 `absorb`。而一轮真的读到东西时**必须发** —— 那是「别人的字节对我可见」
      // 的唯一时刻。
      if (grew) {
        this.publish(new Map(this.authoritative));
      }
    } catch (error) {
      this.report(error);
    }
  }

  /**
   * 把回读结果推给镜像（`UsageSourceSpec.onSnapshot`）
   * @description **回注抛错只报告**：那是消费方（镜像）的义务，它抛错不该让数据源停止落盘。
   */
  private publish(snapshot: UsageSnapshot): void {
    try {
      this.options.onSnapshot?.(snapshot);
    } catch (error) {
      this.report(error);
    }
  }

  /**
   * 是否该压缩
   * @description 第二个条件（`size > compactedAt`）是为了**不反复压同一种已经压不动的内容**：
   * 一份「本来就每个用户一条」的账本压完大小不变，若只看第一个条件就会**每次都压一遍**
   * （每次都要读全文件 + 写临时文件 + rename）。压完把 `compactedAt` 抬到当前 size，于是只有
   * 在文件**又长起来**之后才会再次触发。
   */
  private needCompact(): boolean {
    const threshold = this.threshold();
    return (
      Number.isFinite(threshold) &&
      threshold > 0 &&
      this.size >= threshold &&
      this.size > this.compactedAt
    );
  }

  /**
   * 压缩：关句柄 → 读全量求和 → 写 `.tmp` → `rename` 覆盖 → 重开句柄
   * @description
   * **绝不持有打开句柄时压缩**（文件头「两个压缩安全点」）。压缩失败时 `rename` 尚未发生
   * → **原文件完好**，只需照常重开句柄继续 append；过期条目会混在后续 append 里，但**判定侧
   * 本来就只认当前窗口**（`foldText`），正确性不依赖「文件已经干净」。
   *
   * 全程不抛：任何失败都经 `report` 上报，并在收尾里尽力把句柄开回来 —— 一个压缩失败绝不能
   * 变成「此后再也不落盘」。
   *
   * @param reopen - 压缩后是否重开 append 句柄。**只有一处例外不重开**：`open()` 里那次启动期
   *   压缩（此刻本来就还没有句柄，调用方紧接着自己开）。开两次会泄漏一个句柄，而 Windows 上
   *   泄漏的打开句柄会让后续 `rename` 覆盖本文件直接 `EPERM`。
   */
  private async compact(reopen: boolean): Promise<void> {
    const before = this.size;
    await this.closeHandle();
    try {
      const text = await this.readText();
      const kept = compactEntries(
        parseUsageEntries(text),
        this.windowFor,
        this.options.resetHour(),
        this.clock(),
      );
      const out = kept.map(encodeEntry).join("");
      const tmp = tmpPathOf(this.file);
      await fsp.writeFile(tmp, out, "utf8");
      await fsp.rename(tmp, this.file);
      this.size = Buffer.byteLength(out, "utf8");
      // **只在成功后置位**。`rename` 未发生就意味着原文件完好，而游标与累积值**仍然有效**
      // ——失败时重建在**正确性上也是对的**（`resetCursor` 先把累积值清空再从 0 重读，结果与
      // 不重建逐字相同，不会重复计账），所以这里按代价而不是按对错取舍：`rename` 在 Windows
      // 上因「另一个进程开着它」而 `EPERM` 是常态，失败后每轮都重建 = 每轮一次全量读，
      // 于是「本来想省的全量读」被压缩失败放大成常态开销。
      this.cursorStale = true;
    } catch (error) {
      this.report(error);
    }
    this.compactedAt = Math.min(before, this.size);
    if (reopen) {
      this.handle = await this.openAppend();
    }
  }

  /**
   * 丢掉游标与累积值（下一轮按全量重建）
   * @description 三条触发路径都归到这里，于是「重建」只有**一份**实现：① 启动（`open()`）
   * 没有上个进程留下的游标；② **本进程压缩成功后**（文件被 `rename` 换成了 `.tmp` 的内容，
   * 游标与累积值双双指向旧文件）；③ 运行期**认出文件被重写过**（见 {@link consumeFromCursor}
   * 的哨兵比对——多半是**另一个进程**压缩了）。
   */
  private resetCursor(): void {
    this.readCursor = 0;
    this.readGuard = "";
    this.authoritative = new Map();
  }

  /**
   * 从游标处消费新增行，fold 进累积值
   * @returns 本次是否真的消费到了完整新行（决定要不要发布快照）
   * @description **只消费到最后一个完整的 `\\n`**：尾行可能残缺（别人正写），停在行边界既让
   * 游标恒为行边界（从行边界起读绝不会劈开多字节字符），也让残缺的那行下一轮自然补齐。
   *
   * 三种情况一律**全量重建**而不是猜：
   * - 文件比游标**短** → 有人压缩过（或文件被换掉）；
   * - `readCursor === 0` → 从没读过；
   * - 游标前的哨兵**对不上** → 文件被重写，且**不一定是变小**（每用户原本只有一条时压缩会
   *   给 up/down 各一条从而变大，那时光比大小会漏认，游标将落进新内容中段读出重复计账）。
   *
   * 读取失败**不消费也不前移游标**：下一轮从同一位置重来，不会漏也不会重。
   */
  private async consumeFromCursor(): Promise<boolean> {
    if (this.cursorStale) {
      this.cursorStale = false;
      this.resetCursor();
    }
    let handle: FileHandle | undefined;
    try {
      handle = await fsp.open(this.file, "r");
      const stat = await handle.stat();
      if (this.readCursor === 0 || stat.size < this.readCursor) {
        this.resetCursor();
      } else if (!(await this.guardMatches(handle, stat.size))) {
        this.resetCursor();
      }
      if (stat.size === this.readCursor) {
        return false;
      }
      const tail = Buffer.alloc(stat.size - this.readCursor);
      await handle.read(tail, 0, tail.length, this.readCursor);
      const nl = tail.lastIndexOf(0x0a);
      if (nl < 0) {
        // 只有残缺行：留在原地等下一轮（**不前移游标**）
        return false;
      }
      const consumed = tail.subarray(0, nl + 1);
      this.foldText(consumed.toString("utf8"));
      this.advanceCursor(consumed);
      return true;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      // 文件不见了（被删 / 目录被换）：等价于「账本归零」，重建而不是继续读旧偏移
      this.resetCursor();
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** 比对游标前那段哨兵：文件是否还停在我们上次读到的样子。 */
  private async guardMatches(handle: FileHandle, size: number): Promise<boolean> {
    if (this.readGuard.length === 0) {
      return true;
    }
    const guard = Buffer.from(this.readGuard, "utf8");
    if (guard.length > size) {
      return false;
    }
    const current = Buffer.alloc(guard.length);
    const { bytesRead } = await handle.read(current, 0, guard.length, size - guard.length);
    return bytesRead === guard.length && current.equals(guard);
  }

  /**
   * 前移游标并记下新的哨兵
   * @description 哨兵取「刚消费掉的最后 {@link CURSOR_GUARD_BYTES} 字节」。它在文件**尾部**，
   * 于是 `guardMatches` 的比对位置也是文件尾部 —— 落盘新行时内容变的是尾部**之后**的位置，
   * 哨兵本身不动，故正常追加不会误判成「被重写」。
   */
  private advanceCursor(consumed: Buffer): void {
    this.readCursor += consumed.length;
    const guard = consumed.subarray(Math.max(0, consumed.length - CURSOR_GUARD_BYTES));
    this.readGuard = guard.toString("utf8");
  }

  /**
   * 把一段**完整行**的文本 fold 进累积值
   * @description 与 `compactEntries` 的判据逐字同构：一条 entry 计入**当且仅当**它所属的
   * 窗口键等于**读取时刻**的当前窗口键（窗口重置小时 `resetHour` 现读，故热改立刻生效）。
   * 跨窗时整个槽位换键清零（已用量绝不跨窗口继承），而不是继续往上加。
   *
   * **建新对象而不是原地改**：累积 Map 的内层对象会被发布出去，原地改会让调用方手里上一轮
   * 的快照「自己在变」。
   */
  private foldText(text: string): void {
    const nowMs = this.clock();
    const resetHour = this.options.resetHour();
    const windows = new Map<string, QuotaWindow>();
    for (const entry of parseUsageEntries(text)) {
      let window = windows.get(entry.u);
      if (window === undefined) {
        window = this.windowFor(entry.u);
        windows.set(entry.u, window);
      }
      const key = windowKey(nowMs, window, resetHour);
      if (windowKey(entry.ts, window, resetHour) !== key) {
        continue;
      }
      const slot = this.authoritative.get(entry.u);
      this.authoritative.set(entry.u, {
        windowKey: key,
        total: slot === undefined || slot.windowKey !== key ? entry.b : slot.total + entry.b,
      });
    }
  }

  /** 读全量账本文本；`ENOENT`/`ENOTDIR`（文件还不存在）算空账本，其它错误上抛给调用方。 */
  private async readText(): Promise<string> {
    try {
      return await fsp.readFile(this.file, "utf8");
    } catch (error) {
      if (isMissing(error)) {
        return "";
      }
      throw error;
    }
  }

  /** 开 append 句柄；失败只报告并返回 undefined（调用方据此保持「暂不落盘」）。 */
  private async openAppend(): Promise<FileHandle | undefined> {
    try {
      return await fsp.open(this.file, "a");
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  /** 关句柄（幂等）。 */
  private async closeHandle(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    if (handle === undefined) {
      return;
    }
    try {
      await handle.close();
    } catch (error) {
      this.report(error);
    }
  }

  /**
   * 删掉上一次崩溃残留的 `.tmp`（best-effort）
   * @description **本模块从不读 `.tmp`**，所以残留的临时文件**不可能污染原文件**（这是
   * 「崩溃安全」那条护栏的事实基础）；删它只为不让垃圾一直堆着，删不掉（`EPERM`：另一个进程
   * 正开着它）只报告不阻断。
   */
  private async discardStaleTmp(): Promise<void> {
    const tmp = tmpPathOf(this.file);
    try {
      await fsp.unlink(tmp);
    } catch (error) {
      if (!isMissing(error)) {
        this.report(error);
      }
    }
  }

  /** 失败上抛给装配点的唯一出口（发 `usage.write-error` + error 日志）。 */
  private report(error: unknown): void {
    try {
      this.options.onError?.({ path: this.file, error });
    } catch {
      // 旁路抛错绝不能打断落盘主流程（那会把「写盘失败」升级成「代理崩」）
    }
  }
}
