/**
 * @fileoverview 流量配额的**落盘账本**：delta 追加 + 恢复 + 压缩
 * @module core/traffic/ledger
 * @description
 * 内存账本是**纯内存**的：进程一停，所有用量归零。这对「配了配额」的部署是最糟的
 * 故障形态 —— 用户每次重启都能白拿一份满额。本模块给这本账一个**持久**的副本：
 *
 * - 文件：`<quotaLedgerDir>/worker-<slot>.jsonl`，**一行一条增量**：
 *   `{ ts, u, d, b }`（时刻 / 用户 / 方向 `"up"|"down"` / 字节数）。
 * - **只写增量，绝不写绝对值**：绝对值一律在**读取时按 `(用户, 窗口键)` 求和**得到。写绝对值
 *   等于让「谁最后写」成为唯一真相 —— 两个 flush 交错就会互相覆盖，且崩溃后留下的绝对值
 *   无法与已追加的增量对账。
 *
 * ## 槽位（slot）必须是稳定序号，不能用 PID
 *
 * 文件名里的 `<slot>` 是**稳定序号**：单进程/库模式恒为 `"0"`，cluster worker 为 `1..N`
 * （`cluster.ts` 在 fork 时注入 `PROXY_WORKER_SLOT`）。**用 PID 命名会让恢复永远失效**：
 * 每次重启 PID 都变，于是每个进程都开一个全新的空文件、旧文件再无人问津 —— 「持久化」
 * 变成了「每次都从零开始」。代价是同一台机器上跑两个实例会写同一个文件；那属于运维问题
 * （`QUOTA_LEDGER_DIR` 就是为分开它们而存在），代码不替它猜。
 *
 * **槽位值会被拼进文件路径**，所以 `normalizeSlot` 只认「1..9999 的纯数字」，其余一律回落
 * `"0"` —— 任何非数字内容都按**路径穿越面**处理（`PROXY_WORKER_SLOT=../../evil` 绝不能变成
 * 一个可写的文件路径）。cluster 派发的槽位必然落在合法域内（`CLUSTER_WORKERS` 上限 1024）。
 *
 * ## 为什么不读 `process.env`（本切片的一条铁律）
 *
 * `core/**` 与 `runtime/**` **一律不许读 `process.env`**：库调用方在浏览器/worker/测试里
 * 根本没有这个对象，而且「环境变量」是**宿主的形状**而不是库能拥有的输入。槽位因此是
 * **显式参数**，传递链是
 * `cli.ts` 的 env 快照 → `runServer(…, workerSlot)` → `ProxyServer.trafficSlot` →
 * `createProxyRuntime({ trafficWorkerSlot })` → `runtime/services.ts:buildDefaultServices` →
 * 本模块。而 env 名 `PROXY_WORKER_SLOT` 的**唯一写入方**是 `server/cluster.ts` 的 fork
 * （`core` → `server` 是被禁止的方向，所以这一环天然在 core 之外）。
 *
 * ## 两个压缩安全点（Windows 上 `EPERM` 的经典来源）
 *
 * 压缩要「读全量 → 求和 → 写 `.tmp` → `fs.rename` 覆盖」。**绝不能持有打开的 append 句柄时
 * 做这件事**：Windows 不允许 rename 覆盖一个仍被打开的文件（POSIX 允许），于是
 * `EPERM`。故流程被钉死为 `flush → close 句柄 → 压缩 → 重开句柄`，且压缩的**两个**触发点
 * 都在这个顺序里：
 * ① **启动时**：`open()` 里「读完立刻压缩，**然后**才开 append 句柄」（此时根本没有句柄）。
 * ② **运行期按文件大小阈值**（默认 8MiB）：在 flush 成功之后判断，超阈值则在**同一轮
 *    flush 内**把压缩做完（关句柄 → 压 → 重开）。
 *
 * 全程**没有并发压缩的可能**：Node 单线程 + 排空动作经一条 Promise 链串行化（`flush()`），
 * 所以「单线程，无并发」不是假设而是结构事实。
 *
 * ## 崩溃安全：`.tmp` + `rename`
 *
 * 压缩永远先写 `<file>.tmp` 再 `rename` 覆盖 `<file>`。`rename` 在同一卷上是原子的，
 * 所以**崩溃点只有两种**：`.tmp` 写了一半（`rename` 未发生 → 原文件完好）或 `rename` 已完成
 * （`.tmp` 已消失）。中间不存在「原文件被截断成半个」的态。启动时顺手把残留的 `.tmp`
 * 删掉（best-effort，失败只报告不阻断）——本模块**从不读** `.tmp`，所以即使删不掉，
 * 残留的 `.tmp` 也永远不可能污染原文件。
 *
 * ## 压缩丢弃已过期窗口的条目（5a/5b-1 留给本切片的那笔账）
 *
 * `compactEntries` 按 `(用户, 窗口键)` 求和，并且**只保留该用户当前窗口的那一条**：过期窗口
 * 的条目在这里消失。这正是「`authType=jwt` 的 `sub` 无限增长」这条限制的**持久那一半**的
 * 答案 —— 28 个 `sub` 跨 28 天之后，一次压缩就把文件清空，重启恢复时这些过期槽位
 * **根本不会回到内存**（详见 `memory.ts` 文件头对「已解决 / 未解决」的如实切分）。
 *
 * **保留的那一条带 `maxTs` 而不是压缩时刻**：`ts` 必须落在它所属的窗口内，重新压缩才会
 * 算出同一个键 → **压两次结果逐字节相同**（幂等）。若写成「压缩时刻」，两次压缩间隔只要
 * 跨过窗口边界就会产出不同内容，幂等这条护栏也就测不出东西了。
 *
 * ## 写盘失败韧性
 *
 * 写失败（`EACCES` / `ENOSPC` / …）时的正确形态只有一种：**内存计数继续走 + 未落盘 delta
 * 累积留待下次重试 + 发一条可见事实**。三条都必要：把服务拒了等于「磁盘满 → 代理全挂」
 * （配额功能不该有能力打垮数据面）；静默吞掉则让运维以为配额持久化了。
 * 整批 delta 会被放回队首（`this.pending = batch.concat(this.pending)`，不用 `unshift` ——
 * 大批次上 `unshift(...batch)` 会打爆调用栈），下次 flush 原样重试。
 *
 * **重试可能重复计一次账，这是刻意的方向选择**：`FileHandle.write()` 对本切片这种大小的
 * 缓冲要么整块写入、要么 reject，部分写入不通过返回的 Promise 暴露，我们也无法从断点续写。
 * 于是「写失败后重试」在理论上可能把某几行落两遍 —— 而**多算**是唯一安全的方向：
 * 少算 = 用户白拿额度（配额形同虚设），多算 = 少用一点额度（用户随时等下一个窗口）。
 * 压缩会把重复行按 `(用户, 窗口键)` 求和收敛回正确值，所以它也不会长期放大。
 *
 * ## 零成本档
 *
 * `enabled()` 为 false（**没有任何用户配了非全 0 的 `quota`**）时，`open()` 立刻返回：
 * **不建目录、不开句柄、不起定时器、不注册任何 fs 事件**，`record()` 也全程 no-op。
 * 判据是**文件事实**（`runtime/services.ts` 注入的 `hasConfiguredQuota`），不是配置猜测。
 */

