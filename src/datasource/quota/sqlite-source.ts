/**
 * @fileoverview 用量数据源的 **sqlite 驱动**：单文件 SQLite，多进程共享同一份真相
 * @module datasource/quota/sqlite-source
 * @description
 * 用量镜像是**纯内存**的：进程一停，所有用量归零。这对「配了配额」的部署是最糟的故障形态
 * —— 用户每次重启都能白拿一份满额。本模块给这本账一个**持久**副本，且这份副本**是所有进程
 * 共用的同一份**；镜像的权威性完全建立在这份共享存储上（见 `./mirror.ts` 文件头的误差上界）。
 *
 * ## 为什么是 SQLite 而不是「每进程一个 JSONL 文件」
 *
 * 旧形态是 `<dir>/worker-<slot>.jsonl`，每个进程记自己一本，判定时也只恢复自己
 * 那本。**那是一个真实的配额逃逸**：判定语义写的是「账号级封禁」，而分槽之后实际变成
 * 「**每进程一份**封禁」——4 个进程时同一个账号能用满 `4 × quota.bytes`。根因不是
 * 「写错了」，而是**真相源被切成了 N 份**。要真正修好，只能让 N 个进程共享一份可并发写的
 * 存储；SQLite 正是这个东西。**零「槽位」概念**是这条的正确性要求，不是命名偏好。
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
 * **存「按 `(用户, 窗口键)` 求和后的绝对值」，而不是一行一条增量**：这正是换 SQLite 换来的
 * 东西——数据库能就地求和，于是「谁最后写」不再是唯一真相。纯文本形态必须「只写增量、读取时
 * 求和」，因为纯文本文件没有事务，两个 flush 交错就会互相覆盖。有了 UPSERT，累加是**数据库
 * 内部的原子操作**（`ON CONFLICT DO UPDATE SET v = v + excluded.v`），交错写不再丢失、也不再
 * 重复计。
 *
 * ## 判据：**增量入队、批量落库，绝不每 chunk 写一次库**
 *
 * `UsageMirror.consume` 是**每 chunk 调用一次**的同步函数，而 SQLite 的写入即使在最快的内置档
 * 上也要几十微秒（实测每 chunk 一次 `UPDATE…RETURNING` 是 61 µs，占事件循环 47.6%，见
 * `tests/unit/datasource/quota/consume-sync.test.ts` 第 ⑧ 条决策）。所以本模块严格维持既有的两层结构：
 * `record()` 只往内存数组 push（同步、零 IO），真正的 IO 在**周期循环**里按批落库。
 * `consume` 的同步性、耗时与磁盘无关这两条性质分毫未动。
 *
 * ## 一趟扫描同时干两件事（回读 + 清理过期窗口）
 *
 * `sweep()` 是本模块唯一的读路径：`SELECT u, w, v FROM usage` 取全表，然后**在内存里**按
 * 「该用户的当前窗口键」分两堆——
 * - 键相等 ⇒ 进 `current`（**回读出口**：推给镜像，于是别的进程写的字节在一个周期内可见）；
 * - 键不等 ⇒ 进 `stale`（**过期行**，逐对 `DELETE`）。
 *
 * **为什么合成一趟而不是先读后删两个查询**：两者对「什么算过期」必须是**同一个定义**，而它们
 * 判的是**同一批行**。分开做就会出现「读到的是清理之前的状态、删的是清理之后的」这种时序缝
 * ——具体形态是「本进程启动时正好跨过窗口边界」的那部分用量被当成过期删掉。同一趟里两个结论
 * 出自同一批行、同一份键计算，时序缝不存在。**代价是全表行进内存**：行数是「曾被计量过的
 * 用户数」，而这本来就是镜像每次回读要走的量级；json 档的同代价扫描（整文件解析）也在做同一
 * 件事。两个窗口类型同处一张表（窗口按用户取），所以判据不能是「等于某个键」而是「**属于
 * 某个用户的当前键**」。
 *
 * ## 写盘失败韧性
 *
 * 写失败（`SQLITE_BUSY` 超时 / `EACCES` / `ENOSPC`）时的正确形态**只有一种**：**内存计数继续
 * 走 + 未落库 delta 累积留待下次重试 + 发一条可见事实**。三条都必要：把服务拒了等于
 * 「磁盘满 → 代理全挂」；静默吞掉则让运维以为配额持久化了。整批 delta 放回队首（用 `concat`
 * 不用 `unshift(...batch)`——大批次上展开调用会打爆调用栈），下次一轮原样重试。
 *
 * **重试为什么不会重复计账**：落库走的是**幂等 UPSERT 累加**（`v = v + excluded.v`），而**整批
 * 包在一个事务里**（`BEGIN` / 每条 / `COMMIT`）。事务中途失败会**整批回滚**，所以「重试」面对
 * 的一定是「一条都没写进去」的库，绝不会写两遍。实测（WASM 档）：事务内第 3 条失败 → 库里
 * 为空 → 重试后精确 `100/100`。
 *
 * **回读在写失败时不会把未落库的字节抹掉**：合并用 `max`（`./mirror.ts:absorb`），权威值永远
 * 只增不减，所以「库里的值 < 镜像里的值」时镜像保持不动。
 *
 * ## 落盘是无条件的
 *
 * `open()` 不按「有没有人配配额」设门。门在这里会让**内存判定与落盘脱钩**——账号表是每 chunk
 * 现读的，运行中热加一个 `quota.bytes` 会让判定立刻封顶，而落库因为启动时判据为 false 而永远
 * 不开始（`record()` 直接丢弃增量），于是「在判定、零落库、`usage.db` 压根不存在」且日志一条不出。
 * 一条不变量管住：**在判定 ⇒ 一定在记账**。
 *
 * ## 为什么本文件**不读 `process.env`**
 *
 * 目录 / 周期 / 窗口口径 / 「有没有配额」全部由 `UsageSourceSpec` 的闭包注入（装配层从
 * `ConfigAccessor` 取值编成闭包）。真相源只有一份，压根没有「我是哪个 worker」这个问题，
 * 于是「按 worker 分槽」那条链（env 名、`takeSlot`、`slotByPid`、`normalizeSlot`）压根不需要
 * 存在。
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { startFlushLoop, type FlushLoopHandle } from "./flush-loop.js";
import { windowKey, type QuotaWindow } from "@/datasource/quota-window.js";
import type {
  UsageDirection,
  UsageSnapshot,
  UsageSourceController,
  UsageSourceSpec,
  UsageSink,
} from "./types.js";
import type { SqliteDriver, SqliteDriverFactory, SqlValue } from "@/utils/sqlite/index.js";
import { openSqliteDriver } from "@/utils/sqlite/index.js";

/** 账本数据库文件名（**只算路径，不碰磁盘**）。所有进程共用这一个文件。 */
export const USAGE_DB_NAME = "usage.db";

