/**
 * 本机库的**驱动面**：惰性打开 / 单例与关闭 / pragma / schema 版本 / 权限，以及会话那三张表的落盘
 *
 * @description
 * ## 为什么这一档与 `tests/ledger.test.ts` 分开
 * @description
 * 那一档锁的是「**台账**这份数据的成败语义」（坏内容即拒、数据没被动过）；这一档锁的是「**那个库本身**
 * 的性质」—— 什么时候被打开、打开成什么模式、权限位、以及会话那三张表。故两档的判据不重叠。
 *
 * ## 「import 时不打开」怎么验的
 * @description
 * ⚠️ 不能靠「import 之后目录里没有文件」一句话：那份模块根本不知道 homedir，它要真开了库只会开在**真实的**
 * `~/.config/swain-proxy` 下。故这里验两件事：① 一份**新鲜**的模块注册表（`vi.resetModules()`）import 之后，
 * 真实位置与临时位置**都没有**多出任何东西；② 那份新鲜模块的 `closeLedgerDb()` 是**空操作**（它没有握着
 * 任何句柄）。⚠️ 「真实位置本来就有」的那种情形下第 ① 条只能证明「没被打开过」，故那条断言逐字写成
 * 「import 前后**存在性不变**」而不是「不存在」——后者在用户已经配过端点的机器上恒红。
 *
 * @module tests/sqlite
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LedgerError,
  closeLedgerDb,
  dbPath,
  readSessions,
  removeSession,
  renameSession,
  saveSession,
  writeLedger,
} from "@/services/config/index.js";

const created: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swain-tui-db-"));
  created.push(dir);
  return dir;
}

/** 临时目录里的库文件路径（父目录还不存在） */
function tempDb(): string {
  return path.join(tempDir(), "nested", "tui.db");
}

/** 一个**不认识本包**的原始句柄：验 pragma 与 schema 版本必须从外面量，用本包自己的接口就是自证 */
function rawHandle(file: string): RawDb {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (file: string) => RawDb;
  };
  return new DatabaseSync(file);
}

interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): { get(...params: unknown[]): unknown; all(): unknown[] };
  close(): void;
}

function withRaw<T>(file: string, work: (db: RawDb) => T): T {
  const db = rawHandle(file);
  try {
    return work(db);
  } finally {
    db.close();
  }
}

afterEach(() => {
  closeLedgerDb();
  vi.restoreAllMocks();
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
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

  it("schema 版本从 0 升到 1，而且**只有一处**存着它（`PRAGMA user_version`）", () => {
    const file = tempDb();
    // ⚠️ 先自己占位一个空库：SQLite 开一个还不存在的路径会**建**它，于是「0」那一头就无从量起
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "", "utf8");
    expect(withRaw(file, (db) => pick(db.prepare("PRAGMA user_version").get()))).toBe(0);

    writeLedger(file, { version: 1, selected: null, targets: [] });

    expect(withRaw(file, (db) => pick(db.prepare("PRAGMA user_version").get()))).toBe(1);
    withRaw(file, (db) => {
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      // ⚠️ 没有 `schema_version` 表：版本放在 `user_version` 上，而 `meta` 存的是台账状态（`selected`），
      // 两个都叫 "meta" 会造出第二份版本真相源
      expect(tables).toEqual(["meta", "sessions", "targets"]);
    });
  });

  // ⚠️ win32 上跳过：NTFS 的 ACL 不由 `chmod` 表达，Node 在 Windows 上只把 mode 映射到只读位
  it.skipIf(process.platform === "win32")("POSIX：库文件 0600、配置目录 0700", () => {
    const file = tempDb();
    writeLedger(file, { version: 1, selected: null, targets: [] });

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });
});

describe("会话落盘", () => {
  it("增 / 读：按建成顺序读回来，且**只有四个字段**（输出桶不入库）", () => {
    const file = tempDb();
    saveSession(file, {
      id: "s1",
      name: "会话 1",
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    });
    saveSession(file, {
      id: "s2",
      name: "会话 2",
      createdAt: 1700000000001,
      updatedAt: 1700000000001,
    });

    expect(readSessions(file)).toEqual([
      { id: "s1", name: "会话 1", createdAt: 1700000000000, updatedAt: 1700000000000 },
      { id: "s2", name: "会话 2", createdAt: 1700000000001, updatedAt: 1700000000001 },
    ]);
    withRaw(file, (db) => {
      const columns = (
        db.prepare("SELECT name FROM pragma_table_info('sessions')").all() as { name: string }[]
      ).map((row) => row.name);
      // ⚠️ 桶是内存里 `LOG_KEEP` 条的环形缓冲：它进库就等于把几千条渲染行存成审计日志
      expect(columns).toEqual(["id", "name", "created_at", "updated_at"]);
    });
  });

  it("改名：动 `updated_at`，**不动** `created_at`（后者是「这个会话有多老」的唯一定义）", () => {
    const file = tempDb();
    saveSession(file, { id: "s1", name: "会话 1", createdAt: 100, updatedAt: 100 });
    renameSession(file, "s1", "改名之后", 500);

    expect(readSessions(file)).toEqual([
      { id: "s1", name: "改名之后", createdAt: 100, updatedAt: 500 },
    ]);
  });

  it("删：删一个不存在的 `id` 与删一个存在的都是成功的 no-op / 生效", () => {
    const file = tempDb();
    saveSession(file, { id: "s1", name: "会话 1", createdAt: 100, updatedAt: 100 });

    removeSession(file, "查无此人");
    expect(readSessions(file)).toHaveLength(1);

    removeSession(file, "s1");
    expect(readSessions(file)).toEqual([]);
  });

  it("库不存在 ⇒ 空清单，且**不**因此创建那个库（与台账读面同一条纪律）", () => {
    const file = tempDb();
    expect(readSessions(file)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("同一个 `id` 记两遍 ⇒ 抛（一个会话被记两遍会让「切到会话 2」有两种答案）", () => {
    const file = tempDb();
    saveSession(file, { id: "s1", name: "会话 1", createdAt: 100, updatedAt: 100 });

    expect(() =>
      saveSession(file, { id: "s1", name: "又来一次", createdAt: 200, updatedAt: 200 }),
    ).toThrowError(LedgerError);
    expect(readSessions(file)[0]?.name).toBe("会话 1");
  });
});

/** `node:sqlite` 的行是 `[Object: null prototype]`，取键要走 `JSON.parse(JSON.stringify(...))` 那条路以外的方式 */
function pick(row: unknown): unknown {
  const record = row as Record<string, unknown> | undefined;
  if (record === undefined) return undefined;
  const keys = Object.keys(record);
  return keys.length === 1 ? record[keys[0]!] : record;
}