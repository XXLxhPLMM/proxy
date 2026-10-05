/**
 * 各档共用的台账工具面：临时目录的账、从外面看 / 改一份真库的句柄、以及 `src/services/config/` 的源码位置
 * @description
 * ⚠️ `created` 是**唯一一份**临时目录的账，而抽干它的那个 `afterEach` **归各档自己注册** ——
 * 模块没法把 hook 注册进 import 它的档；各档各建一份数组则会让一条档的清理忘掉另一条的目录。
 *
 * ⚠️ 门槛是「两个以上档真用到」：只被一档用到的东西留在那一档里（`LEDGER_DIR` 因此住在
 * `layer-boundary.test.ts` 自己身上）。唯一的例外是**它本身就是 ≥2 档用的那个工具的一部分** ——
 * `corrupt` 只有一档用，而它与 `rawHandle` / `dump` 同属「从本包之外动/看那份库」这一簇，
 * 把它单独搬出去等于把一簇工具劈成两半，而那一簇的 `closeLedgerDb()` 前置条件写在注释里。
 *
 * @module tests/ledger
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { DEFAULT_TIMEOUT_MS, closeLedgerDb } from "@/services/config/index.js";

/** 本目录建出来的临时目录（收尾在**各档**的 `afterEach` 里，见文件头） */
export const created: string[] = [];

/** 一个真临时目录（每次调用一个，各档的 `afterEach` 统一清） */
export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swain-tui-"));
  created.push(dir);
  return dir;
}

/** 临时目录里的库文件路径（父目录还不存在 —— 那正是首次启动的形态） */
export function tempDb(): string {
  return path.join(tempDir(), "nested", "tui.db");
}

/** 磁盘上一条合法端点的默认形态 */
export function firstTarget() {
  return {
    id: "prod",
    name: "生产",
    baseUrl: "http://127.0.0.1:3010",
    token: "s3cr3t-token",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

/** `node:sqlite` 里本目录要用的那几个方法（结构声明，不 import 那个模块） */
export interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown; all(): unknown[] };
  close(): void;
}

/**
 * 一个**不认识本包**的原始句柄
 * @description 注入坏形状必须从外面来：用本包自己的表去写断言，验的只是「我写的和我读的一致」。
 */
function rawHandle(file: string): RawDb {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (file: string) => RawDb;
  };
  return new DatabaseSync(file);
}

/** 收掉本包的句柄再改坏它：⚠️ 不这么做的话改的是本包**已经打开**的那一份，`ensureSchema` 不会再跑一遍 */
export function corrupt(file: string, sql: string): void {
  closeLedgerDb();
  const db = rawHandle(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/**
 * 把那份库里五张表的内容倒成一段文本
 * @description 比逐字节更硬：WAL 模式下数据可能整段还在 `-wal` 里，逐字节只看得到主文件，于是「没动过」会假绿。
 * ⚠️ 表清单**不写死**：漏掉一张就是「那个实现把那张表清空了而断言照样绿」。
 */
export function dump(file: string): string {
  const db = rawHandle(file);
  try {
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name);
    return JSON.stringify(names.map((table) => rowsOf(db, table)));
  } finally {
    db.close();
  }
}

function rowsOf(db: RawDb, table: string): unknown {
  try {
    return db.prepare(`SELECT * FROM ${table}`).all();
  } catch (err) {
    // 表本身就是被改坏的那一处时，倒不出来也是一份事实（比"抛了"信息更多）
    return String(err);
  }
}
