/**
 * 侧边栏清单那张表：激活 / 摘下 / 读回，以及「清单不许指向一个不存在的会话」这条前置条件
 *
 * @description
 * 判据全部落在**那张表的行**上（从一个不认识本包的句柄倒表），因为「在不在侧边栏上」这件事
 * 只存在于 `sidebar_sessions` —— ⚠️ 会话自己**不带**那一位，于是问 `sessions` 什么也问不出来。
 *
 * 目录级不变量见 `AGENTS.md`；会话那几列与升级步在 `rows.test.ts`，对话在 `messages.test.ts`。
 *
 * @module tests/sqlite
 */

import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeLedgerDb,
  pinSession,
  readSidebar,
  removeSession,
  saveSession,
  unpinSession,
} from "@/services/config/index.js";
import { rawRows, removeCreated, tempDb, withRaw } from "./_shared.js";

afterEach(() => {
  closeLedgerDb();
  vi.restoreAllMocks();
  removeCreated();
});

function withSession(id: string, at = 100) {
  const file = tempDb();
  saveSession(file, { id, name: `会话 ${id.slice(1)}`, createdAt: at, updatedAt: at });
  return file;
}

describe("侧边栏清单（`sidebar_sessions` 就是清单本身）", () => {
  it("库不存在 ⇒ 空清单，且**不**因此创建那个库", () => {
    const file = tempDb();
    expect(readSidebar(file)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("⚠️ 激活写进去的就是**那一行**，而顺序恒等于激活顺序（⚠️ **不是**会话建成的顺序）", () => {
    const file = tempDb();
    saveSession(file, { id: "s1", name: "会话 1", createdAt: 1, updatedAt: 1 });
    saveSession(file, { id: "s2", name: "会话 2", createdAt: 2, updatedAt: 2 });
    saveSession(file, { id: "s3", name: "会话 3", createdAt: 3, updatedAt: 3 });

    pinSession(file, "s3", 300);
    pinSession(file, "s1", 100);
    pinSession(file, "s2", 200);

    // ⚠️ 判据要**分得开**「激活序」与「插入序」：先激活 `s3` 才分得开
    expect(readSidebar(file)).toEqual([
      { sessionId: "s3", at: 300 },
      { sessionId: "s1", at: 100 },
      { sessionId: "s2", at: 200 },
    ]);
    expect(readSidebar(file).map((one) => one.sessionId)).not.toEqual(["s1", "s2", "s3"]);
  });

  it("⚠️ **再 pin 一次同一个 id 是一次成功的 no-op**（`at` 不许被后来的那一记改掉）", () => {
    const file = withSession("s1");

    expect(() => pinSession(file, "s1", 100)).not.toThrow();
    expect(() => pinSession(file, "s1", 999)).not.toThrow();

    expect(readSidebar(file)).toEqual([{ sessionId: "s1", at: 100 }]);
    expect(rawRows(file, "sidebar_sessions")).toEqual([{ session_id: "s1", at: 100 }]);
  });

  it("⚠️ pin 一个**不存在的** `sessionId` 是一次成功的 no-op，**不是**报错（判据与「删一个不存在的 id」同族）", () => {
    const file = withSession("s1");

    expect(() => pinSession(file, "查无此人", 100)).not.toThrow();

    expect(readSidebar(file)).toEqual([]);
    expect(rawRows(file, "sidebar_sessions")).toEqual([]);
  });

  it("⚠️ **反向自检**：先造出一个孤儿行再 pin，孤儿**不会**被「补成合法的」—— 那个状态造出来过就是事故", () => {
    const file = withSession("s1");
    // ⚠️ 用**本包的接口**造不出孤儿（前置条件挡住了），所以从外面塞一行进去
    withRaw(file, (db) => db.prepare("INSERT INTO sidebar_sessions VALUES('ghost', 1)").run());

    pinSession(file, "s1", 100);

    // ⚠️ 判据是「它还在」而不是「清单干净了」：本层**没有**清理孤儿的那条路（它只写自己那一行）
    expect(rawRows(file, "sidebar_sessions")).toEqual([
      { session_id: "ghost", at: 1 },
      { session_id: "s1", at: 100 },
    ]);
  });

  it("⚠️ 激活**不动** `updated_at`，也**不**在 `sessions` 里新建一行（激活不是新建会话）", () => {
    const file = withSession("s1", 100);

    pinSession(file, "s1", 555);

    // ⚠️ 「出现在侧边栏上」不是「这个会话动了一次」—— `updated_at` 答的是新增或改名
    expect(readSidebar(file)).toEqual([{ sessionId: "s1", at: 555 }]);
    // ⚠️ 判据是**那几行逐字**（含模型那两列的缺省）：只数行的话「激活顺手改了模型选择」看不见
    expect(rawRows(file, "sessions")).toEqual([
      {
        id: "s1",
        name: "会话 1",
        created_at: 100,
        updated_at: 100,
        model_ref: null,
        reasoning: "medium",
      },
    ]);
  });

  it("摘下：清单少一行，而**对话与会话都留着**（摘下不是删掉）", () => {
    const file = withSession("s1");
    pinSession(file, "s1", 100);

    unpinSession(file, "s1");

    expect(readSidebar(file)).toEqual([]);
    expect(rawRows(file, "sessions")).toHaveLength(1);
  });

  it("摘一个不在清单上的 `id` 是一次成功的 no-op", () => {
    const file = withSession("s1");

    expect(() => unpinSession(file, "查无此人")).not.toThrow();
    expect(() => unpinSession(file, "s1")).not.toThrow();
  });

  it("⚠️ 会话被删掉之后那个 `id` **不能**再被激活回来（清单不许指向一个不存在的会话）", () => {
    const file = withSession("s1");
    pinSession(file, "s1", 100);

    // ⚠️ 级联删已经把清单里那一行带走了，于是「再激活一次」走的是「那个会话不存在」那一支
    removeSession(file, "s1");
    expect(rawRows(file, "sidebar_sessions")).toEqual([]);

    pinSession(file, "s1", 200);

    expect(readSidebar(file)).toEqual([]);
    expect(rawRows(file, "sidebar_sessions")).toEqual([]);
  });
});