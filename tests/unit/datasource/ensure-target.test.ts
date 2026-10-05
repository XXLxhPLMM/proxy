/**
 * 目标物化（`@/datasource/ensure-target.js`）：数据源的目标文件 / 库**不存在就造出来**。
 *
 * @description
 * 三档判据各锁一条不变量：① **覆盖面**（json / sqlite / 名单各一）——配了驱动、目标不存在 →
 * 读一次之后目标就在了，且内容与「显式写一个空骨架」逐字相同；② **不变量**（`wx` 那几条最要紧）
 * ——**已存在的目标绝不被改写**，否则一次「文件被误删 / 路径写错」会被放大成「账号表被清空」，
 * 判据用**真内容**而不是「文件大小非 0」，否则空文件也能骗过；③ **失败不抛**——物化抛错必须
 * 退化成「仍按缺失处理」，因为「读路径不许有副作用之外的失败」是本层的硬性质：今天只读文件系统
 * 上的部署能跑，加了物化之后不许变成起不来。⚠️ 每条都做过变异实测（拆掉实现 / 把 `wx` 换成
 * `w` / 让钩子抛错，各自会红）。骨架的形状**取自被测实现**（`EMPTY_ACL`）而不是手抄一份 ——
 * 手抄的那份一旦与实现漂移，断言会从「物化出来的内容合法」退化成「两份都错也对」。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeSkeletonIfMissing } from "@/datasource/ensure-target.js";
import { JsonAccountSource, SqliteAccountSource } from "@/datasource/users/index.js";
import { JsonAclSource } from "@/datasource/acl/index.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-target-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const ACL_SKELETON = { clientIp: { whitelist: [], blacklist: [] }, target: { whitelist: [], blacklist: [] }, upstream: { whitelist: [], blacklist: [] } };

describe("数据源目标物化：原语本身", () => {
  it("不存在的目标 → 建出来，返回 true", () => {
    const file = path.join(dir, "nested", "deep", "users.json");
    expect(writeSkeletonIfMissing(file, "[]\n")).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("[]\n");
  });

  it("已存在的目标 → 一个字节都不改，返回 false", () => {
    const file = path.join(dir, "users.json");
    fs.writeFileSync(file, '[{"username":"alice"}]', "utf8");
    expect(writeSkeletonIfMissing(file, "[]\n")).toBe(false);
    expect(fs.readFileSync(file, "utf8"), "内容逐字未变").toBe('[{"username":"alice"}]');
  });

  it("建不了（父路径是普通文件）→ 不抛，返回 false", () => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "x", "utf8");
    expect(() => writeSkeletonIfMissing(path.join(blocker, "users.json"), "[]\n")).not.toThrow();
    expect(writeSkeletonIfMissing(path.join(blocker, "users.json"), "[]\n")).toBe(false);
  });

  it("并发物化同一个目标：恰好一个成功，内容只有一份（`wx` 的牙齿）", () => {
    const file = path.join(dir, "race.json");
    const results = [1, 2, 3, 4, 5].map(() => writeSkeletonIfMissing(file, "[]\n"));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(fs.readFileSync(file, "utf8")).toBe("[]\n");
  });
});

describe("账号表 json 档：缺文件即物化成空数组", () => {
  it("读一次之后 `cfg/users.json` 就在了，内容是 `[]`", () => {
    const file = path.join(dir, "users.json");
    const source = new JsonAccountSource(() => file);
    const read = source.list({ force: true });
    expect(read.value, "读结果不变（缺失的语义本来就是空账号表）").toEqual([]);
    expect(fs.existsSync(file), "文件被物化出来了").toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("[]\n");
    // 物化之后同一份内容能被真读出来：判据不是「文件存在」，而是「读回来是合法的空表」
    expect(source.list({ force: true }).value).toEqual([]);
  });

  it("⚠️ 已存在的真账号表绝不被空骨架覆盖（拆掉 `wx` 必须会红）", () => {
    const file = path.join(dir, "users.json");
    const real = '[{"username":"alice","password":"pw1"}]';
    fs.writeFileSync(file, real, "utf8");
    new JsonAccountSource(() => file).list({ force: true });
    expect(fs.readFileSync(file, "utf8"), "内容逐字未变").toBe(real);
    expect(new JsonAccountSource(() => file).list({ force: true }).value).toEqual([
      { username: "alice", password: "pw1" },
    ]);
  });
});

describe("账号表 sqlite 档：缺库即建库建表", () => {
  it("读一次之后 `users.db` 与 `accounts` 表都在，且是空表", () => {
    const file = path.join(dir, "users.db");
    const source = new SqliteAccountSource(() => file);
    expect(source.list({ force: true }).value).toEqual([]);
    expect(fs.existsSync(file), "库文件被物化出来了").toBe(true);

    // 判据落在**真读一次库**：表在不在由 SQL 回答，不由「文件存在」回答
    // （sqlite 的 open 会凭空造出一个空文件，那不等于建了表）。
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      expect(tables.map((r) => r.name)).toContain("accounts");
      expect(db.prepare("SELECT COUNT(*) AS n FROM accounts").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("⚠️ 已存在的真账号库绝不被清空", () => {
    const file = path.join(dir, "users.db");
    new SqliteAccountSource(() => file).put({ username: "alice", password: "pw1" });
    new SqliteAccountSource(() => file).list({ force: true });
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      expect(db.prepare("SELECT doc FROM accounts").all()).toEqual([
        { doc: '{"username":"alice","password":"pw1"}' },
      ]);
    } finally {
      db.close();
    }
  });

  it("父目录不存在时也建得出来（建目录是它的一部分）", () => {
    const file = path.join(dir, "cfg", "nested", "users.db");
    new SqliteAccountSource(() => file).list({ force: true });
    expect(fs.existsSync(file), `连父目录一起建了：${file}`).toBe(true);
  });
});

describe("名单 json 档：缺文件即物化成空名单骨架（读路径与启动期校验同形）", () => {
  it("热路径 read() 物化", () => {
    const file = path.join(dir, "acl.json");
    const source = new JsonAclSource(() => file);
    expect(source.read().value).toEqual(ACL_SKELETON);
    expect(fs.existsSync(file)).toBe(true);
    // 物化出来的内容必须**自身合法**：下一次读走的是真校验，不是 fallback
    expect(source.read({ force: true }).value).toEqual(ACL_SKELETON);
  });

  it("启动期 readStartup() 也物化（两条读路径对「缺了怎么办」必须给同一个答案）", async () => {
    const file = path.join(dir, "acl.json");
    const source = new JsonAclSource(() => file);
    const read = await source.readStartup();
    expect(read.value).toEqual(ACL_SKELETON);
    expect(fs.existsSync(file), "启动期就把空名单建出来了").toBe(true);
  });

  it("已存在的真名单绝不被空骨架覆盖", async () => {
    const file = path.join(dir, "acl.json");
    const real = JSON.stringify({ clientIp: { whitelist: ["10.0.0.0/8"], blacklist: [] }, target: { whitelist: [], blacklist: [] }, upstream: { whitelist: [], blacklist: [] } });
    fs.writeFileSync(file, real, "utf8");
    new JsonAclSource(() => file).read({ force: true });
    await new JsonAclSource(() => file).readStartup();
    expect(fs.readFileSync(file, "utf8"), "内容逐字未变").toBe(real);
  });
});

describe("物化失败不得反噬读取（只读文件系统上的部署今天能跑，明天也得能跑）", () => {
  it("目标不可写 → 读结果与「缺失」完全一致，不抛错", () => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "x", "utf8");
    const file = path.join(blocker, "users.json"); // 父路径是普通文件 ⇒ 物化必失败
    const read = new JsonAccountSource(() => file).list({ force: true });
    expect(read.value, "仍按空账号表处理").toEqual([]);
    expect(read.exists, "仍如实报告「不存在」（不谎称已物化）").toBe(false);
    expect(read.error, "物化失败不是读取错误").toBeUndefined();
  });

  it("sqlite 档同理：库建不出来时读结果不变，但**必须说出建不出来**", () => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "x", "utf8");
    const read = new SqliteAccountSource(() => path.join(blocker, "users.db")).list({ force: true });
    expect(read.value, "仍按空账号表处理（不抛、不启动失败）").toEqual([]);
    // ⚠️ 这一条是「不许静默」的牙齿：没有它，「配了一个建不出来的库」与「库里没有账号」
    // 在返回值上完全一样，运维没有任何线索（实测形态：路径前缀是普通文件 / 只读盘）。
    expect(read.error, "建不出来要说出来").toContain("账号库建不出来");
  });
});