import fsp from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import { startFlushLoop, type FlushLoopHandle } from "./flush-loop.js";
import { windowKey, type QuotaWindow } from "./window.js";
import type {
  RestoredLedger,
  RestoredUsage,
  TrafficDirection,
  TrafficLedgerController,
  TrafficLedgerError,
  TrafficSink,
} from "./types.js";

/**
 * 槽位 id 的 env 名：**唯一写入方**是 `server/cluster.ts` 的 fork。
 * @description 刻意**不进** `schema/fields.ts` 的 `FIELDS` 表：那是一张「配置项」表，而槽位
 * 不是配置项（不进 `ConfigStore`、不参与 `loadConfig`、不打印在 `logConfig` 的快照里）。
 * 把它塞进 FIELDS 会让 `tests/setup-env.ts:CONFIG_ENV_KEYS` 的「与 FIELDS 逐项相同」断言
 * 和「env 名的唯一真相源」都失去意义。
 */
export const TRAFFIC_SLOT_ENV = "PROXY_WORKER_SLOT";

/** 单进程 / 库模式的缺省槽位（cluster worker 用 `1..N`）。 */
export const DEFAULT_TRAFFIC_SLOT = "0";

/** 运行期压缩阈值（默认 8MiB）：账本文件超过它就在下一次 flush 里压缩。 */
export const DEFAULT_LEDGER_COMPACT_BYTES = 8 * 1024 * 1024;

