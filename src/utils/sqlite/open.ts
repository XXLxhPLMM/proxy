/**
 * @fileoverview SQLite 驱动实现（两档）：Node 22.5+ 内置 / Node 16–22 WASM
 * @module utils/sqlite/open
 * @description
 * 账本端口（`./driver.ts`）的**唯一**实现装配点：按运行时版本挑一个驱动，账本代码里零分支。
 *
 * ## 分流判据是「能不能 `require` 到」，不是「主版本号 ≥ 22」
 *
 * 判据形如「`node:sqlite` 存在吗」而不是 `major >= 22`：`node:sqlite` 是 **22.5** 才加的，
 * 22.0–22.4 上 `require("node:sqlite")` 会抛 `MODULE_NOT_FOUND`。写 `major >= 22` 会在
 * 22.0–22.4 上**选错驱动然后崩**——而那正是「用版本号猜模块是否存在」这类判断的经典失败形态。
 * 故这里 `try` 一把 `require`，成败本身就是判据。
 *
 * ## 内置档的 `require` 必须是**惰性**的
 *
 * `import { DatabaseSync } from "node:sqlite"` 是**静态** import：esbuild 不会因为
 * 「这段代码在 Node 16 上跑不到」就放过它——打包产物里那句 `require("node:sqlite")`
 * 依然在文件顶层，Node 16 一加载就炸。所以内置档走 `createRequire(...)` **在调用点现取**，
 * 让「取不到」这件事退化成一个可以 catch 的普通异常。**这是本文件存在的头号理由。**
 *
 * ## 两条驱动都开 `busy_timeout`，理由各不相同
 *
 * - **WASM 档**（无 WAL，`journal_mode` 静默降级成 `delete`）：写锁是**排他**的，
 *   `busy_timeout` 是**唯一**能让并发写退让重试而不是立刻抛 `SQLITE_BUSY` 的东西。
 *   实测 4 进程 × 200 次同键 UPSERT：`busy=0`、合计精确 `800`。
 * - **内置档**（真 WAL）：同样需要——WAL 虽让读写不互斥，但**写与写**仍互斥。
 *
 * 两档都设成常量 `5000`：太长会让停机路径被锁拖住，太短会在高并发下误报失败。
 * 账本的写入形态是「每 `QUOTA_FLUSH_INTERVAL`（默认 5s）一次批量事务」，
 * 冲突窗口极短，5s 等待是数量级富余。
 *
 * ## WASM 档的 `.wasm` 二进制定位（打包形态的事实）
 *
 * `node-sqlite3-wasm` 用 `__dirname + "/"` 找 `node-sqlite3-wasm.wasm`。esbuild 打成单文件后
 * `__dirname` 变成 `dist/`，故构建必须把那个 `.wasm` 拷到与 `dist/app.js` 同级
 * （见 `build.mjs` 与 `package.json` 的 `pkg.assets`）。**这是构建链的责任，不是本模块的**——
 * 本模块只负责「require 到就说明二进制在」，找不到时驱动会自己抛，账本把它转成一条可见事件。
 *
 * @example
 * const open = openSqliteDriver();
 * const db = open("/abs/path/quota.db");
 * db.run("INSERT INTO usage(u,w,v) VALUES(?,?,?) ON CONFLICT(u,w) DO UPDATE SET v=v+excluded.v",
 *        ["alice", "2026-09", 1024]);
 * db.close();
 */

import { createRequire } from "node:module";
import type {
  OpenSqliteDriver,
  SqliteDriver,
  SqliteDriverChoice,
  SqliteDriverKind,
} from "./driver.js";
import type { SqlValue } from "./types.js";

/**
 * 并发写退让时长（毫秒）
 * @description 见文件头「两条驱动都开 `busy_timeout`」。它只在**写锁被占**时消耗，
 * 空闲时是一条不产生任何等待的 pragma。
 */
const BUSY_TIMEOUT_MS = 5000;

/**
 * 把驱动返回的行**摊成普通对象**
 * @description 两个实现都返回**null 原型**的对象（`node:sqlite` 是 `[Object: null prototype]`，
 * WASM 版是 `{}` 但同样不带 `Object.prototype`）。不一致的原型会让「冻结 / 比较 / 序列化」
 * 在两档运行时下行为不同，故在**唯一**的读出口摊平。
 * @description ⚠️ 逐键拷贝而非 `Object.assign({}, row)`：后者在 null 原型源上会走
 * `Object.assign` 的自有键枚举，行为其实相同，但**逐键**写法在「源上有多余键」时不会
 * 把它们带过去——账本读出的行只认自己声明的那几个列。
 */
function plain<T extends object>(row: T | undefined): T | undefined {
  if (row === undefined || row === null) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    out[key] = (row as Record<string, unknown>)[key];
  }
  return out as T;
}

/** 内置档：Node 22.5+ 的 `node:sqlite` */
function openBuiltin(file: string): SqliteDriver {
  // ⚠️ **惰性 require**：静态 import 会让打包产物在 Node 16 顶层就 require 它并炸掉
  // （见文件头「内置档的 require 必须是惰性的」）。取不到时抛出的 `MODULE_NOT_FOUND`
  // 由调用方（驱动分流）转成「换 WASM 档」，而调用方自己拿不到时才会看到它。
  const require = createRequire(__filename);
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => BuiltinDatabase;
  };
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  // 内置档**有**真 WAL：读写不互斥，多进程并发写的成本远低于 WASM 档。
  // 失败不致命（老版本文件系统 / 网络盘可能拒绝），账本仍可在默认 journal 下工作。
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    // 静默降级：WAL 是优化不是前提，`busy_timeout` 才是
  }
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => {
      db.prepare(sql).run(...(params ?? []));
    },
    get: <T extends object>(sql: string, params?: readonly SqlValue[]): T | undefined =>
      plain(db.prepare(sql).get(...(params ?? [])) as T | undefined),
    all: <T extends object>(sql: string, params?: readonly SqlValue[]): T[] =>
      (db.prepare(sql).all(...(params ?? [])) as T[]).map((row) => plain(row) as T),
    close: () => db.close(),
  };
}

