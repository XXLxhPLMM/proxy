/**
 * @fileoverview SQLite 驱动的**端口**：账本只认这四个方法，不认任何具体实现
 * @module utils/sqlite/driver
 * @description
 * 账本需要的能力极小——建表、一条 UPSERT、一条 SELECT、一条 DELETE。它们被收成
 * {@link SqliteDriver} 端口，于是「用哪个 SQLite」降级成**装配期的一次选择**，
 * 账本代码里零分支。
 *
 * ## 为什么需要这层（两档运行时并存）
 *
 * 本仓要同时支持两档运行时，而 `node:sqlite`（Node 内置）要到 **Node 22.13** 才**免 flag**
 * （22.5 出生时仍需 `--experimental-sqlite`）。16/18/20/22.0–22.12 上不带 flag 的
 * `require("node:sqlite")` 一律 `ERR_UNKNOWN_BUILTIN_MODULE`——不是 API 差异，
 * 是模块用不了。故两档各有一个实现（同在 `./open.ts` 里：`openBuiltin` / `openWasm`）：
 *
 * | 运行时 | 实现 | 并发写能力 |
 * | --- | --- | --- |
 * | Node ≥ 22.13 | `node:sqlite`（内置，零依赖） | **真 WAL**（读写不互斥） |
 * | Node 16 – 22.12 | `node-sqlite3-wasm`（纯 WASM，无 native 编译） | 无 WAL，靠 `busy_timeout` 串行化 |
 *
 * 实测（WASM 档，4 进程 × 200 次同键 UPSERT）：`busy=0`、最终合计精确 `800`，
 * 即 `busy_timeout` + 幂等 UPSERT 足以扛住本仓的写入形态（每 flush 几秒一次）。
 *
 * ## 为什么账本只需要这四个方法（而不是「暴露一个通用 SQL 执行器」）
 *
 * 通用执行器看起来更灵活，实则把 SQL 文本散落到调用方，于是「这张表长什么样」就有
 * 多个真相源。端口只收**四件已经确定要做的事**（建表 / 累加 / 读一个用户的当前窗口 /
 * 清理过期窗口），表结构因此**只有 `ledger.ts` 一处**能改。
 *
 * ## 为什么端口方法是**同步**的
 *
 * `UsageSink.record` 由 `UsageMirror.consume` 在**无 await 的同步区间内**调用
 * （每 chunk 一次）。账本的 IO 因此全部安排在它自己的 flush 周期里（异步），
 * 而这里的同步方法只在 flush 回调与 `open()` 内被调用——**不在热路径上**。
 * 同步也正是两个 SQLite 实现共同的能力面：WASM 版根本没有异步 API。
 */

import type { SqlValue } from "./types.js";

/**
 * 一个已打开的数据库连接（**同步**端口）
 * @description 四个方法都是同步的，形状由两个实现共同满足：
 * `node:sqlite` 的 `DatabaseSync#prepare` 与 `node-sqlite3-wasm` 的 `Database#run/get/all`。
 * 实现**不必**自己 prepare 再复用语句——账本的调用频率是「每 flush 一次」，
 * 语句缓存收益远小于「少一层封装」的收益。
 */
export interface SqliteDriver {
  /**
   * 执行一条不返回结果集的语句（`CREATE TABLE` / `DELETE` / `PRAGMA` / 事务控制）。
   * @throws 实现方的原始异常（账本侧统一 catch 并转成 `UsageSourceError` 事件）
   */
  exec(sql: string): void;
  /**
   * 执行一条带位置参数、**不返回结果集**的语句（累加用量走这条）。
   * @param sql - 含 `?` 占位符的 SQL
   * @param params - 按占位符顺序的实参
   */
  run(sql: string, params?: readonly SqlValue[]): void;
  /**
   * 取**第一行**结果；无匹配行返回 `undefined`。
   * @description 返回 `undefined` 而不是 `null` 是为了与本仓其余读面（`readJsonCached`
   * 的 `value` 恒非空、`loadUserQuota` 缺省 `undefined`）同一形状。
   */
  get<T extends object>(sql: string, params?: readonly SqlValue[]): T | undefined;
  /**
   * 取**全部**结果行；无匹配返回空数组（**绝不返回 undefined**）。
   * @description 返回的行是**普通对象**（实现方负责剥掉原型链上的东西），
   * 否则 `Object.freeze` 之类的下游操作会因 null 原型而行为异常。
   */
  all<T extends object>(sql: string, params?: readonly SqlValue[]): T[];
  /**
   * 关闭连接（幂等）。
   * @description 幂等是**调用方的要求**而非实现方的义务：`close()` 在停机路径上可能被
   * 走到两次（`runtime.stop()` 与 `ProxyServer.stop()` 各一次，见 `flush-loop.ts` 文件头），
   * 而「关两次」抛错会把一次正常的停机变成失败。
   */
  close(): void;
}

/**
 * 打开一个数据库连接
 * @description 端口的**另一半**（工厂）。它与 {@link SqliteDriver} 分开是因为「怎么打开」
 * 恰好是两档实现唯一真正不同的地方（`new DatabaseSync(file)` vs `new Database(file)`），
 * 而那点差异不该污染调用点。
 * @param file - 数据库文件路径（**必填真路径**，绝不接受目录；`:memory:` 由实现方自行放行）
 * @returns 已打开的连接
 */
export type OpenSqliteDriver = (file: string) => SqliteDriver;

/**
 * **一个进程里选好的那一档**（`SqliteDriverFactory`）
 * @description 它是 `OpenSqliteDriver`（**开库**）+ `kind`（哪一档），由
 * `open.ts:openSqliteDriver` 产出。**刻意与 `OpenSqliteDriver` 分成两个名字**：
 * 前者是「怎么开一个库」，后者是「本进程用哪一档实现」。账本持有后者（它要 `.kind` 便于
 * 诊断），于是它不必在每次 `open()` 时重新做分流。
 */
export interface SqliteDriverChoice extends OpenSqliteDriver {
  /** 本进程实际使用的那一档（诊断与测试断言用；**不参与任何判据**）。 */
  readonly kind: SqliteDriverKind;
}

/** 档位标签（与 {@link SqliteDriverChoice.kind} 同源，单独导出供调用方标注类型）。 */
export type SqliteDriverKind = "builtin" | "wasm";
