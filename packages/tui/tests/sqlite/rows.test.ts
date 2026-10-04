/**
 * 三张表里**落的是什么**：会话那五列的形状与增改删语义，provider 三样东西在 `meta` 里的键与打码
 *
 * @description
 * 与 `driver.test.ts` 的分界是「**表里那些行**」对「那个库本身」；与 ledger 那一档的分界是
 * 「**列与键的形状**」对「逐条目的成败语义」（坏内容即拒、拒写之后数据逐字未动在 ledger 那一档）。
 *
 * ⚠️ v1 → v2 的那一步只能**自己造一份 v1 形状的库**（`CREATE TABLE IF NOT EXISTS` 对已存在的表
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
  closeLedgerDb,
  readProvider,
  readSessions,
  redactProvider,
  removeSession,
  renameSession,
  saveSession,
  setSessionVisible,
  writeProvider,
} from "@/services/config/index.js";
import { openLedgerDb } from "@/services/config/db.js";
import { SCHEMA_VERSION, writeProviderField } from "@/services/config/tables.js";
import { pick, removeCreated, tempDir, tempDb, withRaw } from "./_shared.js";

afterEach(() => {
  closeLedgerDb();
  vi.restoreAllMocks();
  removeCreated();
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