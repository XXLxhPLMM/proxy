/**
 * @fileoverview 本地库插件：按 `ctx.cfg` 开库（`openDb`）→ 结构同步（`ensureSchema`）→ 才把句柄挂成服务 `ctx.db`；
 *   卸载时关库（`closeDb`）；监听 `config.reload`，`database` 节变了就重启本 fiber（= 按新配置重开库）
 * @module starter/plugins/db
 * @description
 * 句柄的**生与死**都在这里：打开后挂 effect 关掉，卸载时由 fiber 撤销——消费者只消费 `ctx.db`，
 * 不各开各的连接（SQLite 单写者，单进程单连接）。数据源与地址从 `ctx.cfg.get("database")` 读
 * （`DbConfig` 形状；默认值住 `@/config`）。服务类型按 Cordis 惯例在**提供者的文件里**声明（`declare module`）。
 *
 * ## 事件（动手前后各一条，形状见 `@/starter/index.js`；载荷一律只给「哪个库」，**不给句柄**）
 * - `db.opening`（**开库前**）：载荷是**将要开的那个库**，`ctx.db` 此刻还不可用。
 * - `db.opened`（开库后）：监听者一进回调就能拿到刚开的库（⚠️ 但还没同步过结构，别碰表）。
 * - `db.syncing`（**同步前**）：⚠️ 这一步会动用户的库文件（删列 / 重建表），UI 该有段时间显示「在改结构」。
 * - `db.synced`：结构同步跑完了（动了或没动都发），载荷是**结构化**的 `SchemaSyncResult`（差异 + 已做的账）。
 * - `db.failed`：开库或同步失败（两者都是「插件装载失败」，用哪条区分）；随后闸门不开，这条只管让 UI 停转。
 * - `db.closed`：fiber 卸载、库已关之后（⚠️ 开库成功但同步失败时也会发：库开了又被这条收掉）。
 *
 * ⚠️ **闸门**：`ctx.db` 是**同步过的**句柄，只有本插件跑完结构同步才 provide。
 *   同步期间全应用谁也拿不到库 —— 不是一个「记得别用」的纪律，是**没得绕**（全树只有这一处 provide）。
 * ⚠️ 开库失败 / 同步失败都 = 本插件装载失败：只有预设 `await` 了本插件，它才会变成启动失败
 *   （理由见 `@/starter/index.js`）⇒ 一个插件都不会动。
 * ⚠️ 关库 effect 必须**紧跟 `openDb` 成功**注册、早于 `ensureSchema`：本插件体抛错时 fiber 会卸载，
 *   effect 已注册才关得掉库；注册晚了同步一失败就漏一个连接（文件句柄 + WAL 文件）。
 * ⚠️ `closeDb` 抛了就不发 `closed`：宁可少报，也不谎报「已关」。
 * ⚠️ 重开库走 `ctx.fiber.restart()`：卸载（关旧库 + 撤服务 → 依赖方先停）再重跑本插件体（新配置开库 +
 *   重新同步 + 重新挂服务 → 依赖方随服务通知刷新）。重开是**异步**的，`reload()` 的调用方拿到返回时库未必已换完。
 * ⚠️ **`db/` 层不认识 cordis**：事件与人话都在本文件，`db/sqlite/upgrade/` 只负责把账交回来。
 */

import type { Context } from "cordis";
import { closeDb, openDb, type Db, type DbConfig, type DbDialect } from "@/db/dialect.js";
import { ensureSchema } from "@/db/sqlite/init.js";
import type { AppliedChange, SchemaSyncResult } from "@/db/sqlite/upgrade/index.js";

/** 一句人话的出口：`db/` 层不认识 cordis，故由本插件把「报给谁」这条回调传进去 */
type Report = (message: string) => void;

declare module "cordis" {
  interface Context {
    /**
     * **同步过**的本地库句柄（由 `dbPlugin` 在结构同步做完后提供）
     * ⚠️ 全应用**唯一**一处 provide 库的地方：拿到它就意味着结构已与 `db/sqlite/schemas/` 一致。
     *   要碰表就用它；`dao/` 只带「有哪些行操作」，**不带库**，库永远显式当第一个参数传。
     */
    db: Db;
  }
  interface Events {
    /** 开库前：将要开的那个库，此刻 `ctx.db` 还不可用 */
    "db.opening"(ref: DbRef): void;
    /** 开库后：此时能拿到库，但结构还没同步，别碰表 */
    "db.opened"(ref: DbRef): void;
    /** 同步前：⚠️ 这一步会动用户的库文件 */
    "db.syncing"(): void;
    /** 同步后：差异 + 已做的账 */
    "db.synced"(result: SchemaSyncResult): void;
    /** 开库或同步失败：随后闸门不开，这条只管让 UI 停转 */
    "db.failed"(error: Error): void;
    /** 库已关闭 */
    "db.closed"(ref: DbRef): void;
  }
}