/**
 * 归一槽位 id：只认 `1..9999` 的纯数字，其余（含 `undefined`）回落 `DEFAULT_TRAFFIC_SLOT`
 * @description 槽位会拼进文件路径，所以**任何非数字内容都按路径穿越面拒绝**，不是「尽量解析」。
 * 回落 `"0"` 在 cluster 场景下是错的（两个 worker 会共享一个文件），但那要求运维手工塞了
 * 一个非法 env —— 那种情况下**任何**兜底都是猜测，而猜测出来的文件位置会静默串账。
 * cluster 派发的槽位必然合法（见 `server/cluster.ts`），所以这条路只在手工 env 下可达。
 */
export function normalizeSlot(raw: string | undefined): string {
  if (typeof raw !== "string" || !/^\d{1,4}$/.test(raw)) {
    return DEFAULT_TRAFFIC_SLOT;
  }
  const n = Number.parseInt(raw, 10);
  return n >= 1 && n <= 9999 ? raw : DEFAULT_TRAFFIC_SLOT;
}

/** 账本目录 + 文件名（**只算路径，不碰磁盘**）：`worker-<slot>.jsonl` */
export function ledgerFileName(dir: string, slot: string | undefined): string {
  return path.join(dir, `worker-${normalizeSlot(slot)}.jsonl`);
}

/** 账本临时文件（压缩用）：`<file>.tmp`。本模块**从不读**它（见文件头「崩溃安全」）。 */
function tmpPathOf(file: string): string {
  return `${file}.tmp`;
}

/** 一行账本条目（**增量**，不是绝对值）。 */
export interface LedgerEntry {
  /** 记账时刻（毫秒时间戳）。窗口归属由它经 `windowKey()` 算出，故它必须与判定时刻同一个。 */
  readonly ts: number;
  /** 用户名。 */
  readonly u: string;
  /** 方向：`up` = 客户端→上游，`down` = 上游→客户端。 */
  readonly d: TrafficDirection;
  /** 本次字节数（恒为正整数；0/负数没有落盘意义）。 */
  readonly b: number;
}

/** 序列化：键序固定 `ts/u/d/b`，行尾带 `\n`（崩溃时最后一行最多是残缺的一行，读时跳过）。 */
function encodeEntry(entry: LedgerEntry): string {
  return `${JSON.stringify({ ts: entry.ts, u: entry.u, d: entry.d, b: entry.b })}\n`;
}

/**
 * 反序列化一行；**任何不合法的内容都返回 undefined（跳过）而不是抛错**
 * @description 账本文件可能是**残缺的**（崩溃在写一半、被人手改过、从别的实现迁过来）。
 * 抛错等于「一行脏数据让整个账本打不开」→ 配额整体失效；跳过等于「丢掉那一行的额度」。
 * 后者严格更安全：最坏情况是少算一点用量，**绝不会**把一份完整的账变成读不出来。
 */