/**
 * 账本目录 + 文件名（**只算路径，不碰磁盘**）
 * @description 只接目录：真相源只有一份，「按 worker 分文件」正是那个配额逃逸的根因
 * （见文件头），所以这里没有任何进程标识的位置。
 */
export function usageDbFileName(dir: string): string {
  return path.join(dir, USAGE_DB_NAME);
}

/**
 * 建表语句（**表结构的唯一真相源**）
 * @description `IF NOT EXISTS` 让并发建表安全：两个 worker 同时启动时第二个拿到的是
 * 「已存在」而不是「表已存在」错误。`WITHOUT ROWID` 省掉一层 rowid 索引（主键就是全部列，
 * 再存一份行号纯属浪费），它对只有两列的表是净收益。
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
 * `v = v + ?`（4 个占位符）的话，**内置档静默通过、WASM 档直接炸**——同一份 SQL 在两档行为
 * 不同，这正是「两档驱动」最危险的那种分歧。故 UPSERT 刻意复用 `excluded.v`：字节数在语句里
 * **只出现一次**，参数个数与 `VALUES` 严格一致，两档行为必然相同。
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

/** 落盘数据源的构造选项（`UsageSourceSpec` + 本驱动自己的注入位） */
export interface SqliteUsageSourceOptions extends UsageSourceSpec {
  /**
   * 驱动工厂注入口（测试与「强制走某档」的调用方用；缺省按运行时版本分流）
   * @description 端口在 `utils/sqlite/driver.ts`，分流在 `open.ts`；把它做成**可注入**而不是
   * 硬编码，是为了让「WASM 档在 Node 22 上也能被测到」——否则 Node 22 CI 上 WASM 分支恒不
   * 执行，而那恰恰是 Node 16 用户唯一会走的路径（**恒不执行的分支等于没有测试**）。
   */
  readonly openDriver?: SqliteDriverFactory;
}

