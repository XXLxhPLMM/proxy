/**
 * `sessions` 表里**落的是什么**：四列的形状与增改删语义，以及 v3 → v4 的那一步
 *
 * @description
 * 与 `driver.test.ts` 的分界是「**表里那些行**」对「那个库本身」；与 ledger 那一档的分界是
 * 「**列与键的形状**」对「逐条目的成败语义」（坏内容即拒、拒写之后数据逐字未动在 ledger 那一档）。
 * 侧边栏清单与对话各有自己的一档（`sidebar` / `messages`）—— 一个子主题一份档。
 *
 * ⚠️ v3 → v4 的那一步只能**自己造一份 v3 形状的库**（`CREATE TABLE IF NOT EXISTS` 对已存在的表
 * 一个字节都不写），理由、以及「pragma 与 schema 版本必须从外面量」的牙齿见本目录 `AGENTS.md`。
 *
 * @module tests/sqlite
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LedgerError,
  REDACTED_PROVIDER_KEY,
  REDACTED_TOKEN,
  appendMessages,
  closeLedgerDb,
  pinSession,
  readProvider,
  readSessions,
  redactProvider,
  removeSession,
  renameSession,
  saveSession,
  writeProvider,
} from "@/services/config/index.js";
import { openLedgerDb } from "@/services/config/db.js";
import { SCHEMA_VERSION, writeProviderField } from "@/services/config/tables.js";
import {
  pick,
  rawColumns,
  rawRows,
  rawTables,
  removeCreated,
  tempDir,
  tempDb,
  withRaw,
} from "./_shared.js";

afterEach(() => {
  closeLedgerDb();
  vi.restoreAllMocks();
  removeCreated();
});

function record(id: string, name: string, at = 100) {
  return { id, name, createdAt: at, updatedAt: at };
}

describe("会话落盘", () => {
  it("增 / 读：按建成顺序读回来，且**只有四个字段**（输出桶与侧边栏都不在会话自己身上）", () => {
    const file = tempDb();
    saveSession(file, record("s1", "会话 1", 1700000000000));
    saveSession(file, record("s2", "会话 2", 1700000000001));

    expect(readSessions(file)).toEqual([
      { id: "s1", name: "会话 1", createdAt: 1700000000000, updatedAt: 1700000000000 },
      { id: "s2", name: "会话 2", createdAt: 1700000000001, updatedAt: 1700000000001 },
    ]);
    // ⚠️ 桶是内存里 `LOG_KEEP` 条的环形缓冲，而「在不在侧边栏上」是 `sidebar_sessions` 那一问
    expect(rawColumns(file, "sessions")).toEqual(["id", "name", "created_at", "updated_at"]);
  });

  it("改名：动 `updated_at`，**不动** `created_at`", () => {
    const file = tempDb();
    saveSession(file, record("s1", "会话 1", 100));
    renameSession(file, "s1", "改名之后", 500);

    expect(readSessions(file)).toEqual([
      { id: "s1", name: "改名之后", createdAt: 100, updatedAt: 500 },
    ]);
  });

  it("删：删一个不存在的 `id` 与删一个存在的都是成功的 no-op / 生效", () => {
    const file = tempDb();
    saveSession(file, record("s1", "会话 1"));

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
    saveSession(file, record("s1", "会话 1", 100));

    expect(() => saveSession(file, record("s1", "又来一次", 200))).toThrowError(LedgerError);
    expect(readSessions(file)[0]?.name).toBe("会话 1");
  });
});

/** 造一份 v3 形状的库（⚠️ 父目录与那个空文件**自己**造：`readSessions` 对不存在的路径刻意不建库） */
function v3Library(userVersion = 3): string {
  const file = tempDb();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "", "utf8");
  withRaw(file, (db) => {
    db.exec(`CREATE TABLE targets (
      id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
      token TEXT NOT NULL, timeout_ms INTEGER NOT NULL);
      CREATE TABLE meta (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, visible INTEGER NOT NULL DEFAULT 1);
      INSERT INTO sessions VALUES('s1', '老会话', 100, 100, 0);
      INSERT INTO meta VALUES('provider.apiKey', 'sk-old-secret');
      PRAGMA user_version = ${String(userVersion)};`);
  });
  return file;
}