function decodeEntry(line: string): LedgerEntry | undefined {
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
export function parseLedger(text: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    const entry = decodeEntry(line);
    if (entry !== undefined) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * 只认「**当前窗口**」的恢复：按用户求和，过期窗口的条目在此被丢弃
 * @description
 * 这是**判定侧唯一**读账本的地方，因此「账本里可能存在旧窗口的条目」这件事只在这里处理
 * 一次：条目 `ts` 各自经 `windowKey(entry.ts, 窗口类型, resetHour)` 算出它所属的窗口，
 * **不等于**读取那一刻的当前窗口键就直接跳过。
 *
 * 窗口类型**按用户**取（`windowFor` 注入的 `quotaWindow(users.json 的 quota.window)`）：
 * 有人配 `day`、有人配 `month`（或都没配 → 缺省 `month`），两种用户同处一个文件。
 *
 * 输出**每个用户至多一条**（`windowKey` 恒等于当前窗口键），所以 `MemoryTrafficAccount.seed`
 * 拿到的是「每人一份当前窗口的账」，不需要在内存侧再判窗口。
 *
 * @param entries - 账本里读到的全部条目（已跳过残缺行）
 * @param windowFor - 该用户生效的窗口类型
 * @param resetHour - 窗口重置小时（**本次读取时的口径**）
 * @param nowMs - 判定时刻
 */
export function summarizeCurrent(
  entries: readonly LedgerEntry[],
  windowFor: (user: string) => QuotaWindow,
  resetHour: number,
  nowMs: number,
): RestoredLedger {
  const out = new Map<string, RestoredUsage>();
  const currentKey = new Map<string, string>();
  for (const entry of entries) {
    const window = windowFor(entry.u);
    let key = currentKey.get(entry.u);
    if (key === undefined) {
      key = windowKey(nowMs, window, resetHour);
      currentKey.set(entry.u, key);
    }
    // 旧窗口条目在此被忽略：它们不参与判定，等压缩时才会从文件里消失
    if (windowKey(entry.ts, window, resetHour) !== key) {
      continue;
    }
    const cur = out.get(entry.u);
    const up = (cur?.up ?? 0) + (entry.d === "up" ? entry.b : 0);
    const down = (cur?.down ?? 0) + (entry.d === "down" ? entry.b : 0);
    out.set(entry.u, { windowKey: key, up, down });
  }
  return out;
}

/**
 * 压缩：按 `(用户, 窗口键)` 求和，**丢弃已过期窗口的条目**
 * @description
 * 与 {@link summarizeCurrent} 用**同一条**「只认当前窗口」的判据（同一个 `windowKey` 比较），
 * 两处判据刻意不合并成一份带副作用的函数：一条产出恢复结果、一条产出可写回文件的条目，
 * 但它们对「什么算过期」必须有同一个定义，否则会出现「恢复算进来的量比压缩保留的量多」。
 *
 * 保留条目的 `ts` 取**幸存条目里的最大 ts**（不是压缩时刻）：`ts` 必须落在该窗口内，
 * 这样再压一次算出的窗口键相同 → **压两次结果逐字节相同**（幂等）。顺带也让「这条用量
 * 最早/最晚发生在什么时候」这个诊断事实留在文件里。
 *
 * 每个用户产出至多**两条**（`up` 一条、`down` 一条）—— 一条 entry 只能有一个方向。
 * 某方向求和为 0 就不产出那一条（0 字节的条目对恢复毫无贡献）。
 */
export function compactEntries(
  entries: readonly LedgerEntry[],
  windowFor: (user: string) => QuotaWindow,
  resetHour: number,
  nowMs: number,
): LedgerEntry[] {
  interface Acc {
    key: string;
    up: number;
    down: number;
    ts: number;
  }
  const acc = new Map<string, Acc>();
  for (const entry of entries) {
    const window = windowFor(entry.u);
    let cur = acc.get(entry.u);
    if (cur === undefined) {
      cur = { key: windowKey(nowMs, window, resetHour), up: 0, down: 0, ts: entry.ts };
      acc.set(entry.u, cur);
    }
    if (windowKey(entry.ts, window, resetHour) !== cur.key) {
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
  const out: LedgerEntry[] = [];
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

/** 落盘账本的构造选项（全部由装配点显式注入，本模块零配置依赖） */
export interface JsonlTrafficLedgerOptions {
  /** 账本目录（`QUOTA_LEDGER_DIR`，startup 相位）。**不校验、不创建**。 */
  readonly dir: string;
  /** 槽位 id（`PROXY_WORKER_SLOT` 的值；`undefined` → `"0"`）。**稳定序号，不是 PID**。 */
  readonly slot?: string;
  /** flush 间隔 ms（`QUOTA_FLUSH_INTERVAL`，runtime 相位 → **每次现读**）。 */
  readonly flushMs: () => number;
  /** 窗口重置小时（`QUOTA_RESET_HOUR`，runtime 相位 → **每次现读**）。 */
  readonly resetHour: () => number;
  /** 该用户生效的窗口类型（配额来自 `users.json`，经装配点注入）。 */
  readonly windowFor: (user: string) => QuotaWindow;
  /** **文件事实**：是否有任何用户配了非全 0 的 `quota`。false → 零成本档。 */
  readonly enabled: () => boolean;
  /** 运行期压缩阈值字节数（默认 {@link DEFAULT_LEDGER_COMPACT_BYTES}）。 */
  readonly compactBytes?: () => number;
  /** 时钟源（可注入；默认墙钟）。压缩判「过期窗口」与恢复都用它。 */
  readonly now?: () => number;
  /** 恢复结果回注（装配点交给 `MemoryTrafficAccount.seed`）。 */
  readonly onRestore?: (restored: RestoredLedger) => void;
  /** 写盘/压缩失败的旁路（runtime 用它发 `traffic.ledger-error` + error 日志）。 */
  readonly onError?: (event: TrafficLedgerError) => void;
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
 * JSONL 落盘账本
 * @description
 * 同时实现两个面：**`TrafficSink`**（给内存账本入队增量）与 **`TrafficLedgerController`**
 * （给 `runtime.start/stop` 驱动开/关）。两个面分开是因为它们是**两个调用方**：前者被
 * `consume`（每 chunk）调用且必须同步，后者只在 start/stop 各调一次。
 *
 * 状态只有：`file`（构造期算好的路径）、`handle`（append 句柄）、`pending`（未落盘队列）、
 * `size`（文件字节数）、`compactedAt`（上次压缩后的字节数，用于「压不动就别反复压」）。
 */
export class JsonlTrafficLedger implements TrafficSink, TrafficLedgerController {
  /** 账本文件路径（构造期纯计算，**不碰磁盘**）。 */
  public readonly file: string;

  private handle: FileHandle | undefined;
  private pending: LedgerEntry[] = [];
  private size = 0;
  private compactedAt = 0;
  private active = false;
  private loop: FlushLoopHandle | undefined;
  /** 排空链：保证任何两次 flush 严格串行（压缩因此不可能并发，见文件头）。 */
  private tail: Promise<unknown> = Promise.resolve();

  private readonly clock: () => number;
  private readonly windowFor: (user: string) => QuotaWindow;
  private readonly threshold: () => number;

  public constructor(private readonly options: JsonlTrafficLedgerOptions) {
    this.file = ledgerFileName(options.dir, options.slot);
    this.clock = options.now ?? wallClock;
    this.windowFor = options.windowFor;
    this.threshold = options.compactBytes ?? ((): number => DEFAULT_LEDGER_COMPACT_BYTES);
  }

  /** 是否已启用（`open()` 成功且未 `close()`）。零成本档下恒为 false。 */
  public get enabled(): boolean {
    return this.active;
  }

  /** 未落盘的增量条数（观测口径：写盘失败后它会累积）。 */
  public get queued(): number {
    return this.pending.length;
  }

  /**
   * 启动账本：建目录 → 读回并压缩 → **然后**才开 append 句柄 → 起落盘定时器
   * @description
   * **零成本档的判据在这里**：`enabled()` 为 false（没有用户配了非全 0 的 `quota`）就
   * 立刻返回 —— 目录不建、句柄不开、定时器不起、fs 事件不注册。代价是**一次 stat**
   * （`users.json` 走 1s 节流缓存，启动期这一次不额外碰盘），换来的是「没配配额的部署
   * 完全零开销」。
   *
   * 顺序不可调换：**先压缩再开句柄**（否则 Windows 上 rename 覆盖打开的文件 → `EPERM`），
   * **恢复回注在压缩之前**（读到的必须是压缩前的全量，否则会漏掉「本次窗口之外、但仍
   * 该算的」条目 —— 实际上压缩的过滤判据与恢复的判据完全相同，所以顺序不影响正确性，
   * 但「先读后压」让「读到的是什么」这件事只取决于文件内容、不取决于我们是否压过）。
   *
   * 幂等：`open()` 在已启用时直接返回。
   */
  public async open(): Promise<void> {
    if (this.active) {
      return;
    }
    if (!this.options.enabled()) {
      return;
    }
    try {
      await fsp.mkdir(this.options.dir, { recursive: true });
    } catch (error) {
      this.report(error);
      return;
    }

    const text = await this.readText();
    this.size = Buffer.byteLength(text, "utf8");
    await this.discardStaleTmp();

    const restored = summarizeCurrent(
      parseLedger(text),
      this.windowFor,
      this.options.resetHour(),
      this.clock(),
    );
    try {
      this.options.onRestore?.(restored);
    } catch (error) {
      // 恢复回注是消费方的义务，它抛错不该让代理起不来（账本仍可继续写）
      this.report(error);
    }

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
        void this.flush();
      },
      this.options.flushMs,
    );
  }

  /**
   * 入队一条增量（`TrafficSink` 端口，被 `MemoryTrafficAccount.consume` 在**同步区间内**调用）
   * @description
   * 真的只是 `pending.push`。**无 Promise、无 IO、无 await** —— 所以 `consume` 的同步性
   * 与它的耗时都和磁盘无关。未启用（零成本档 / 未 open / 已 close）时**直接丢弃**：
   * 零成本档下让队列无限增长才是 bug（那会让「没配配额」反而吃内存）。
   */
  public record(user: string, dir: TrafficDirection, bytes: number, ts: number): void {
    if (!this.active) {
      return;
    }
    if (bytes <= 0 || !Number.isFinite(bytes)) {
      return;
    }
    this.pending.push({ ts, u: user, d: dir, b: bytes });
  }

  /**
   * 排空队列（周期定时器与停机路径共用）
   * @description
   * 走一条**Promise 链**而不是「一个 in-flight Promise + 一个 want 标志」：后者在第二个
   * 调用者到达时只能返回**已经起跑的那一轮**，而那一轮未必包含它刚入队的 delta（调用者
   * 会拿到「我 flush 完了」的假保证）。链式写法让**每个调用者拿到的都是自己那一轮之后**
   * 的 Promise，且严格串行 —— 压缩因此不存在并发可能。
   *
   * 链上两个 handler 都是 `runOnce`：`runOnce` 内部整体 try/catch、**永不 reject**，故
   * 失败不会污染链；两个 handler 相同是为了让「前一轮 reject」也不会卡死后续。
   */
  public flush(): Promise<void> {
    const next = this.tail.then(
      () => this.runOnce(),
      () => this.runOnce(),
    );
    this.tail = next;
    return next;
  }

  /**
   * 优雅停机：摘定时器 → **最后一次排空** → 关句柄
   * @description
   * 幂等（第二次调用是空转）。停机必须落盘是**正确性要求**：队列里那些「已计入内存判定、
   * 还没进磁盘」的字节如果丢掉，用户就能靠反复「用一点、Ctrl+C」把配额窗口内的额度一次次
   * 刷新。`active` 刻意在排空**之后**才置 false —— 提前置位会让 `runOnce` 直接 return，
   * 等于把最后一次落盘静默跳过。
   */
  public async close(): Promise<void> {
    this.loop?.stop();
    this.loop = undefined;
    await this.flush();
    await this.closeHandle();
    this.active = false;
  }

  /** 一轮排空：补开句柄 → 追加本批 → 达阈值则压缩。全程不抛。 */
  private async runOnce(): Promise<void> {
    if (!this.active) {
      return;
    }
    try {
      if (this.handle === undefined) {
        // 上一次开句柄失败过（目录被删、权限被改）——**每轮都补试一次**，
        // 否则「一次开失败」会变成「此后再也不落盘」。
        this.handle = await this.openAppend();
        if (this.handle === undefined) {
          return;
        }
      }
      if (this.pending.length === 0) {
        // 队列空也要判阈值：上一轮可能写失败过（size 没涨）或有未达阈值的遗留
        if (this.needCompact()) {
          await this.compact(true);
        }
        return;
      }
      const batch = this.pending;
      this.pending = [];
      try {
        const text = batch.map(encodeEntry).join("");
        await this.handle.write(text, undefined, "utf8");
        this.size += Buffer.byteLength(text, "utf8");
      } catch (error) {
        // **未落盘的 delta 留待下次重试**（不是丢弃）：整批放回队首。
        // 用 `concat` 而不是 `unshift(...batch)`——大批次上展开调用会打爆调用栈。
        // 顺序也重要：必须排在 flush 期间新入队的那些**之前**（那批字节发生得更早）。
        this.pending = batch.concat(this.pending);
        this.report(error);
        return;
      }
      if (this.needCompact()) {
        await this.compact(true);
      }
    } catch (error) {
      // 压缩/补开句柄那一层的失败（它们自己已经 report 过，这里只兜 unforeseen）
      this.report(error);
    }
  }

  /**
   * 是否该压缩
   * @description 第二个条件（`size > compactedAt`）是为了**不反复压同一种已经压不动的内容**：
   * 一份「本来就每个用户一条」的账本压完大小不变，若只看第一个条件就会**每次 flush 都压一遍**
   * （每次都要读全文件 + 写临时文件 + rename）。压完把 `compactedAt` 抬到当前 size，
   * 于是只有在文件**又长起来**之后才会再次触发。
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
   * → **原文件完好**，只需照常重开句柄继续 append；过期条目会混在后续 append 里，但**判定
   * 侧本来就只认当前窗口**（`summarizeCurrent`），正确性不依赖「文件已经干净」。
   *
   * 全程不抛：任何失败都经 `report` 上报，并在收尾里尽力把句柄开回来 —— 一个
   * 压缩失败绝不能变成「此后再也不落盘」。
   *
   * @param reopen - 压缩后是否重开 append 句柄。**只有一处例外不重开**：`open()` 里那次
   *   启动期压缩（此刻本来就还没有句柄，调用方紧接着自己开）。开两次会泄漏一个句柄，
   *   而 Windows 上泄漏的打开句柄会让后续 `rename` 覆盖本文件直接 `EPERM` —— 这个坑
   *   真实踩过一次（表现为「压缩静默不生效、文件一字不变」）。
   */
  private async compact(reopen: boolean): Promise<void> {
    const before = this.size;
    await this.closeHandle();
    try {
      const text = await this.readText();
      const kept = compactEntries(
        parseLedger(text),
        this.windowFor,
        this.options.resetHour(),
        this.clock(),
      );
      const out = kept.map(encodeEntry).join("");
      const tmp = tmpPathOf(this.file);
      await fsp.writeFile(tmp, out, "utf8");
      await fsp.rename(tmp, this.file);
      this.size = Buffer.byteLength(out, "utf8");
    } catch (error) {
      this.report(error);
    }
    this.compactedAt = Math.min(before, this.size);
    if (reopen) {
      this.handle = await this.openAppend();
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
   * @description
   * **本模块从不读 `.tmp`**，所以残留的临时文件**不可能污染原文件**（这是「崩溃安全」那条
   * 护栏的事实基础）。删它只为不让垃圾一直堆着；删不掉（`EPERM`：另一个进程正开着它）
   * 只报告不阻断。
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

  /** 失败上抛给装配点的唯一出口（发 `traffic.ledger-error` + error 日志）。 */
  private report(error: unknown): void {
    try {
      this.options.onError?.({ path: this.file, error });
    } catch {
      // 旁路抛错绝不能打断落盘主流程（那会把「写盘失败」升级成「代理崩」）
    }
  }
}
