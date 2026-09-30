/**
 * @fileoverview 流量配额的**落盘账本**：单文件 SQLite，多进程共享同一份真相
 * @module core/traffic/sqlite-ledger
 * @description
 * 内存账本是**纯内存**的：进程一停，所有用量归零。这对「配了配额」的部署是最糟的
 * 故障形态 —— 用户每次重启都能白拿一份满额。本模块给这本账一个**持久**副本，
 * 且这份副本**是所有进程共用的同一份**。
 *
 * ## 为什么是 SQLite 而不是「每 worker 一个 JSONL 文件」
 *
 * 旧形态是 `<dir>/worker-<slot>.jsonl`，每个 cluster worker 记自己一本，判定时也只
 * 恢复自己那本。**那是一个真实的配额逃逸**：判定语义写的是「账号级封禁」，而分槽之后
 * 实际变成「**每进程一份**封禁」——4 个 worker 时同一个账号能用满 `4 × quota.bytes`。
 * 根因不是「写错了」，而是**真相源被切成了 N 份**。要真正修好，只能让 N 个进程共享
 * 一份可并发写的存储；SQLite 正是这个东西。
 *
 * ## 表结构（**唯一**的真相源就在这段 SQL 上）
 *
 * ```sql
 * CREATE TABLE IF NOT EXISTS usage (
 *   u TEXT NOT NULL,      -- 用户名
 *   w TEXT NOT NULL,      -- 窗口键（`YYYY-MM` 或 `YYYY-MM-DD`）
 *   v INTEGER NOT NULL,   -- 双向合计已用字节（方向不切分：只有一个上限）
 *   PRIMARY KEY (u, w)
 * )
 * ```
 *
 * **存「按 `(用户, 窗口键)` 求和后的绝对值」，而不是一行一条增量**：这正是换 SQLite
 * 换来的东西——数据库能就地求和，于是「谁最后写」不再是唯一真相。旧的 JSONL 形态必须
 * 「只写增量、读取时求和」，因为纯文本文件没有事务，两个 flush 交错就会互相覆盖。
 * 有了 UPSERT，累加是**数据库内部的原子操作**（`ON CONFLICT DO UPDATE SET v = v + excluded.v`），
 * 交错写不再丢失、也不再重复计。
 *
 * ## 判据：**增量入队、批量落库，绝不每 chunk 写一次库**
 *
 * `MemoryTrafficAccount.consume` 是**每 chunk 调用一次**的同步函数，而 SQLite 的写入即便
 * 在最快的内置档上也要几十微秒（实测每 chunk 一次 `UPDATE…RETURNING` 是 61 µs，占事件循环
 * 47.6%，见 `tests/unit/traffic-account.test.ts` 第 ⑧ 条决策）。所以本模块严格维持
 * 既有的两层结构：**`record()` 只往内存数组 push**（同步、零 IO），真正的 IO 在
 * **flush 定时器**里按批落库。`consume` 的同步性、耗时与磁盘无关这两条性质分毫未动。
 *
 * ## 写盘失败韧性（与旧形态逐条同形）
 *
 * 写失败（`SQLITE_BUSY` 超时 / `EACCES` / `ENOSPC`）时的正确形态**只有一种**：**内存计数
 * 继续走 + 未落库 delta 累积留待下次重试 + 发一条可见事实**。三条都必要：把服务拒了等于
 * 「磁盘满 → 代理全挂」；静默吞掉则让运维以为配额持久化了。整批 delta 放回队首
 * （用 `concat` 不用 `unshift(...batch)`——大批次上展开调用会打爆调用栈），下次 flush 原样重试。
 *
 * **重试为什么不会重复计账**：落库走的是**幂等 UPSERT 累加**（`v = v + excluded.v`），
 * 而**整批包在一个事务里**（`BEGIN` / 每条 / `COMMIT`）。事务中途失败会**整批回滚**，
 * 所以「重试」面对的一定是「一条都没写进去」的库，绝不会写两遍。实测（WASM 档）：
 * 事务内第 3 条失败 → 库里为空 → 重试后精确 `100/100`。
 *
 * ## 零成本档
 *
 * `enabled()` 为 false（**没有任何用户配了非 0 的 `quota.bytes`**）时，`open()` 立刻返回：
 * **不建目录、不连库、不建表、不起定时器**。判据是**文件事实**（装配点注入的
 * `hasConfiguredQuota`），不是配置猜测。
 *
 * ## 窗口过期：一条 `DELETE` 顶掉整条压缩机制
 *
 * 旧形态的压缩（按 `(用户, 窗口键)` 求和 + 丢弃过期窗口 + `.tmp`+`rename` + Windows
 * EPERM「两个安全点」）在数据库里是一条 SQL：
 *
 * ```sql
 * DELETE FROM usage WHERE w <> ?   -- ? = 读取那一刻的窗口键集合
 * ```
 *
 * 窗口类型**按用户**取（`windowFor` 注入的 `quota.window`），两种用户可以同处一张表，
 * 所以判据不能是「等于当前键」而是「**不属于任何用户的当前键**」——实现见 {@link pruneExpired}。
 *
 * ## 为什么本文件**不读 `process.env`**
 *
 * 旧形态的槽位号由 `cli.ts` 从 env 快照经参数逐层传进来（`PROXY_WORKER_SLOT`），
 * 唯一写入方是 `server/cluster.ts` 的 fork。**换 SQLite 之后这条链整条不需要了**：
 * 真相源只有一份，压根没有「我是哪个槽位」这个问题。`server/cluster.ts` 的 `takeSlot()`、
 * `slotByPid`、`normalizeSlot()`、`TRAFFIC_SLOT_ENV` 一并删除。
 */