const wallClock = (): number => Date.now();

/**
 * SQLite 用量数据源
 * @description
 * 同时实现两个面：**`UsageSink`**（给镜像入队增量）与 **`UsageSourceController`**（给
 * `runtime.start/stop` 驱动开/关）。两个面分开的理由是两个调用方、两种失败代价。状态只有：
 * `file`（构造期算好的路径）、`db`（连接）、`pending`（未落库队列）、`active`。
 */
export class SqliteUsageSource implements UsageSink, UsageSourceController {
  /** 账本数据库路径（构造期纯计算，**不碰磁盘**）。 */
  public readonly file: string;

  private db: SqliteDriver | undefined;
  private pending: Pending[] = [];
  private active = false;
  private loop: FlushLoopHandle | undefined;
  /** 排空链：保证任何两轮严格串行（于是「同库并发写」在本进程内也不可能交错）。 */
  private tail: Promise<unknown> = Promise.resolve();

  private readonly dir: string;
  private readonly clock: () => number;
  private readonly windowFor: (user: string) => QuotaWindow;
  private readonly openDriver: SqliteDriverFactory;

  public constructor(private readonly options: SqliteUsageSourceOptions) {
    // 目录是 startup 相位：**只在这里读一次**（运行中改目录 = 已打开的连接仍指向旧文件）
    this.dir = options.dir();
    this.file = usageDbFileName(this.dir);
    this.clock = options.now ?? wallClock;
    this.windowFor = options.windowFor;
    // 分流**在构造期**做一次（而不是每次 `open()`）：`openSqliteDriver` 内部只做一次
    // `require` 探针，重复分流是纯浪费；而构造期分流也保证「同一个实例从头到尾用同一档」。
    this.openDriver = options.openDriver ?? openSqliteDriver();
  }

  /** 是否已启用（`open()` 成功且未 `close()`）。 */
  public get enabled(): boolean {
    return this.active;
  }

  /** 未落库的增量条数（观测口径：写库失败后它会累积——那是「用量在涨、库不认」的可见证据）。 */
  public get queued(): number {
    return this.pending.length;
  }

  /**
   * 启动数据源：建目录 → 连库建表 → **回读一次**（= 重启恢复）→ 清理过期窗口 → 起周期循环
   * @description
   * **无条件建**：不按「有没有人配配额」设门。门在这里的后果是「内存判定与落盘脱钩」——
   * 账号表是每 chunk 现读的，运行中热加一个 `quota.bytes` 会让判定立刻生效，而落库因为
   * 启动时那一次判据是 false 而**永远不开始**，于是「在判定、零落库、账本文件压根不存在」，
   * 且没有任何一条告警（判定侧只发 `usage.quota-exceeded`，它不关心落盘）。
   * 一条不变量管住这一层：**在判定 ⇒ 一定在记账**。
   *
   * **回读必须早于 `core.start()`**：本函数是在装配层的 `open()` 里同步链上的一次 await，
   * 排在开始收流量之前，所以「恢复完成」早于「开始计量」这条要求由**调用次序**保证，不由本模块
   * 自己操心。
   * 幂等：`open()` 在已启用时直接返回。
   */
  public async open(): Promise<void> {
    if (this.active) {
      return;
    }
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      this.db = this.openDriver(this.file);
      this.db.exec(CREATE_TABLE);
    } catch (error) {
      this.db = undefined;
      this.report(error);
      return;
    }

