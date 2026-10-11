/**
 * @fileoverview 降级档驱动：`node-sqlite3-wasm`（Node 16–22.12）
 * @description
 * ## 为什么要垫适配层：drizzle 要位置数组，wasm 只出对象行
 *
 * drizzle 的查询（select/insert/update/delete/count）全走 `mode: "arrays"`，按列下标映射；
 * `node-sqlite3-wasm` 只有「列名 → 值」的对象行。故这里按**键序**把对象行摊成数组，前提是
 * 「无重名列、键序 = 列序」——护栏在执行前用预备语句的列名逐个比对行键，⚠️ join 出来的
 * 重名列在对象里会**静默丢列**，对不上就抛，拒绝返回错数据。
 *
 * 护栏读 `Statement#_getColumnNames()`——node-sqlite3-wasm 的私有 API（0.8.x 实测在；
 * 本包把该依赖钉在 `^0.8` 就是为它）。
 *
 * ## ⚠️ 不开 WAL
 *
 * WASM 编译目标没有共享内存，SQLite 会把 `journal_mode = WAL` 静默降级成 `delete`，
 * 写了只会让人误以为有 WAL。
 *
 * ## 静态 import 的理由（与 builtin 档相反，别照抄那边的惰性写法）
 *
 * 本包产物 `dist/cli.js` 由 esbuild **完全内联**（见 `build.mjs`），运行期不解析 npm 包。
 * 走静态 import 才能让胶水层 JS 被打进产物；`.wasm` 二进制（1.2MB）esbuild 内联不了，
 * 由 `build.mjs` 复制到 `dist/` 旁边，emscripten 用 `__dirname` 定位它（`__dirname` 由 banner 注入）。
 * ⚠️ 代价是**模块顶层就实例化 wasm**（实测 ≈24ms），即使用户走 builtin 档也付；换来的是
 * 降级档在产物里开箱即用、别人装包不必额外带 `node-sqlite3-wasm`。
 */

import wasmModule from "node-sqlite3-wasm";
import type { SqliteClient } from "./types.js";

/** `node-sqlite3-wasm:Database` 的最小形状（结构声明，不用它的类型包） */
interface WasmDatabase {
  run(sql: string, values?: unknown): unknown;
  all(sql: string, values?: unknown): unknown[];
  get(sql: string, values?: unknown): unknown;
  prepare(sql: string): WasmStatement;
  close(): void;
  readonly isOpen: boolean;
}

/** `node-sqlite3-wasm:Statement` 的最小形状；`_getColumnNames` 是私有实现细节，见文件头 */
interface WasmStatement {
  finalize(): void;
  _getColumnNames?(): string[];
}

/** 降级档模块形状（见上面两个 `Wasm*` 声明）。该包是 CJS，`Database` 挂在 `module.exports` 上 */
interface WasmModule {
  Database: new (path: string) => WasmDatabase;
}

/** 取 `Database` 构造器（该包是 CJS 风格导出：`module.exports = Module`，`Database` 挂其上） */
function getWasmModule(): WasmModule {
  // 顶层 import 的产物形状：esbuild 打成 ESM 时是 default，CJS interop 下可能直接是 exports 本身
  const candidate = (wasmModule as unknown as { default?: WasmModule }).default ?? (wasmModule as unknown as WasmModule);
  return candidate;
}

/** 当前运行时能不能加载降级档（wasm 已随产物内联，这里只认 `Database` 在不在） */
export function canUseWasm(): boolean {
  try {
    return typeof getWasmModule().Database === "function";
  } catch {
    return false;
  }
}

/** 校验「行键序 = 列序」且无重名；对不上（join 重名、整数样列名被 JS 重排）就抛 */
function assertColumnOrder(db: WasmDatabase, sql: string, rows: unknown[]): void {
  if (rows.length === 0) return;

  const stmt = db.prepare(sql);
  let names: string[] | undefined;
  try {
    names = typeof stmt._getColumnNames === "function" ? stmt._getColumnNames() : undefined;
  } finally {
    stmt.finalize();
  }
  if (names === undefined) {
    throw new Error(
      "node-sqlite3-wasm 的列名 API 变了：降级档无法校验行序，拒绝执行（先看 driver/wasm.ts 文件头）",
    );
  }

  const keys = Object.keys(rows[0] as Record<string, unknown>);
  if (keys.length !== names.length || keys.some((key, index) => key !== names[index])) {
    throw new Error(
      `node-sqlite3-wasm 降级档遇到重名列或乱序行键（join 里的同名字段？），拒绝返回错数据：${sql}`,
    );
  }
}

/** 开降级档客户端（WAL 不开——理由见文件头；arrays 模式下按列序护栏把对象行摊平） */
export function openWasmClient(path: string): SqliteClient {
  const { Database } = getWasmModule();
  const db = new Database(path);

  // 探针：开库成功不代表能跑第一条语句。WAL 模式文件没有侧文件时，第一条语句即挂
  // （node-sqlite3-wasm 无法打开 WAL 模式的库），提前在这里抛，让开库层的恢复循环
  // 有机会重建库。
  db.run("SELECT 1");

  return {
    prepare(sql) {
      let arrays = false;

      const shape = (rows: unknown[]): unknown[] => {
        if (!arrays) return rows;
        assertColumnOrder(db, sql, rows);
        return rows.map((row) => Object.values(row as Record<string, unknown>));
      };

      return {
        setReturnArrays(flag) {
          arrays = flag;
        },
        all: (...params) => shape(db.all(sql, params)),
        get: (...params) => {
          const row = db.get(sql, params);
          if (row === null) return undefined;
          return shape([row])[0];
        },
        run: (...params) => db.run(sql, params),
      };
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}
