/**
 * 账号表两个**内置后端**的等价性 + 写族方法 —— 抽象层存在的全部理由。
 *
 * @description
 * 判据锚在**具体字段**上（`acl.target` / `quota.window` / `expiresAt` 归一）而不是一句
 * `toEqual`：后者在两边都读到空表时也成立，而「sqlite 档 SELECT 写错列名」恰好就表现为空表。
 * 坏数据必须**绕过 `put` 直接塞底层**，「保留上一份有效值」的前提是**真的有过上一份**。
 * 跨后端往返为什么只有这样才测得出来见同目录 `AGENTS.md`。
 */

import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteAccountSource } from "@/datasource/users/index.js";
import { openSqliteDriver } from "@/utils/sqlite/index.js";
import {
  ACCOUNTS,
  dbFile,
  json,
  jsonFile,
  makeStoreDir,
  removeStoreDir,
  sqlite,
} from "./_account-store.js";

beforeEach(() => {
  makeStoreDir();
});

afterEach(() => {
  removeStoreDir();
});

describe("account-store：两个后端的等价性（抽象层存在的全部理由）", () => {
  it("同一批账号写进两个后端，逐字读回相同（含 acl / quota.window / expiresAt）", () => {
    for (const account of ACCOUNTS) {
      json().put(account);
      sqlite().put(account);
    }
    const fromJson = json().list({ force: true });
    const fromSqlite = sqlite().list({ force: true });
    expect(fromJson.error, "json 档无错误").toBeUndefined();
    expect(fromSqlite.error, "sqlite 档无错误").toBeUndefined();
    // ⚠️ **先断言非空**，否则下面那句 toEqual 在「两边都空」时也成立（假绿）
    expect(fromJson.value.length, "json 档读到 4 个账号").toBe(4);
    expect(fromSqlite.value.length, "sqlite 档读到 4 个账号").toBe(4);
    // 逐字段点名那三个最易漂移处，而不是只靠整对象 toEqual
    const j3 = fromJson.value.find((a) => a.username === "carol");
    const s3 = fromSqlite.value.find((a) => a.username === "carol");
    expect(s3?.acl, "acl.target 两后端逐字相同").toEqual(j3?.acl);
    expect(s3?.quota, "quota（含 window 缺省不写键）两后端相同").toEqual(j3?.quota);
    expect(s3?.expiresAt, "expiresAt（epoch 毫秒）两后端相同").toBe(j3?.expiresAt);
    expect(s3?.expiresAt).toBe(Date.parse("2026-12-31T23:59:59+08:00"));
    expect(fromSqlite.value.map((a) => a.username).sort(), "账号集合相同").toEqual(
      fromJson.value.map((a) => a.username).sort(),
    );
  });

  it("跨后端往返：sqlite 档写的 expiresAt 在 json 档也合法（磁盘形态是带偏移的 ISO）", () => {
    // 这条是抽象层**最脆**的一处，且只有跨后端才测得出来：sqlite 档若把 epoch 毫秒直接
    // 存进 `doc`，它在 sqlite 档内部读回来仍是同一个数字（看起来完全正确），
    // 而同一份数据**换到 json 档就读不了**（`normalizeAccountExpiry` 的正则要求带偏移）。
    sqlite().put(ACCOUNTS[2]!);
    // 把 sqlite 档的 doc 原样搬进 json 档（模拟「换后端 / 迁数据」）
    const rows = fs.existsSync(dbFile) ? readDocsFromDb(dbFile) : [];
    fs.writeFileSync(jsonFile, JSON.stringify(rows), "utf8");
    const read = json().list({ force: true });
    expect(read.error, "sqlite 写的 expiresAt 在 json 档同样合法").toBeUndefined();
    expect(read.value[0]?.expiresAt).toBe(ACCOUNTS[2]!.expiresAt);
  });

  it("形状非法时两个后端都判非法、且都保留上一份有效值（校验只有一份）", () => {
    json().put(ACCOUNTS[0]!);
    sqlite().put(ACCOUNTS[0]!);
    // ⚠️ **两个后端都要先读一次好数据**：「坏内容保留上一份有效值」的前提是**真的有过上一份**。
    // 少这一步，失败形态是「空表 + error」（fail-closed 的正确行为，不是 bug），断言就会写成
    // 「保留上一份」而实际验的是「没有上一份」——两种形状必须分别断言。
    for (const s of [json(), sqlite()]) {
      expect(s.list({ force: true }).value, "先读一次好数据建立缓存").toEqual([
        { username: "alice", password: "pw1" },
      ]);
    }
    // `window: "week"` 是闭集外的字面量 —— sqlite 档若「收下然后按 month 跑」就在这里露出来。
    // ⚠️ **坏数据必须绕过 `put` 直接塞进底层**：`put` 自己就校验它（这正是下一条断言的内容），
    // 所以「读侧会不会判非法」这件事只能靠绕过写侧来测 —— 真实的坏数据来源是人手改过的
    // 库文件、或从另一个实现器迁过来的数据。
    const bad = { username: "eve", password: "pw", quota: { bytes: 1, window: "week" } };
    fs.writeFileSync(jsonFile, JSON.stringify([{ username: "alice", password: "pw1" }, bad]), "utf8");
    const raw = openSqliteDriver()(dbFile);
    try {
      raw.run("INSERT INTO accounts (username, doc) VALUES (?, ?)", [
        "eve",
        JSON.stringify(bad),
      ]);
    } finally {
      raw.close();
    }

    // 写侧：非法形状必须**抛错**（不静默丢字段）
    expect(
      () =>
        new SqliteAccountSource(() => dbFile).put({
          username: "eve",
          password: "pw",
          quota: { bytes: 1, window: "week" as never },
        }),
      "sqlite 档的 put 必须对非法形状抛错，而不是静默丢字段",
    ).toThrow();
    expect(
      () =>
        json().put({ username: "eve", password: "pw", quota: { bytes: 1, window: "week" as never } }),
      "json 档的 put 同样抛错（两后端同一份判据）",
    ).toThrow();

    // 读侧：两个后端都判非法、且都保留上一份有效值
    const j = json().list({ force: true });
    const s = new SqliteAccountSource(() => dbFile).list({ force: true });
    expect(j.error, "json 档判非法").toBeTruthy();
    expect(s.error, "sqlite 档同样判非法（同一份 validateAuthUsers）").toBeTruthy();
    expect(s.value, "sqlite 档保留上一份有效值").toEqual([{ username: "alice", password: "pw1" }]);
    expect(j.value, "json 档保留上一份有效值").toEqual([{ username: "alice", password: "pw1" }]);
  });

  it("缺失 = 空表且不算错误（两个后端一致）", () => {
    expect(json().list({ force: true })).toMatchObject({ value: [], exists: false });
    const s = sqlite().list({ force: true });
    expect(s.value, "库文件不存在 = 空表").toEqual([]);
    expect(s.error, "库文件不存在不算错误").toBeUndefined();
  });
});