    this.sweep();

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
   * 真的只是 `pending.push` + 一次 `windowKey()` 计算。**无 Promise、无 IO、无 await**——
   * 所以 `consume` 的同步性与它的耗时都和数据库无关。未启用时**直接丢弃**：让队列
   * 无限增长才是 bug（那会让「没配配额」反而吃内存）。
   *
   * **窗口键在这里算，而不是等落库时才算**：判定侧（`./mirror.ts`）用**它自己那个时刻**算窗口
   * 键，本模块必须用**同一个**时刻、同一份 `windowFor`，否则同一批字节会被判到窗口 A 却记到
   * 窗口 B。`ts` 由 `consume` 显式传进来正是为此（端口契约见 `./types.ts:UsageSink`）。
   */
  public record(user: string, dir: UsageDirection, bytes: number, ts: number): void {
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
   * 跑一轮（周期定时器与停机路径共用）：**先落库，再回读**
   * @description
   * 顺序是语义的一部分（见 `./mirror.ts:mirrorLagBoundMs`）：落库在前 ⇒ 同一轮的回读一定
   * 含本进程这批字节，于是「回读值 ≥ 镜像值」恒成立，合并用 `max` 就是无操作 + 吸收别人的
   * 增量两件事。
   *
   * 走一条 **Promise 链**而不是「一个 in-flight Promise + 一个 want 标志」：后者在第二个
   * 调用者到达时只能返回**已经起跑的那一轮**，而那一轮未必包含它刚入队的 delta（调用者会拿到
   * 「我跑完了」的假保证）。链式写法让**每个调用者拿到的都是自己那一轮之后**的 Promise。
   * 链上两个 handler 相同是为了让「前一轮 reject」也不会卡死后续。
   *
   * **全程不抛**：落库失败与回读失败都经 `report` 上报。
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
   * 优雅停机：摘定时器 → **最后一轮**（落库 + 回读）→ 关连接
   * @description
   * 幂等（第二次调用是空转）。停机必须落库是**正确性要求**：队列里那些「已计入镜像判定、还没
   * 进数据库」的字节如果丢掉，用户就能靠反复「用一点、Ctrl+C」把配额窗口内的额度一次次刷新。
   * `active` 刻意在排空**之后**才置 false——提前置位会让 `runOnce` 直接 return，等于把最后一
   * 次落盘静默跳过。
   */
  public async close(): Promise<void> {
    this.loop?.stop();
    this.loop = undefined;
    await this.sync();
    this.closeDriver();
    this.active = false;
  }

  /** 一轮：把队列整批落进**一个事务**，然后跑一趟扫描回读 + 清理。全程不抛。 */
  private async runOnce(): Promise<void> {
    if (!this.active || this.db === undefined) {
      return;
    }
    // 队列空也要跑扫描：回读与清理是**独立**于「有没有新 delta」的动作，而「每轮都判一次」
    // 是它唯一能挂在周期循环上的方式。
    if (this.pending.length > 0) {
      this.drain();
    }
    this.sweep();
  }

  /** 整批落库（一个事务）。**全程不抛**：失败把整批放回队首并上报。 */
  private drain(): void {
    const db = this.db;
    if (db === undefined) {
      return;
    }
    const batch = this.pending;
    this.pending = [];
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
      // 顺序也重要：必须排在期间新入队的那些**之前**（那批字节发生得更早）。
      this.pending = batch.concat(this.pending);
      this.report(error);
    }
  }