import fsp from "node:fs/promises";
import path from "node:path";
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
import type { SqliteDriver, SqliteDriverFactory, SqlValue } from "@/utils/sqlite/index.js";
import { openSqliteDriver } from "@/utils/sqlite/index.js";

/** 账本数据库文件名（**只算路径，不碰磁盘**）。所有进程共用这一个文件。 */
export const LEDGER_DB_NAME = "quota.db";

/**
 * 账本目录 + 文件名（**只算路径，不碰磁盘**）
 * @description 与旧形态的 `ledgerFileName(dir, slot)` 同签名去掉 `slot`——真相源只有一份，
 * 「按 worker 分文件」正是那个配额逃逸的根因（见文件头）。
 */
export function ledgerFileName(dir: string): string {
  return path.join(dir, LEDGER_DB_NAME);
}

/**
 * 建表语句（**表结构的唯一真相源**）
 * @description `IF NOT EXISTS` 让并发建表安全：两个 worker 同时启动时第二个拿到的是
 * 「已存在」而不是「表已存在」错误。`WITHOUT ROWID` 省掉一层 rowid 索引
 * （主键就是全部列，再存一份行号纯属浪费），它对只有两列的表是净收益。
 */
const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS usage (
  u TEXT NOT NULL,
  w TEXT NOT NULL,
  v INTEGER NOT NULL,
  PRIMARY KEY (u, w)
) WITHOUT ROWID
`;

/**
 * 累加语句（**幂等累加**：`v = v + excluded.v`）
 * @description **只带 3 个占位符**（`(u, w, bytes)`），`excluded.v` 复用 `VALUES` 里的第 3 位。
 *
 * ⚠️ **这个「3」不是随手写的**：WASM 版驱动按 `params.length` 逐位绑定，多传一个就报
 * `column index out of range`（实测），而内置 `node:sqlite` 接受多余参数。于是写成
 * `v = v + ?`（4 个占位符）的话，**内置档静默通过、WASM 档直接炸**——同一份 SQL 在两档
 * 行为不同，这正是「两档驱动」最危险的那种分歧。故 UPSERT 刻意复用 `excluded.v`：
 * 字节数在语句里**只出现一次**，参数个数与 `VALUES` 严格一致，两档行为必然相同。
 */
const UPSERT =
  "INSERT INTO usage (u, w, v) VALUES (?, ?, ?) " +
  "ON CONFLICT (u, w) DO UPDATE SET v = v + excluded.v";

/** 一条累加（`record()` 入队时的形状）。**刻意不含 `ts`**：窗口键在入队那一刻就定死了。 */
interface Pending {
  readonly u: string;
  readonly w: string;
  readonly b: number;
}

/** 落盘账本的构造选项（全部由装配点显式注入，本模块零配置依赖） */
export interface SqliteTrafficLedgerOptions {
  /** 账本目录（`QUOTA_LEDGER_DIR`，startup 相位）。**不校验、不创建**。 */
  readonly dir: string;
  /** flush 间隔 ms（`QUOTA_FLUSH_INTERVAL`，runtime 相位 → **每次现读**）。 */
  readonly flushMs: () => number;
  /** 窗口重置小时（`QUOTA_RESET_HOUR`，runtime 相位 → **每次现读**）。 */
  readonly resetHour: () => number;
  /** 该用户生效的窗口类型（配额来自 `users.json`，经装配点注入）。 */
  readonly windowFor: (user: string) => QuotaWindow;
  /** **文件事实**：是否有任何用户配了非 0 的 `quota.bytes`。false → 零成本档。 */
  readonly enabled: () => boolean;
  /** 时钟源（可注入；默认墙钟）。窗口键计算与「过期窗口」判定都用它。 */
  readonly now?: () => number;
  /** 恢复结果回注（装配点交给 `MemoryTrafficAccount.seed`）。 */
  readonly onRestore?: (restored: RestoredLedger) => void;
  /** 落库失败的旁路（runtime 用它发 `traffic.ledger-error` + error 日志）。 */
  readonly onError?: (event: TrafficLedgerError) => void;
  /**
   * 驱动工厂注入口（测试与「强制走某档」的调用方用；缺省按运行时版本分流）
   * @description 端口在 `driver.ts`，分流在 `open.ts`；把它做成**可注入**而不是硬编码，
   * 是为了让「WASM 档在 Node 22 上也能被测到」——否则 Node 22 CI 上 WASM 分支恒不执行，
   * 而那恰恰是 Node 16 用户唯一会走的路径（**恒不执行的分支等于没有测试**）。
   */
  readonly openDriver?: SqliteDriverFactory;
}

const wallClock = (): number => Date.now();

/**
 * SQLite 落盘账本
 * @description
 * 同时实现两个面：**`TrafficSink`**（给内存账本入队增量）与
 * **`TrafficLedgerController`**（给 `runtime.start/stop` 驱动开/关）。两个面分开的理由
 * 是两个调用方、两种失败代价。状态只有：`file`（构造期算好的路径）、`db`（连接）、
 * `pending`（未落库队列）、`active`。
 */
export class SqliteTrafficLedger implements TrafficSink, TrafficLedgerController {
  /** 账本数据库路径（构造期纯计算，**不碰磁盘**）。 */
  public readonly file: string;

  private db: SqliteDriver | undefined;
  private pending: Pending[] = [];
  private active = false;
  private loop: FlushLoopHandle | undefined;
  /** 排空链：保证任何两次 flush 严格串行（于是「同库并发写」在本进程内也不可能交错）。 */
  private tail: Promise<unknown> = Promise.resolve();

  private readonly clock: () => number;
  private readonly windowFor: (user: string) => QuotaWindow;
  private readonly openDriver: SqliteDriverFactory;

  public constructor(private readonly options: SqliteTrafficLedgerOptions) {
    this.file = ledgerFileName(options.dir);
    this.clock = options.now ?? wallClock;
    this.windowFor = options.windowFor;
    // 分流**在构造期**做一次（而不是每次 `open()`）：`openSqliteDriver` 内部只做一次
    // `require` 探针，重复分流是纯浪费；而构造期分流也保证「同一个账本实例从头到尾用同一档」。
    this.openDriver = options.openDriver ?? openSqliteDriver();
  }

  /** 是否已启用（`open()` 成功且未 `close()`）。零成本档下恒为 false。 */
  public get enabled(): boolean {
    return this.active;
  }

  /** 未落库的增量条数（观测口径：写库失败后它会累积——那是「用量在涨、库不认」的可见证据）。 */
  public get queued(): number {
    return this.pending.length;
  }

  /**
   * 启动账本：建目录 → 连库建表 → 读回当前窗口 → 清理过期窗口 → 起落库定时器
   * @description
   * **零成本档的判据在这里**：`enabled()` 为 false 就立刻返回——目录不建、连接不开、
   * 建表不跑、定时器不起。代价是**一次 stat**（`users.json` 走 1s 节流缓存，启动期这一次
   * 不额外碰盘），换来的是「没配配额的部署完全零开销」。
   *
   * 顺序：建表 → **读回**（恢复）→ 清理过期窗口。恢复必须在清理**之前**，否则会把
   * 「本进程启动时正好跨过窗口边界」的那部分用量当成过期数据删掉。
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
      this.db = this.openDriver(this.file);
      this.db.exec(CREATE_TABLE);
    } catch (error) {
      this.db = undefined;
      this.report(error);
      return;
    }

    this.restore();
    this.pruneExpired();

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
   * 真的只是 `pending.push` + 一次 `windowKey()` 计算。**无 Promise、无 IO、无 await**——
   * 所以 `consume` 的同步性与它的耗时都和数据库无关。未启用时**直接丢弃**：零成本档下
   * 让队列无限增长才是 bug（那会让「没配配额」反而吃内存）。
   *
   * **窗口键在这里算，而不是等 flush 时才算**：判定侧（`memory.ts`）用**它自己那个时刻**
   * 算窗口键，账本必须用**同一个**时刻、同一份 `windowFor`，否则同一批字节会被判到窗口 A
   * 却记到窗口 B。`ts` 由 `consume` 显式传进来正是为此（端口契约见 `types.ts:TrafficSink`）。
   */
  public record(user: string, dir: TrafficDirection, bytes: number, ts: number): void {
    if (!this.active) {
      return;
    }
    if (bytes <= 0 || !Number.isFinite(bytes)) {
      return;
    }
    void dir; // 方向只作排障事实透出；判定只有一个合计上限，故表里不存方向
    this.pending.push({
      u: user,
      w: windowKey(ts, this.windowFor(user), this.options.resetHour()),
      b: bytes,
    });
  }

  /**
   * 排空队列（周期定时器与停机路径共用）
   * @description
   * 走一条 **Promise 链**而不是「一个 in-flight Promise + 一个 want 标志」：后者在第二个
   * 调用者到达时只能返回**已经起跑的那一轮**，而那一轮未必包含它刚入队的 delta（调用者
   * 会拿到「我 flush 完了」的假保证）。链式写法让**每个调用者拿到的都是自己那一轮之后**的
   * Promise。链上两个 handler 相同是为了让「前一轮 reject」也不会卡死后续。
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
   * 优雅停机：摘定时器 → **最后一次排空** → 关连接
   * @description
   * 幂等（第二次调用是空转）。停机必须落库是**正确性要求**：队列里那些「已计入内存判定、
   * 还没进数据库」的字节如果丢掉，用户就能靠反复「用一点、Ctrl+C」把配额窗口内的额度一次次
   * 刷新。`active` 刻意在排空**之后**才置 false——提前置位会让 `runOnce` 直接 return，
   * 等于把最后一次落库静默跳过。
   */
  public async close(): Promise<void> {
    this.loop?.stop();
    this.loop = undefined;
    await this.flush();
    this.closeDriver();
    this.active = false;
  }

  /**
   * 周期性清理过期窗口的行（**运行期**那一份；启动期那一次在 `open()` 里）
   * @description
   * jwt 的 `sub` 由外部签发、理论上可产生任意多用户名，所以这张表**不清理就会单调增长**。
   * 清理判据是「不属于该用户当前窗口」，而窗口类型**按用户**取（`windowFor`），
   * 故它必须在**有账可算**的时刻做——`QUOTA_FLUSH_INTERVAL` 那个节奏正合适：
   * 它已经是一次「账本要动」的时机，再挂一次清理不额外惊动任何人。
   *
   * **为什么放在 flush 定时器里而不是另起一个定时器**：本目录的定时器站点**唯一**是
   * `flush-loop.ts`（零 `setInterval` 是既有护栏）。而清理本身是「一次落库动作」，
   * 挂进 flush 循环里既省掉第二个定时器，也让「清理」和「累加」共享同一条串行 Promise 链——
   * 于是本进程内**不可能**出现「清理与累加交错」。
   *
   * 清理失败**只报告不影响服务**（用量判定与落库都不依赖它：过期行不参与判定，
   * 见 `restore()` 那里「只认当前窗口」的过滤）。
   */
  private pruneExpiredIfDue(): void {
    if (this.db === undefined) {
      return;
    }
    this.pruneExpired();
  }

  /** 一轮排空：整批在**一个事务**里落库。**全程不抛。 */
  private async runOnce(): Promise<void> {
    if (!this.active || this.db === undefined) {
      return;
    }
    // 队列空也要走一遍：清理过期窗口是**独立**于「有没有新 delta」的动作，
    // 而「每轮都判一次」是它唯一能挂在 flush 循环上的方式（见 `pruneExpiredIfDue`）。
    if (this.pending.length === 0) {
      this.pruneExpiredIfDue();
      return;
    }
    const batch = this.pending;
    this.pending = [];
    const db = this.db;
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const entry of batch) {
          db.run(UPSERT, [entry.u, entry.w, entry.b]);
        }
        db.exec("COMMIT");
      } catch (error) {
        // 回滚后整批放回队首：**未落库的 delta 留待下次重试**（不是丢弃）。
        // 事务保证库里此刻一条都没写进去，故重试不会重复计账。
        try {
          db.exec("ROLLBACK");
        } catch {
          // 回滚本身失败（连接已断）——外层 catch 会报告，真正要紧的是把 delta 放回去
        }
        throw error;
      }
    } catch (error) {
      // 用 `concat` 而不是 `unshift(...batch)`——大批次上展开调用会打爆调用栈。
      // 顺序也重要：必须排在 flush 期间新入队的那些**之前**（那批字节发生得更早）。
      this.pending = batch.concat(this.pending);
      this.report(error);
    }
    // 累加之后顺手清理：与它共享同一条 Promise 链 ⇒ 本进程内不可能交错（见
    // `pruneExpiredIfDue`）。放**之后**而不是之前：先把这批字节落稳，再处理旧行。
    this.pruneExpiredIfDue();
  }

  /**
   * 读回当前窗口的用量并回注
   * @description
   * 一次全表 `SELECT` 之后**在内存里**按「该用户的当前窗口键」过滤，而不是在 SQL 里
   * 拼 `IN (...)`：窗口键**按用户**取（`day` / `month` 两种用户同处一张表），集合要现算；
   * 而读回来的行数是「曾被计量过的用户数」，本来就是内存账本启动后要逐个走一遍的量级。
   * 在 SQL 里拼那个 `IN` 只会把「窗口键怎么算」这件事复制到 SQL 字符串里（而它已经有
   * **一份**实现 `window.ts`）。
   */
  private restore(): void {
    const db = this.db;
    if (db === undefined) {
      return;
    }
    try {
      const rows = db.all<{ u: string; w: string; v: number }>("SELECT u, w, v FROM usage");
      const now = this.clock();
      const restored = new Map<string, RestoredUsage>();
      for (const row of rows) {
        const current = windowKey(now, this.windowFor(row.u), this.options.resetHour());
        if (row.w !== current) {
          continue; // 旧窗口条目：判定侧不认，留给 prune 清理
        }
        const cur = restored.get(row.u);
        restored.set(row.u, { windowKey: current, total: (cur?.total ?? 0) + row.v });
      }
      this.options.onRestore?.(restored);
    } catch (error) {
      // 恢复回注是消费方的义务，它抛错不该让代理起不来（账本仍可继续写）
      this.report(error);
    }
  }

  /**
   * 清理**不属于任何用户当前窗口**的行
   * @description
   * 窗口类型**按用户**取，故判据不能是「`w` 等于某个键」。做法是逐用户判「这一行的窗口键
   * 是不是该用户当前的窗口键」，只删两者都不匹配的行。
   *
   * 复杂度是 O(行数) 而非 O(用户数)——但**只有过期行才被 DELETE**，正常情况下删除语句
   * 匹配 0 行、代价是常数；真正要扫的行数等于「过期用户的行数」，而那正是需要清掉的量级。
   *
   * **为什么需要它**：`authType=jwt` 的 `sub` 由外部签发，理论上可产生任意多用户名 →
   * 不清理的话这张表单调增长。旧形态靠「压缩时丢弃过期窗口」达到同一个目的，
   * 这里是那条机制的数据库形态：**一条语句顶掉整套压缩**。
   */
  private pruneExpired(): void {
    const db = this.db;
    if (db === undefined) {
      return;
    }
    try {
      const rows = db.all<{ u: string; w: string }>("SELECT u, w FROM usage");
      const now = this.clock();
      const stale: SqlValue[] = [];
      for (const row of rows) {
        if (row.w === windowKey(now, this.windowFor(row.u), this.options.resetHour())) {
          continue;
        }
        stale.push(row.u, row.w);
      }
      if (stale.length === 0) {
        return;
      }
      // 逐对删除（`(u, w)` 正是主键，故这是唯一索引上的点查）。刻意**不用** `IN (...)` 拼
      // 长串：过期行数无上限（jwt 的 sub 无界），一条超长 SQL 会撞 SQLite 的语句长度上限，
      // 而分批删除的失败面小得多。
      db.exec("BEGIN IMMEDIATE");
      try {
        for (let i = 0; i < stale.length; i += 2) {
          db.run("DELETE FROM usage WHERE u = ? AND w = ?", [stale[i], stale[i + 1]]);
        }
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // 同上：回滚失败由外层报告
        }
        throw error;
      }
    } catch (error) {
      this.report(error);
    }
  }

  /** 关连接（幂等：停机路径上可能被走到两次，见 `driver.ts:close`）。 */
  private closeDriver(): void {
    const db = this.db;
    this.db = undefined;
    if (db === undefined) {
      return;
    }
    try {
      db.close();
    } catch (error) {
      this.report(error);
    }
  }

  /** 失败上抛给装配点的唯一出口（发 `traffic.ledger-error` + error 日志）。 */
  private report(error: unknown): void {
    try {
      this.options.onError?.({ path: this.file, error });
    } catch {
      // 旁路抛错绝不能打断落库主流程（那会把「写库失败」升级成「代理崩」）
    }
  }
}
