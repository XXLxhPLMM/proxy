/**
 * @fileoverview 本地库插件：按 `ctx.cfg` 开库（`openDb`）并把句柄挂成服务 `ctx.database`，卸载时关库（`closeDb`）；
 * 监听 `config.reload`，`database` 节变了就重启本 fiber（= 按新配置重开库）
 * @module starter/plugins/database
 * @description
 * 句柄的**生与死**都在这里：打开后 `ctx.provide`，卸载时由 effect 关掉——消费者只消费 `ctx.database`，
 * 不各开各的连接（SQLite 单写者，单进程单连接）。
 * 数据源与地址从 `ctx.cfg.get("database")` 读（`DbConfig` 形状；默认值住 `@/config`）。
 * 服务类型按 Cordis 惯例在**提供者的文件里**声明（`declare module`）。
 *
 * ## 事件（动手前后各一条，形状见 `@/starter/index.js`）
 * - `database.opening`（**开库前**）：载荷是**将要开的那个库**，`ctx.database` 此刻还不可用。
 * - `database.opened`（开库后，排在 `ctx.provide` 之后）：监听者一进回调就能用 `ctx.database`。
 * - `database.failed`：开库失败；随后本插件**照旧装载失败**（这条只管让 UI 停转）。
 * - `database.closed`：fiber 卸载、库已关之后。
 * ⚠️ `closeDb` 抛了就不发 `closed`：宁可少报，也不谎报「已关」。
 *
 * ⚠️ 开库失败 = 插件装载失败：只有预设 `await` 了本插件，它才会变成启动失败（理由见 `@/starter/index.js`）。
 * ⚠️ 重开库走 `ctx.fiber.restart()`：卸载（关旧库 + 撤服务 → 依赖方先停）再重跑本插件体（新配置开库 +
 *   重新挂服务 → 依赖方随服务通知刷新）。重开是**异步**的，`reload()` 的调用方拿到返回时库未必已换完。
 */

import type { Context } from "cordis";
import { closeDb, openDb, type Db, type DbConfig, type DbDialect } from "@/db/dialect.js";

/** 一句人话的出口：`db/` 层不认识 cordis，故由插件把「报给谁」这条回调传进去 */
type Report = (message: string) => void;

/** 开库 / 关库事件的载荷：只给「哪个库」，**不给句柄**（句柄已经是服务 `ctx.database`，再塞一份是第二份真值） */
export interface DatabaseRef {
  /** 方言（今天只有 `sqlite` 能真开） */
  dialect: DbDialect;
  /** 库文件路径（sqlite）/ 连接串（mysql / pgsql 那两格还没实现，见 `openDb`） */
  target: string;
}

declare module "cordis" {
  interface Context {
    /**
     * 本地库句柄（由 `databasePlugin` 提供）
     * ⚠️ 这是**打开但未必同步过结构**的句柄：业务插件要碰表就注入 `ctx.library`（`schemaPlugin` 同步完才提供），
     * 本服务只给「开库 / 关库 / 重开」这条链自己用
     */
    database: Db;
  }
  interface Events {
    /** 开库前：将要开的那个库，此刻 `ctx.database` 还不可用 */
    "database.opening"(ref: DatabaseRef): void;
    /** 开库后：此时 `ctx.database` 已可用 */
    "database.opened"(ref: DatabaseRef): void;
    /** 开库失败：随后本插件装载失败 = 启动失败，这条只管让 UI 停转 */
    "database.failed"(error: Error): void;
    /** 库已关闭 */
    "database.closed"(ref: DatabaseRef): void;
  }
}

/** 开库配置译成「哪个库」（判据与 `openDb` 的 switch 逐档对齐） */
function refOf(config: DbConfig): DatabaseRef {
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

/** 开库并挂成 `ctx.database`（数据源 / 地址从 `ctx.cfg.get("database")` 读），卸载时关库 */
export function databasePlugin(ctx: Context): void {
  const config = ctx.cfg.get("database");
  const ref = refOf(config);
  ctx.emit("database.opening", ref); // 动手之前：让 UI 先画上 loading
  // `db/` 层不碰 cordis：告知的话由这里接成一条 warn（WAL 回滚那种动过用户文件的事）
  const report: Report = (message) => ctx.logger.warn(message);
  let db: Db;
  try {
    db = openDb(config, report); // 开库失败 = 插件装载失败
  } catch (error) {
    try {
      // `ctx.emit` 会把监听器抛的错原样冒出来，不兜就会顶掉真正的开库错
      ctx.emit("database.failed", asError(error));
    } catch {
      // 监听器自己坏了，它已经在自己的栈里炸过一次，这里不再叠一个
    }
    throw error;
  }
  ctx.provide("database", db); // 注册服务；fiber 卸载时自动撤销
  ctx.emit("database.opened", ref);
  ctx.effect(() => () => {
    closeDb(db); // 幂等；抛了就不发 `database.closed`（见文件头）
    ctx.emit("database.closed", ref);
  });
  ctx.on("config.reload", ({ changed }) => {
    if (!changed.includes("database")) return; // 相关配置没变：库照旧，不动
    // 失败（新库开不起来）由 fiber 走 `ctx.logger.error` 汇报，这里只吞掉 rejection，不留未处理的 promise
    void ctx.fiber.restart().catch(() => {});
  });
}

databasePlugin.inject = ["cfg"]; // 等配置装载完成才加载（顺序由容器排，与预设里的挂载次序无关）