  /**
   * 一趟扫描：**回读当前窗口的权威用量** + **删掉过期窗口的行**
   * @description
   * 一次全表 `SELECT` 之后**在内存里**按「该用户的当前窗口键」分流，而不是在 SQL 里拼
   * `IN (...)`：窗口键**按用户**取（`day` / `month` 两种用户同处一张表），集合要现算；而读回
   * 来的行数是「曾被计量过的用户数」，本来就是镜像每次回读要走的量级。在 SQL 里拼那个 `IN` 只
   * 会把「窗口键怎么算」这件事复制到 SQL 字符串里（而它已经有**一份**实现）。
   *
   * **回读与清理同出一趟**的理由见文件头「一趟扫描同时干两件事」——两者对「什么算过期」必须
   * 是同一个定义，且必须出自同一批行，否则「读到的是清理之前、删的是清理之后」这条时序缝会
   * 吃掉「本进程启动时正好跨过窗口边界」的那部分用量。
   *
   * **回读失败只报告不影响服务**：判定与落库都不依赖它（镜像退回到「上一次回读的值 + 本进程
   * 自己的增量」，偏差从一个周期变成无限——所以它必须可见，不能静默）。
   */
  private sweep(): void {
    const db = this.db;
    if (db === undefined) {
      return;
    }
    try {
      const rows = db.all<{ u: string; w: string; v: number }>("SELECT u, w, v FROM usage");
      const now = this.clock();
      const resetHour = this.options.resetHour();
      const current = new Map<string, { windowKey: string; total: number }>();
      const stale: SqlValue[] = [];
      // **本轮内按用户记忆窗口类型**：`windowFor` 的下游是账号表线性查表（现已降为
      // O(1) 的身份索引，但仍是一次 Map 查找 + 一次 `quotaWindow` 归一），而账本行数远大于
      // 账号数：主键 `(u, w)` 允许同一用户有多行（不同窗口的旧条目），逐行查表是 O(行数 × 查表)
      // —— 那正是本函数此前被实测到 5 万账号 / 5 万行时单轮 12.9 秒的原因。
      const windows = new Map<string, QuotaWindow>();
      for (const row of rows) {
        let window = windows.get(row.u);
        if (window === undefined) {
          window = this.windowFor(row.u);
          windows.set(row.u, window);
        }
        const live = windowKey(now, window, resetHour);
        if (row.w !== live) {
          // 旧窗口条目：判定侧不认，删掉（下方逐对 DELETE）
          stale.push(row.u, row.w);
          continue;
        }
        const cur = current.get(row.u);
        current.set(row.u, { windowKey: live, total: (cur?.total ?? 0) + row.v });
      }
      this.deleteStale(stale);
      this.publish(current);
    } catch (error) {
      this.report(error);
    }
  }

  /**
   * 逐对删除过期行（`(u, w)` 正是主键，故这是唯一索引上的点查）
   * @description
   * 刻意**不用** `IN (...)` 拼长串：过期行数无上限（jwt 的 `sub` 无界），一条超长 SQL 会撞
   * SQLite 的语句长度上限，而分批删除的失败面小得多。整批同样包在一个事务里，与累加共享同
   * 一条 Promise 链 ⇒ 本进程内不可能与累加交错。
   */
  private deleteStale(stale: SqlValue[]): void {
    const db = this.db;
    if (db === undefined || stale.length === 0) {
      return;
    }
    try {
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

  /**
   * 把回读结果推给镜像（`UsageSourceSpec.onSnapshot`）
   * @description **回注抛错只报告**：那是消费方（镜像）的义务，它抛错不该让数据源停止
   * 落库（账本仍可继续写与继续回读，下一轮镜像自己会重新吸收）。
   */
  private publish(current: UsageSnapshot): void {
    try {
      this.options.onSnapshot?.(current);
    } catch (error) {
      this.report(error);
    }
  }

  /** 关连接（幂等：停机路径上可能被走到两次）。 */
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

  /** 失败上抛给装配点的唯一出口（发 `usage.write-error` + error 日志）。 */
  private report(error: unknown): void {
    try {
      this.options.onError?.({ path: this.file, error });
    } catch {
      // 旁路抛错绝不能打断落盘主流程（那会把「写库失败」升级成「代理崩」）
    }
  }
}