/** 一份库的全部可观察形状（⚠️ 五张表的列 + 数据 + 版本：判断「跑两遍结果一样」要能逐项比） */
function shapeOf(file: string): string {
  return JSON.stringify({
    version: pick(withRaw(file, (db) => db.prepare("PRAGMA user_version").get())),
    tables: rawTables(file),
    columns: Object.fromEntries(rawTables(file).map((t) => [t, rawColumns(file, t)])),
    rows: Object.fromEntries(rawTables(file).map((t) => [t, rawRows(file, t)])),
  });
}

describe("v3 → v4：去掉 `sessions.visible`，并把两张新表建出来", () => {
  it("⚠️ `visible` 真的没了，而别的数据逐字未动（真库 + 真 `ALTER`，不是「按代码读一遍觉得没问题」）", () => {
    const file = v3Library();
    // ⚠️ **先钉住那份库真的是 v3 形状**：`before` 里必须躺着 `visible` 且它的值是 0，
    // 否则下面「`visible` 没了」在「它从来就没有过」时也成立
    const before = rawRows(file, "sessions") as Record<string, unknown>[];
    expect(Object.keys(before[0]!).sort()).toEqual(["created_at", "id", "name", "updated_at", "visible"]);
    expect(before[0]!["visible"]).toBe(0);

    // ⚠️ 打开动作就是一次读：库不存在 ⇒ 空清单，而它**不**创建那个库
    expect(readSessions(file)).toEqual([{ id: "s1", name: "老会话", createdAt: 100, updatedAt: 100 }]);

    const after = rawRows(file, "sessions") as Record<string, unknown>[];
    // ⚠️ 判据是**那几行的键**，不只是列清单：列清单说「表上有没有这一列」，键说「这一行里还带不带它」
    expect(Object.keys(after[0]!).sort()).toEqual(["created_at", "id", "name", "updated_at"]);
    expect(rawColumns(file, "sessions")).toEqual(["id", "name", "created_at", "updated_at"]);
    // ⚠️ 别的数据逐字未动
    expect(after[0]).toEqual({ id: "s1", name: "老会话", created_at: 100, updated_at: 100 });
    expect(pick(withRaw(file, (db) => db.prepare("PRAGMA user_version").get()))).toBe(SCHEMA_VERSION);
  });

  it("两张新表建出来了，而 provider 的凭据**原样留在 `meta` 里**（升级步不许碰它）", () => {
    const file = v3Library();
    readSessions(file);

    expect(rawTables(file)).toEqual(["messages", "meta", "sessions", "sidebar_sessions", "targets"]);
    expect(rawColumns(file, "sidebar_sessions")).toEqual(["session_id", "at"]);
    expect(rawColumns(file, "messages")).toEqual(["session_id", "seq", "at", "turns"]);
    expect(readProvider(file).apiKey).toBe("sk-old-secret");
  });

  it("⚠️ **跑两遍结果一样**（判据落在**每张表的形状与内容**上，不只是「没抛」）", () => {
    const file = v3Library();
    readSessions(file);
    const once = shapeOf(file);

    // ⚠️ 第二次走的是**另一个 `ensureSchema`**：`closeLedgerDb()` 之后下一次打开会真的重跑一遍
    closeLedgerDb();
    readSessions(file);
    expect(shapeOf(file)).toBe(once);
  });

  it("⚠️ **版本说自己是 v4 而形状还是 v3 ⇒ 照样按形状收口**（判据不许依赖 `user_version` 的可信度）", () => {
    // ⚠️ 这一档是「不按版本号判」那条纪律**唯一的牙齿**：库被别的东西动过（版本被手工推上去、
    // 或者一次半途失败的升级）时，`user_version` 会说「我已经是这一版了」而形状还没跟上。
    // 一个加了 `version < 4` 门槛的实现在这一档下**恒绿** —— 故它必须自己造出这份自相矛盾的库。
    const file = v3Library(SCHEMA_VERSION);
    expect(pick(withRaw(file, (db) => db.prepare("PRAGMA user_version").get()))).toBe(SCHEMA_VERSION);
    expect(rawColumns(file, "sessions")).toContain("visible");

    readSessions(file);

    expect(rawColumns(file, "sessions")).toEqual(["id", "name", "created_at", "updated_at"]);
    expect(readSessions(file)).toEqual([{ id: "s1", name: "老会话", createdAt: 100, updatedAt: 100 }]);
  });

it("⚠️ 新鲜库连开两次也一样（第一次那句 `DROP COLUMN` 的判据不许每次都触发）", () => {
    const file = tempDb();
    saveSession(file, record("s1", "会话 1"));
    const once = shapeOf(file);

    closeLedgerDb();
    saveSession(file, record("s2", "会话 2"));
    const twice = shapeOf(file);
    // ⚠️ 反向自检：第二次**真的**多了一行（否则上面那条「跑两遍一样」只是一份空的库恰好一样）
    expect(twice).not.toBe(once);
    closeLedgerDb();
    readSessions(file);
    expect(shapeOf(file)).toBe(twice);
  });

  it("存得进新行，而新库**四列就够**（形状对了才谈得上写）", () => {
    const file = v3Library();
    readSessions(file);
    saveSession(file, record("s2", "新的", 300));
    expect(readSessions(file)).toHaveLength(2);
  });
});