/** `node:sqlite:DatabaseSync` 的最小形状（**结构声明**，不 import 那个模块） */
interface BuiltinDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: SqlValue[]): unknown;
    get(...params: SqlValue[]): unknown;
    all(...params: SqlValue[]): unknown[];
  };
  close(): void;
}

/** WASM 档：Node 16–22 的 `node-sqlite3-wasm` */
function openWasm(file: string): SqliteDriver {
  const require = createRequire(__filename);
  const { Database } = require("node-sqlite3-wasm") as {
    Database: new (path: string) => WasmDatabase;
  };
  const db = new Database(file);
  db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  // ⚠️ **刻意不设 `journal_mode = WAL`**：WASM 编译目标不支持共享内存，SQLite 会**静默降级**
  // 成 `delete`（实测 `PRAGMA journal_mode` 读回 `delete`，不报错）。设了它只会让人
  // 误以为有 WAL，而并发写实际靠 `busy_timeout` 串行化——**这条要写在代码里而不是注释里**，
  // 否则下一个人会照着「别忘了开 WAL」的好心建议去加一行，然后以为自己优化过了。
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => {
      // ⚠️ **参数个数不做任何补位/截断**：WASM 版的 `bind` 按 `values.length` 逐位绑定，
      // 多传一个就报 `column index out of range`（实测）。这意味着调用方若为
      // `excluded.v` 多带了一个 `?`，WASM 档会**直接炸**而内置档静默接受 ——
      // 于是「同一份 SQL 两档行为不同」。故账本侧的 UPSERT **必须只带 3 个参数**
      // （`excluded.v` 复用 `VALUES` 里的第 3 位），这是两档共用的唯一写法。
      db.run(sql, params === undefined ? undefined : [...params]);
    },
    get: <T extends object>(sql: string, params?: readonly SqlValue[]): T | undefined =>
      plain((db.get(sql, params === undefined ? undefined : [...params]) ?? undefined) as
        | T
        | undefined),
    all: <T extends object>(sql: string, params?: readonly SqlValue[]): T[] =>
      (db.all(sql, params === undefined ? undefined : [...params]) as T[]).map((row) =>
        plain(row) as T,
      ),
    close: () => db.close(),
  };
}

/** `node-sqlite3-wasm:Database` 的最小形状（**结构声明**，不依赖其类型包） */
interface WasmDatabase {
  exec(sql: string): void;
  run(sql: string, values?: unknown): unknown;
  get(sql: string, values?: unknown): unknown;
  all(sql: string, values?: unknown): unknown[];
  close(): void;
}

/**
 * `SqliteDriverFactory` = 档位标签 + 开库函数（**本文件的公开返回类型**）
 * @description 用具名 interface 而不是 `OpenSqliteDriver & { kind }` 那个交叉类型：
 * 交叉类型在「右侧返回的是函数」时调用签名解析会挑错重载，把 `factory(file)` 判成
 * 「多传了一个参数」。具名 interface 把那层歧义钉死，调用方只需认这一个名字。
 */
export type SqliteDriverFactory = SqliteDriverChoice;

/**
 * 选一档并返回一个**开库函数**（账本在 `open()` 时才真正建连接）
 * @description 分流判据 = `require("node:sqlite")` 成功与否（**不是**主版本号，
 * 理由见文件头）。返回值是一个**函数**而不是连接本身：账本是零成本档下**永不加载**的
 * 路径，构造期就建连接会让「没配配额的部署」也付一次打开文件的代价。
 * @param prefer - **显式指定档位**（缺省 = 按运行时自动分流）。生产路径不传它。
 *   它存在的唯一理由是**测试**：两档实现服务两个不同的部署形态（Node 22+ 与 Node 16–22），
 *   而「只测当前运行时那一档」等于让另一半用户吃零覆盖。显式指定后不可用就**抛**
 *   （而不是回落）——静默回落会让「这条用例其实测的是另一档」变成假绿。
 * @throws 指定的那一档在当前运行时不可用（`prefer` 显式给出且探测失败）
 */
export function openSqliteDriver(prefer?: SqliteDriverKind): SqliteDriverFactory {
  if (prefer !== undefined) {
    const impl = prefer === "builtin" ? tryBuiltin() : tryWasm();
    if (impl === undefined) {
      throw new Error(
        `SQLite 驱动的 ${prefer} 档在当前运行时 (${process.version}) 不可用`,
      );
    }
    return Object.assign(impl, { kind: prefer });
  }
  const builtin = tryBuiltin();
  return builtin !== undefined
    ? Object.assign(builtin, { kind: "builtin" as const })
    : Object.assign(openWasm, { kind: "wasm" as const });
}

/** 探内置档；取不到（Node < 22.5）返回 undefined。**探测用 require 本身**，不靠版本号。 */
function tryBuiltin(): OpenSqliteDriver | undefined {
  try {
    createRequire(__filename)("node:sqlite");
    return openBuiltin;
  } catch {
    return undefined;
  }
}

/** 探 WASM 档；依赖没装（`node_modules` 缺失）返回 undefined。 */
function tryWasm(): OpenSqliteDriver | undefined {
  try {
    createRequire(__filename)("node-sqlite3-wasm");
    return openWasm;
  } catch {
    return undefined;
  }
}
