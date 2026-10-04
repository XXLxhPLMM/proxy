/**
 * 本机库的**驱动面**：惰性打开 / 单例与关闭 / pragma / schema 版本 / 权限，以及会话那三张表的落盘
 *
 * @description
 * ## 为什么这一档与 `tests/ledger.test.ts` 分开
 * @description
 * 那一档锁的是「**台账**这份数据的成败语义」（坏内容即拒、数据没被动过）；这一档锁的是「**那个库本身**
 * 的性质」—— 什么时候被打开、打开成什么模式、权限位、以及会话那三张表。故两档的判据不重叠。
 *
 * ## 升级路径那一档是**自己造一份 v1 形状的库**
 * @description `sessions.visible` 是 v2 补上去的一列，而 `CREATE TABLE IF NOT EXISTS` 对已存在的表
 * 一个字节都不写 —— 故「v1 的库被 v2 的代码打开会发生什么」只能**造出来量**（本档最后一条），
 * 而「按代码读一遍觉得应该没问题」在迁移这件事上恰好是最容易错的推理。
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
  REDACTED_PROVIDER_KEY,
  REDACTED_TOKEN,
  closeLedgerDb,
  dbPath,
  readProvider,
  readSessions,
  redactProvider,
  removeSession,
  renameSession,
  saveSession,
  setSessionVisible,
  writeLedger,
  writeProvider,
} from "@/services/config/index.js";
import { openLedgerDb } from "@/services/config/db.js";
import { SCHEMA_VERSION, writeProviderField } from "@/services/config/tables.js";

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

  it("schema 版本从 0 升到 `SCHEMA_VERSION`，而且**只有一处**存着它（`PRAGMA user_version`）", () => {
    const file = tempDb();
    // ⚠️ 先自己占位一个空库：SQLite 开一个还不存在的路径会**建**它，于是「0」那一头就无从量起
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "", "utf8");
    expect(withRaw(file, (db) => pick(db.prepare("PRAGMA user_version").get()))).toBe(0);

    writeLedger(file, { version: 1, selected: null, targets: [] });

    // ⚠️ 判据读**实现里的那一个数**而不是写死 3：`SCHEMA_VERSION` 每次加表都要升，
    // 而这一条断言的作用是「版本真的落到位了」，不是「版本恰好是 3」
    expect(withRaw(file, (db) => pick(db.prepare("PRAGMA user_version").get()))).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(3);
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
  it("增 / 读：按建成顺序读回来，且**只有五个字段**（输出桶不入库）", () => {
    const file = tempDb();
    saveSession(file, {
      id: "s1",
      name: "会话 1",
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      visible: true,
    });
    saveSession(file, {
      id: "s2",
      name: "会话 2",
      createdAt: 1700000000001,
      updatedAt: 1700000000001,
      visible: false,
    });

    expect(readSessions(file)).toEqual([
      { id: "s1", name: "会话 1", createdAt: 1700000000000, updatedAt: 1700000000000, visible: true },
      { id: "s2", name: "会话 2", createdAt: 1700000000001, updatedAt: 1700000000001, visible: false },
    ]);
    withRaw(file, (db) => {
      const columns = (
        db.prepare("SELECT name FROM pragma_table_info('sessions')").all() as { name: string }[]
      ).map((row) => row.name);
      // ⚠️ 桶是内存里 `LOG_KEEP` 条的环形缓冲：它进库就等于把几千条渲染行存成审计日志
      expect(columns).toEqual(["id", "name", "created_at", "updated_at", "visible"]);
    });
  });

  it("改名：动 `updated_at`，**不动** `created_at` 与 `visible`（前者是「有多老」，后者是「显不显示」）", () => {
    const file = tempDb();
    saveSession(file, { id: "s1", name: "会话 1", createdAt: 100, updatedAt: 100, visible: true });
    renameSession(file, "s1", "改名之后", 500);

    expect(readSessions(file)).toEqual([
      { id: "s1", name: "改名之后", createdAt: 100, updatedAt: 500, visible: true },
    ]);
  });

  it("显隐：**不动** `updated_at`（「藏起来」不是「又动了一次」）", () => {
    const file = tempDb();
    saveSession(file, { id: "s1", name: "会话 1", createdAt: 100, updatedAt: 100, visible: true });
    setSessionVisible(file, "s1", false);

    expect(readSessions(file)).toEqual([
      { id: "s1", name: "会话 1", createdAt: 100, updatedAt: 100, visible: false },
    ]);
    setSessionVisible(file, "查无此人", false);
    expect(readSessions(file)[0]?.visible).toBe(false);
  });

  it("删：删一个不存在的 `id` 与删一个存在的都是成功的 no-op / 生效", () => {
    const file = tempDb();
    saveSession(file, { id: "s1", name: "会话 1", createdAt: 100, updatedAt: 100, visible: true });

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
    saveSession(file, { id: "s1", name: "会话 1", createdAt: 100, updatedAt: 100, visible: true });

    expect(() =>
      saveSession(file, { id: "s1", name: "又来一次", createdAt: 200, updatedAt: 200, visible: true }),
    ).toThrowError(LedgerError);
    expect(readSessions(file)[0]?.name).toBe("会话 1");
  });

  // ⚠️ 升级路径那一档：**自己**造一份 v1 形状的库（`sessions` 只有四列、`user_version = 1`），
  // 于是 v2 代码打开它会发生什么是被量出来的，而不是「按代码读一遍觉得应该没问题」。
  it("v1 库被 v2 代码打开 ⇒ 补上 `visible` 一列（**老会话一律显示**），而别的数据逐字未动", () => {
    const file = tempDb();
    // ⚠️ 父目录与那个空文件**自己**造：这一档要的是「一份已经存在的库」，而 `readSessions` 对不存在的
    // 路径刻意不建库（那是上面那一档在守的东西）
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "", "utf8");
    withRaw(file, (db) => {
      db.exec(`CREATE TABLE targets (
        id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
        token TEXT NOT NULL, timeout_ms INTEGER NOT NULL);
        CREATE TABLE meta (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE sessions (
          id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        INSERT INTO sessions VALUES('s1', '老会话', 100, 100);
        PRAGMA user_version = 1;`);
    });

    closeLedgerDb();
    // ⚠️ 打开动作就是一次读：库不存在 ⇒ 空清单，而它**不**创建那个库；这里要用真的读那一面
    expect(readSessions(file)).toEqual([
      { id: "s1", name: "老会话", createdAt: 100, updatedAt: 100, visible: true },
    ]);
    expect(withRaw(file, (db) => pick(db.prepare("PRAGMA user_version").get()))).toBe(SCHEMA_VERSION);
    withRaw(file, (db) => {
      const columns = (
        db.prepare("SELECT name FROM pragma_table_info('sessions')").all() as { name: string }[]
      ).map((row) => row.name);
      expect(columns).toEqual(["id", "name", "created_at", "updated_at", "visible"]);
    });
    // ⚠️ 而**存得进**新行（补列补的是形状，不是只让读那一面看着对）
    saveSession(file, { id: "s2", name: "新的", createdAt: 300, updatedAt: 300, visible: false });
    expect(readSessions(file)).toHaveLength(2);
    expect(readSessions(file)[1]?.visible).toBe(false);
  });
});

describe("provider 落盘（三样东西都在 `meta` 里，而 DDL 一个字节没改）", () => {
  it("写进去读得回来，三格逐字", () => {
    const file = tempDb();
    writeProvider(file, {
      baseUrl: "https://api.example.com/v1",
      model: "some-model",
      apiKey: "sk-secret-value",
    });
    expect(readProvider(file)).toEqual({
      baseUrl: "https://api.example.com/v1",
      model: "some-model",
      apiKey: "sk-secret-value",
    });
  });

  it("⚠️ **没有第四张表**（provider 落在早就存在的 `meta` 上 —— 新增能力不许长出新的表）", () => {
    const file = tempDb();
    writeProvider(file, { baseUrl: "https://x.example", model: "m", apiKey: "k" });
    withRaw(file, (db) => {
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      expect(tables).toEqual(["meta", "sessions", "targets"]);
    });
  });

  it("⚠️ **键带前缀**（`meta` 是全局键值表：不带前缀迟早与别的键撞，而撞了是静默读错）", () => {
    const file = tempDb();
    writeProvider(file, { baseUrl: "https://x.example", model: "m", apiKey: "k" });
    withRaw(file, (db) => {
      const keys = (db.prepare("SELECT key FROM meta ORDER BY key").all() as { key: string }[]).map(
        (row) => row.key,
      );
      expect(keys).toEqual(["provider.apiKey", "provider.baseUrl", "provider.model"]);
    });
  });

  it("三行**各自** UPSERT：改地址不清掉凭据（一次写里三格同生死，故这不是日常那一路）", () => {
    // ⚠️ 判据走**底层那个只写一格的函数**：`writeProvider` 刻意要求三格齐（配一半是错），
    // 而日常改一格的那条路由在 `AppState` 的 `provider-effect` 里，它走的就是这里
    const file = tempDb();
    writeProvider(file, { baseUrl: "https://a.example", model: "m", apiKey: "k1" });
    writeProviderField(openLedgerDb(file), "baseUrl", "https://b.example");
    expect(readProvider(file)).toEqual({
      baseUrl: "https://b.example",
      model: "m",
      apiKey: "k1",
    });
  });

  it("⚠️ 写 `null` = 删掉那一行，而**空串不是「没配」**（那是配了个什么都没有）", () => {
    const file = tempDb();
    writeProvider(file, { baseUrl: "https://x.example", model: "m", apiKey: "k" });
    expect(() => writeProvider(file, { baseUrl: "", model: "m", apiKey: "k" })).toThrow(LedgerError);
    writeProviderField(openLedgerDb(file), "baseUrl", null);
    expect(readProvider(file).baseUrl).toBe(null);
    expect(readProvider(file).model).toBe("m");
  });

  it("⚠️ **配一半即拒**（有地址没模型名 ⇒ 界面上与「没配」长得一样，而用户去查一个他改过的东西）", () => {
    const file = tempDb();
    expect(() => writeProvider(file, { baseUrl: "https://x.example", model: null, apiKey: "k" })).toThrow(
      LedgerError,
    );
    // ⚠️ **反向自检**：库里一个字节都没写进去（拒写必须是真的拒写）
    expect(readProvider(file)).toEqual({ baseUrl: null, model: null, apiKey: null });
  });

  it("⚠️ 库不存在 ⇒ 三格全 `null`，而**不**因此创建那个库", () => {
    const file = path.join(tempDir(), "nope", "tui.db");
    expect(readProvider(file)).toEqual({ baseUrl: null, model: null, apiKey: null });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("⚠️ **`meta` 的列不对 ⇒ 当场拒**（别人建的同名表会被 `IF NOT EXISTS` 当成自己的用）", () => {
    const file = tempDb();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "", "utf8");
    withRaw(file, (db) => {
      db.exec(`CREATE TABLE targets (
        id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
        token TEXT NOT NULL, timeout_ms INTEGER NOT NULL);
        CREATE TABLE meta (k TEXT NOT NULL PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE sessions (
          id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, visible INTEGER NOT NULL DEFAULT 1);`);
    });
    closeLedgerDb();
    // ⚠️ 判据是**读面**（第一次碰到那张表就拒），而不是「写进去才炸」——
    // 凭据落进一张列不对的表，读面还是能读出来的，而那就晚了
    expect(() => readProvider(file)).toThrow(LedgerError);
    expect(() => readSessions(file)).toThrow(LedgerError);
  });

  it("⚠️ 打码只有一份出口，且**空串保持空串**（与 `redactTarget` 同一条纪律）", () => {
    expect(redactProvider({ baseUrl: "u", model: "m", apiKey: "" }).apiKey).toBe("");
    const masked = redactProvider({ baseUrl: "u", model: "m", apiKey: "sk-a-very-long-secret" });
    expect(masked.apiKey).toBe(REDACTED_PROVIDER_KEY);
    // ⚠️ **反向自检**：与 `targets.token` 的掩码**同形**（两个不同的真凭据不许看起来一样长）
    expect(masked.apiKey).toBe(REDACTED_TOKEN);
  });
});

/** `node:sqlite` 的行是 `[Object: null prototype]`，取键要走 `JSON.parse(JSON.stringify(...))` 那条路以外的方式 */
function pick(row: unknown): unknown {
  const record = row as Record<string, unknown> | undefined;
  if (record === undefined) return undefined;
  const keys = Object.keys(record);
  return keys.length === 1 ? record[keys[0]!] : record;
}