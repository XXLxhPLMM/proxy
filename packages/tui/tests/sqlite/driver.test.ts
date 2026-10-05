/**
 * 那个**库**的性质：什么时候被打开、打开成什么模式（pragma / schema 版本 / 权限位）
 *
 * @description
 * 与 `rows.test.ts` 的分界是「库本身」对「**表里那些行**」；与 `tests/ledger/` 的分界是
 * 「那个库的性质」对「**台账数据**的成败语义」（坏内容即拒、拒写之后数据逐字未动，都在 ledger 那一档）。
 *
 * ⚠️ `closeLedgerDb` 刻意从**深层路径** `@/services/config/db.js` 引而不是走 barrel：下面那条
 * 「import 期不打开」靠的是「本档开头的静态 import 已经把那份模块求过值了」，而经 barrel 取它时
 * 那一层转发是间接的 —— 判据的前提要由 import 语句本身保证。
 *
 * 「import 期不打开」怎么验、v1 形状的库只能造出来量、以及单例的开关顺序见本目录 `AGENTS.md`。
 *
 * @module tests/sqlite
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dbPath, saveSession, writeLedger } from "@/services/config/index.js";
import { closeLedgerDb } from "@/services/config/db.js";
import { SCHEMA_VERSION } from "@/services/config/tables.js";
import { pick, rawTables, removeCreated, tempDb, withRaw } from "./_shared.js";

afterEach(() => {
  closeLedgerDb();
  vi.restoreAllMocks();
  removeCreated();
});

describe("打开时机", () => {
  it("import 这一层**不**打开库：import 前后真实位置的存在性一个字节都没变", async () => {
    const real = dbPath(os.homedir());
    const before = { file: fs.existsSync(real), dir: fs.existsSync(path.dirname(real)) };

    // ⚠️ `vi.resetModules()` 是这里的关键：不重置的话模块早就在本档开头的静态 import 里求过值了，
    // 而「import 期做了什么」这件事在已求过值的模块上**根本测不到**
    vi.resetModules();
    await import("@/services/config/db.js");

    expect(fs.existsSync(real)).toBe(before.file);
    expect(fs.existsSync(path.dirname(real))).toBe(before.dir);
  });

  it("一份还没被用过的模块：`closeLedgerDb()` 是空操作，且不留下任何东西", async () => {
    const file = tempDb();
    vi.resetModules();
    const fresh = await import("@/services/config/db.js");

    fresh.closeLedgerDb();
    fresh.closeLedgerDb();

    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.dirname(file))).toBe(false);
  });

  it("同一个路径只开一次，换路径先把旧的那个收掉（WAL 伴随文件随之消失 = 真的 close 了）", async () => {
    const first = tempDb();
    const second = tempDb();
    writeLedger(first, { version: 1, selected: null, targets: [] });
    expect(fs.readdirSync(path.dirname(first)).sort()).toEqual([
      "tui.db",
      "tui.db-shm",
      "tui.db-wal",
    ]);

    writeLedger(second, { version: 1, selected: null, targets: [] });

    expect(fs.readdirSync(path.dirname(first))).toEqual(["tui.db"]);
  });
});

describe("打开之后那个库长什么样", () => {
  it("journal_mode 是 WAL、foreign_keys 开着（两条 pragma 都真的落了地）", () => {
    const file = tempDb();
    writeLedger(file, { version: 1, selected: null, targets: [] });

    withRaw(file, (db) => {
      expect(pick(db.prepare("PRAGMA journal_mode").get())).toBe("wal");
      expect(pick(db.prepare("PRAGMA foreign_keys").get())).toBe(1);
    });
  });

  it("schema 版本从 0 升到 `SCHEMA_VERSION`，而且**只有一处**存着它（`PRAGMA user_version`）", () => {
    const file = tempDb();
    // ⚠️ 先自己占位一个空库：SQLite 开一个还不存在的路径会**建**它，于是「0」那一头就无从量起
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "", "utf8");
    expect(withRaw(file, (db) => pick(db.prepare("PRAGMA user_version").get()))).toBe(0);

    writeLedger(file, { version: 1, selected: null, targets: [] });

    // ⚠️ 判据读**实现里的那一个数**而不是写死一个值：`SCHEMA_VERSION` 每次加表都要升，
    // 而这一条断言的作用是「版本真的落到位了」，不是「版本恰好是几」
    expect(withRaw(file, (db) => pick(db.prepare("PRAGMA user_version").get()))).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(4);
    withRaw(file, (db) => {
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      // ⚠️ 没有 `schema_version` 表：版本放在 `user_version` 上，而 `meta` 存的是台账状态（`selected`），
      // 两个都叫 "meta" 会造出第二份版本真相源
      expect(tables).toEqual(["messages", "meta", "sessions", "sidebar_sessions", "targets"]);
    });
  });

  it("⚠️ **换一个路径就把这一个收掉**（而换出来的那个库长得一样：schema 是幂等的）", () => {
    // ⚠️ 反向自检：下面那组断言对「一张还没建过任何表的库」也成立，故先证明这一次真的写进去了东西
    const first = tempDb();
    saveSession(first, { id: "s1", name: "会话 1", createdAt: 1, updatedAt: 1 });
    expect(rawTables(first)).toContain("sidebar_sessions");

    const second = tempDb();
    writeLedger(second, { version: 1, selected: null, targets: [] });

    expect(rawTables(second)).toEqual(rawTables(first));
    expect(pick(withRaw(first, (db) => db.prepare("PRAGMA user_version").get()))).toBe(SCHEMA_VERSION);
  });

  // ⚠️ win32 上跳过：NTFS 的 ACL 不由 `chmod` 表达，Node 在 Windows 上只把 mode 映射到只读位
  it.skipIf(process.platform === "win32")("POSIX：库文件 0600、配置目录 0700", () => {
    const file = tempDb();
    writeLedger(file, { version: 1, selected: null, targets: [] });

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });
});