/** 只说「哪个库」，**不给句柄**（句柄已经是服务 `ctx.db`，再塞一份是第二份真值） */
export interface DbRef {
  /** 方言（只有 `sqlite` 能真开） */
  dialect: DbDialect;
  /** 库文件路径（sqlite）/ 连接串（mysql / pgsql 那两格还没实现，见 `openDb`） */
  target: string;
}

/** 动作 → 人话（打日志与事件之外的展示都用这一份口径） */
const ACTION_TEXT: Record<AppliedChange["action"], string> = {
  "add-column": "补列",
  "drop-column": "删列",
  "add-index": "建索引",
  "drop-index": "删索引",
  "rebuild-table": "重建表",
};

/** 开库配置译成「哪个库」（判据与 `openDb` 的 switch 逐档对齐） */
function refOf(config: DbConfig): DbRef {
  switch (config.dialect) {
    case "sqlite":
    case undefined:
      return { dialect: "sqlite", target: config.path };
    default:
      return { dialect: config.dialect, target: config.url };
  }
}

/** 插件抛出来的东西未必是 `Error`（`throw "boom"` 合法），统一成 `Error` 再交给监听者 */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** 把同步的账打成人话（⚠️ 删列 / 重建表是自动的，这些行日志就是唯一的告知）：动了什么一行一条 */
function reportSync(ctx: Context, result: SchemaSyncResult): void {
  for (const change of result.applied) {
    const note = change.note === undefined ? "" : `（${change.note}）`;
    ctx.logger.warn(`本地库结构已${ACTION_TEXT[change.action]}：${change.table}.${change.target}${note}`);
  }
  if (result.applied.length === 0) {
    ctx.logger.info("本地库结构已是最新，无需同步");
  }
}

/** 开库 → 结构同步 → 才把「同步过的句柄」挂成 `ctx.db`；任一步失败 = 装载失败 = 启动失败 */
export function dbPlugin(ctx: Context): void {
  const config = ctx.cfg.get("database");
  const ref = refOf(config);
  ctx.emit("db.opening", ref); // 动手之前：让 UI 先画上 loading
  // `db/` 层不碰 cordis：告知的话由这里接成一条 warn（WAL 回滚那种动过用户文件的事）
  const report: Report = (message) => ctx.logger.warn(message);
  let db: Db;
  try {
    db = openDb(config, report); // 开库失败 = 插件装载失败
  } catch (error) {
    try {
      // `ctx.emit` 会把监听器抛的错原样冒出来，不兜就会顶掉真正的开库错
      ctx.emit("db.failed", asError(error));
    } catch {
      // 监听器自己坏了，它已经在自己的栈里炸过一次，这里不再叠一个
    }
    throw error;
  }
  // ⚠️ 必须早于 `ensureSchema` 注册：本插件体后面抛错时靠这条收库（见文件头）
  ctx.effect(() => () => {
    closeDb(db); // 幂等；抛了就不发 `db.closed`（见文件头）
    ctx.emit("db.closed", ref);
  });
  ctx.emit("db.opened", ref);

  ctx.emit("db.syncing"); // 动手之前：让 UI 先显示「在改结构」
  let result: SchemaSyncResult;
  try {
    result = ensureSchema(db);
  } catch (error) {
    try {
      ctx.emit("db.failed", asError(error));
    } catch {
      // 监听器自己坏了，它已经在自己的栈里炸过一次，这里不再叠一个
    }
    throw error;
  }
  reportSync(ctx, result);

  ctx.provide("db", db); // 闸门：过了这一行，全应用才拿得到库（⚠️ 必须在 ensureSchema 之后）
  ctx.emit("db.synced", result);

  ctx.on("config.reload", ({ changed }) => {
    if (!changed.includes("database")) return; // 相关配置没变：库照旧，不动
    // 失败（新库开不起来）由 fiber 走 `ctx.logger.error` 汇报，这里只吞掉 rejection，不留未处理的 promise
    void ctx.fiber.restart().catch(() => {});
  });
}

dbPlugin.inject = ["cfg"]; // 等配置装载完成才加载（顺序由容器排，与预设里的挂载次序无关）