describe("account-store：写族方法（CRUD 的 D 与 U）", () => {
  for (const [name, store] of [
    ["json", json],
    ["sqlite", sqlite],
  ] as const) {
    it(`${name} 档：put 是 upsert（同名覆盖不重复）、delete 幂等、往返可读`, () => {
      const s = store();
      s.put(ACCOUNTS[0]!);
      s.put({ username: "alice", password: "new-pw" });
      s.put(ACCOUNTS[1]!);
      expect(s.list({ force: true }).value, "同名覆盖后仍是两个账号").toHaveLength(2);
      expect(
        s.list({ force: true }).value.find((a) => a.username === "alice")?.password,
        "覆盖生效",
      ).toBe("new-pw");

      s.delete("bob");
      expect(s.list({ force: true }).value.map((a) => a.username)).toEqual(["alice"]);
      s.delete("bob");
      expect(s.list({ force: true }).value.map((a) => a.username), "删不存在的账号静默成功").toEqual(
        ["alice"],
      );
    });
  }
});

/** 读 sqlite 档的 `doc` 列原文（模拟「把库里的数据搬到另一个后端」） */
function readDocsFromDb(file: string): unknown[] {
  return readRowsRaw(file).map((doc) => JSON.parse(doc) as unknown);
}

/** 经驱动读 `doc` 列（表结构只有 `sqlite-source.ts:CREATE_ACCOUNTS_TABLE` 一处） */
function readRowsRaw(file: string): string[] {
  const db = openSqliteDriver()(file);
  try {
    return db.all<{ doc: string }>("SELECT doc FROM accounts ORDER BY username").map((r) => r.doc);
  } finally {
    db.close();
  }
}