describe("删一个会话：级联到侧边栏与对话（一次事务）", () => {
  it("⚠️ 三张表上**没有孤儿行**（从一个不认识本包的句柄倒表比，不用逐字节）", () => {
    const file = tempDb();
    saveSession(file, record("s1", "会话 1"));
    saveSession(file, record("s2", "会话 2"));
    pinSession(file, "s1", 10);
    pinSession(file, "s2", 20);
    appendMessages(file, "s1", [
      { id: 1, at: 100, turns: [{ kind: "notice", rows: [{ kind: "note", text: "一号" }] }] },
    ]);
    appendMessages(file, "s2", [
      { id: 1, at: 200, turns: [{ kind: "notice", rows: [{ kind: "note", text: "二号" }] }] },
    ]);

    removeSession(file, "s1");

    expect(rawRows(file, "sessions")).toEqual([{ id: "s2", name: "会话 2", created_at: 100, updated_at: 100 }]);
    expect(rawRows(file, "sidebar_sessions")).toEqual([{ session_id: "s2", at: 20 }]);
    expect(rawRows(file, "messages")).toEqual([
      { session_id: "s2", seq: 1, at: 200, turns: '[{"kind":"notice","rows":[{"kind":"note","text":"二号"}]}]' },
    ]);
  });

  it("⚠️ **不一致是真的**：只有 `messages` 没有 `sessions` 那一行时，级联删照样让它消失", () => {
    // ⚠️ 这一档造的是**写盘失败 / 库被人动过**之后的那种真状态，而那种库里孤儿消息是会攒出来的
    const file = tempDb();
    saveSession(file, record("s1", "会话 1"));
    appendMessages(file, "s1", [
      { id: 1, at: 100, turns: [{ kind: "notice", rows: [{ kind: "note", text: "孤儿" }] }] },
    ]);
    closeLedgerDb();
    withRaw(file, (db) => db.prepare("DELETE FROM sessions WHERE id = ?").run("s1"));
    expect(rawRows(file, "messages")).toHaveLength(1);

    removeSession(file, "s1");

    expect(rawRows(file, "messages")).toEqual([]);
  });

  it("删一个**从来没有**那几行的会话也是成功的 no-op（三张表一个都不许报错）", () => {
    const file = tempDb();
    saveSession(file, record("s1", "会话 1"));

    expect(() => removeSession(file, "s1")).not.toThrow();
    expect(() => removeSession(file, "s1")).not.toThrow();
    expect(rawRows(file, "sessions")).toEqual([]);
    expect(rawRows(file, "messages")).toEqual([]);
    expect(rawRows(file, "sidebar_sessions")).toEqual([]);
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

  it("⚠️ **provider 没有自己的表**（它落在早就存在的 `meta` 上 —— 新增能力不许长出 provider 那一张）", () => {
    const file = tempDb();
    writeProvider(file, { baseUrl: "https://x.example", model: "m", apiKey: "k" });
    // ⚠️ 判据**不写死表清单**：那是一份会随下一张新表一起腐烂的常量。它问的是「provider 有没有自己那张表」，
    // 而 provider 那一问的**形状**是「三样东西在 `meta` 的三个键上」，由下一条钉住
    expect(rawTables(file)).not.toContain("provider");
    expect(rawTables(file)).toContain("meta");
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
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE sidebar_sessions (session_id TEXT NOT NULL PRIMARY KEY, at INTEGER NOT NULL);
        CREATE TABLE messages (
          session_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, turns TEXT NOT NULL,
          PRIMARY KEY (session_id, seq));`);
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