/**
 * 账号**数据源**：一个端口 + 多个实现器（内置 json / sqlite）的等价性、可切换性与可扩展性
 *
 * @description
 * 「抽象」本身不会被现有测试保护——`read.ts` 转过去之后，全部既有用例跑绿**并不能证明**
 * 「换个后端行为一样」。所以本文件专门锁五件事：
 *
 * 1. **等价性**（本档的核心价值）：同一批账号写进 json 档与 sqlite 档，**读出来逐字相同**。
 *    这条是抽象层存在的全部理由——若两个后端对「什么是合法账号」有分歧，抽象就是假的。
 *    判据锚在**具体字段**上（`quota.window` / `expiresAt` 归一 / `acl.target` 三个最易漂的），
 *    而不是「两个返回值 toEqual」——后者在两边都返回空数组时也成立（假绿）。
 * 2. **形状校验只有一份**：两个后端都把原始值交给 `validateAuthUsers`，所以任何「sqlite 档
 *    少判一条」的实现都会在这条上露出来（往库里塞一条 `window: "week"`，两个后端都必须
 *    判非法、且都保留上一份有效值）。
 * 3. **驱动热切换**：`AUTH_USERS_DRIVER` 是 runtime 相位，切一次后**下一个请求**就走新后端。
 *    牙齿是「切换后读出来的必须是新后端的数据」，而**不是**「切换后 kind 变了」——
 *    后者会被「记忆表按 driver 分别记」这条实现细节满足，哪怕切换根本没生效。
 * 4. **写族方法**：`put` / `delete` 在两个后端上语义一致（upsert；非法形状**抛错**而不是
 *    静默丢字段），且写进去的东西**读得回来**（往返）。
 * 5. **驱动是开放集合**（`registerAccountSource` 那一档）：自定义驱动名经
 *    `AUTH_USERS_DRIVER` 真的被装配使用，且**未注册驱动必须抛错并列出已注册项**。
 *    这条护的是「抽象真的可扩展」，而它最典型的腐坏形态是**静默回落**到内置档
 *    （`else → JsonAccountSource`）——那会让运维以为接上了数据库、实际读的是 `users.json`。
 *
 * ## 为什么「等价性」要写这么多字段而不是一句 `toEqual`
 *
 * `expect(jsonStore.list().value).toEqual(sqliteStore.list().value)` 在**两边都读到空表**时
 * 成立。而「sqlite 档的 SELECT 写错了列名」恰好就表现为空表——那正是最可能出的错。
 * 所以本文件**先 `put` 一批有代表性的账号，再逐字段断言读出来的东西**，让空表不可能通过。
 *
 * @example
 * const j = new JsonAccountSource(() => jsonFile);
 * const s = new SqliteAccountSource(() => dbFile);
 * j.put(ACCOUNTS[0]);
 * s.put(ACCOUNTS[0]);
 * expect(s.list({ force: true }).value[0]).toEqual(j.list({ force: true }).value[0]);
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountLocatorFor, ConfigStore } from "@/config/index.js";
import {
  ACCOUNTS_DB_NAME,
  JsonAccountSource,
  SqliteAccountSource,
  accountSourceFor,
  listAccountSourceDrivers,
  loadUserPolicy,
  loadUserQuota,
  readAuthUsers,
  readAuthUsersAsyncStartup,
  registerAccountSource,
  type AccountLocator,
  type AccountSource,
  type AuthAccount,
} from "@/datasource/users/index.js";
import { openSqliteDriver } from "@/utils/sqlite/index.js";
import { codeOf } from "../helpers/source-scan.js";

/**
 * 一批**刻意覆盖三个最易漂移处**的账号
 * @description
 * - `acl.target`：名单条目（两后端都要经过 `parseHostRule` 同一份实现）
 * - `quota.window`：闭集字面量（sqlite 档最容易「收下然后按 month 跑」的字段）
 * - `expiresAt`：**归一化产物是 epoch 毫秒，而磁盘形态必须带时区偏移的 ISO 8601**。
 *   这一对是抽象层最脆的地方——sqlite 档若直接把 epoch 写进 `doc`，读出来仍是同一个数字
 *   （看起来对），但**磁盘上那份数据换到 json 档就读不了**（`Date.parse(数字)` 会被
 *   `normalizeAccountExpiry` 的正则拒掉）。故往返测试要跨后端验。
 */
const ACCOUNTS: AuthAccount[] = [
  { username: "alice", password: "pw1" },
  { username: "bob", password: "pw2", quota: { bytes: 1024, window: "day" } },
  {
    username: "carol",
    password: "pw3",
    quota: { bytes: 2048 },
    acl: { target: { whitelist: ["example.com", "*.cdn.io"], blacklist: ["ads.io"] } },
    expiresAt: Date.parse("2026-12-31T23:59:59+08:00"),
  },
  // `window` 缺省的那一档：归一化产物**不写该键**（判据见 `UserQuota.window`）
  { username: "dave", password: "pw4", quota: { bytes: 0 } },
];

let dir = "";
let jsonFile = "";
let dbFile = "";

const json = (): AccountSource => new JsonAccountSource(() => jsonFile);
const sqlite = (): AccountSource => new SqliteAccountSource(() => dbFile);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "account-store-"));
  jsonFile = path.join(dir, "users.json");
  dbFile = path.join(dir, ACCOUNTS_DB_NAME);
});

afterEach(() => {
  // SQLite 有 `-wal` / `-shm` 旁挂文件，且 Windows 上未释放的句柄让 `rmSync` 报 EBUSY。
  // 重试若干次：清理失败不该把一条断言正确的用例判成失败，真占用会在耗尽后照常抛。
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      last = undefined;
      break;
    } catch (error) {
      last = error;
    }
  }
  if (last !== undefined) {
    throw last;
  }
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

describe("account-source：驱动切换（AUTH_USERS_DRIVER，runtime 相位）", () => {
  // 返回 **ConfigStore**（不是只读 accessor）：这两条用例的核心就是「**改配置**之后立刻生效」，
  // 而 `ConfigAccessor` 上没有 `set`。`ConfigStore` 本身满足 accessor 形状
  // （`configAccessorFromStore` 就是它的只读视图）。
  function storeWith(driver: "json" | "sqlite", jsonPath: string, dbPath: string): ConfigStore {
    const store = new ConfigStore();
    store.set("authUsersDriver", driver);
    store.set("authUsersFile", jsonPath);
    store.set("authUsersDb", dbPath);
    return store;
  }

  it("切驱动后下一个请求就走新后端（判据是**数据**，不是 kind）", () => {
    // 锚「读出来的数据换了一套」而不是「kind 变了」：后者会被「记忆表按 driver 分别记」
    // 这条实现细节满足，哪怕切换压根没生效 —— 那就是假绿。
    fs.writeFileSync(jsonFile, JSON.stringify([{ username: "from-json", password: "p" }]), "utf8");
    new SqliteAccountSource(() => dbFile).put({ username: "from-sqlite", password: "p" });

    const config = storeWith("json", jsonFile, dbFile);
    const accounts = accountLocatorFor(config);
    expect(accountSourceFor(accounts).list({ force: true }).value[0]?.username).toBe("from-json");
    expect(accountSourceFor(accounts).kind, "先确认 json 档").toBe("json");

    config.set("authUsersDriver", "sqlite");
    expect(
      accountSourceFor(accounts).list({ force: true }).value[0]?.username,
      "热改驱动后读到的必须是 sqlite 那份数据",
    ).toBe("from-sqlite");
    expect(accountSourceFor(accounts).kind, "再确认实现器也换了").toBe("sqlite");
  });

  it("热改 AUTH_USERS_FILE 指向另一个文件 → 下一个请求就读新文件（路径不被记忆）", () => {
    // ⚠️ 这条是本模块**曾经真的坏过**的形状：实现器若把路径烤在构造期、而 `accountSourceFor`
    // 又记忆了实现器实例，那么换文件永远不生效 —— 表现是「账号表读出来是空的」。
    // 判据锚在**两个不同文件的内容**上（不是「读到了非空」——那会漏掉「读到了旧文件」）。
    const other = path.join(dir, "users-2.json");
    fs.writeFileSync(jsonFile, JSON.stringify([{ username: "old", password: "p" }]), "utf8");
    fs.writeFileSync(other, JSON.stringify([{ username: "new", password: "p" }]), "utf8");
    const config = storeWith("json", jsonFile, dbFile);
    const accounts = accountLocatorFor(config);
    expect(accountSourceFor(accounts).list({ force: true }).value[0]?.username).toBe("old");
    config.set("authUsersFile", other);
    expect(
      accountSourceFor(accounts).list({ force: true }).value[0]?.username,
      "必须读到新文件",
    ).toBe("new");
  });
});

describe("account-source：源码级护栏", () => {
  it("每个后端各一个读取点，且 read.ts 零直接读取器", () => {
    // 「不新开读取器」是本层的第一纪律：第二份节流缓存一旦撞上同一个 `label + path` 键就会
    // 互相污染出无法解释的观察结果（而且「在读哪一份缓存」在调用方那里根本不可见）。
    // 锚的是**今天仍存在的文件与调用**（`readJsonCached(` / `readCachedSource<(`），
    // 不是某个已被删掉的模块名。
    const jsonSrc = codeOf("datasource", "users", "json-source.ts");
    expect((jsonSrc.match(/readJsonCached\(/g) ?? []).length, "json 档一处").toBe(1);
    expect((jsonSrc.match(/readCachedSource\s*[<(]/g) ?? []).length, "json 档不碰它").toBe(0);
    const sqliteSrc = codeOf("datasource", "users", "sqlite-source.ts");
    expect((sqliteSrc.match(/readJsonCached\(/g) ?? []).length, "sqlite 档不碰它").toBe(0);
    expect((sqliteSrc.match(/readCachedSource\s*[<(]/g) ?? []).length, "sqlite 档一处").toBe(1);
    const read = codeOf("datasource", "users", "read.ts");
    expect(read, "read.ts 零直接读取器").not.toMatch(/readJsonCached\(|readCachedSource\s*[<(]/);
  });

  it("形状校验只有一份：sqlite 档也走 validateAuthUsers（不许自己判字段）", () => {
    const sqliteSrc = codeOf("datasource", "users", "sqlite-source.ts");
    expect(sqliteSrc, "sqlite 档的 load 必须走 validateAuthUsers").toContain("validateAuthUsers(");
    // 点名几个「sqlite 档自己判就会漂移」的判据函数：它们只该在 validate.ts 里出现一次。
    // 锚是**今天仍存在的函数名**（`validate.ts` 里确实还定义着它们），所以这条会随它们
    // 被改名/删除而红，而不是恒真。
    const jsonSrc = codeOf("datasource", "users", "json-source.ts");
    for (const fn of ["normalizeAccountExpiry", "validateUserQuota", "validateUserPolicy"]) {
      const validate = codeOf("datasource", "users", "validate.ts");
      expect(validate, `${fn} 的定义仍在 validate.ts（锚点有效性自检）`).toContain(`function ${fn}(`);
      expect(sqliteSrc, `${fn} 不许在 sqlite 档复写`).not.toContain(`${fn}(`);
      expect(jsonSrc, `${fn} 不许在 json 档复写`).not.toContain(`${fn}(`);
    }
  });

  it("读面不认配置端口：datasource/users 零 @/config 依赖（数据源可脱离代理单用）", () => {
    // 「数据源独立于配置层」是这层存在的理由；一旦读面 import 了 `ConfigAccessor`，
    // 「不启动代理、单独用一个数据源」就在类型上不成立了。
    for (const file of ["index.ts", "types.ts", "validate.ts", "json-source.ts", "sqlite-source.ts", "read.ts", "registry.ts"]) {
      const code = codeOf("datasource", "users", file);
      expect(code, `${file} 不许 import @/config`).not.toContain('from "@/config/index.js"');
      expect(code, `${file} 不许认 ConfigAccessor`).not.toContain("ConfigAccessor");
    }
  });

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

describe("account-source：接线（readAuthUsers / loadUserPolicy / loadUserQuota 经驱动选后端）", () => {
  /**
   * 本组锁的是**接线**，不是存储类
   * @description
   * `tests/setup-env.ts` 把 `AUTH_USERS_DRIVER` 全局钉成 `json`（本仓绝大多数用例都围着 json 档写），
   * 于是**全仓没有任何一个测试**让 `authUsersDriver=sqlite` 走过 `readAuthUsers`。
   *
   * 那个缺口的后果不是「少测一个类」，而是：`readAuthUsers → accountSourceFor(locator) →
   * SqliteAccountSource` 这段接线若坏了，**全部集成测试照样全绿**（它们都走 json），
   * 而生产上 `AUTH_USERS_DRIVER=sqlite` 会静默读出空账号表 → 全员 407。
   * **一个只在特定配置下才发作的缺陷，被一份钉死默认值的测试环境完美地藏了起来。**
   *
   * 判据一律取**读取面上的真数据**（`readAuthUsers(...).value`），不是「实例类型」也不是
   * 「库文件存在」—— 后两者在「接线断了但库里数据完好」时也成立。
   */
  function sqliteConfig(): ConfigStore {
    const store = new ConfigStore();
    store.set("authUsersDriver", "sqlite");
    store.set("authUsersDb", dbFile);
    return store;
  }

  beforeEach(() => {
    // 种子走公开写入口（`put`），不手工塞 SQL —— 顺带证明「写进去的东西读得回来」
    const s = sqlite();
    for (const account of ACCOUNTS) {
      s.put(account);
    }
  });

  it("readAuthUsers：driver=sqlite 时读到的是**库里那份**（不是 authUsersFile 指向的 json）", () => {
    // 先在 json 档放一份**内容不同**的账号表：若接线误落到 json 档，下面的断言会立刻对不上
    fs.writeFileSync(
      jsonFile,
      JSON.stringify([{ username: "from-json", password: "p" }]),
      "utf8",
    );
    const read = readAuthUsers({
      locator: accountLocatorFor(sqliteConfig()),
      force: true,
    });
    expect(read.error, "sqlite 档无错误").toBeUndefined();
    expect(read.path, "读的是库路径，不是 authUsersFile").toBe(path.resolve(dbFile));
    expect(read.value.map((a) => a.username).sort(), "读到的是库里的 4 个账号").toEqual(
      ["alice", "bob", "carol", "dave"],
    );
  });

  it("loadUserPolicy / loadUserQuota 经同一条接线拿数据（acl 与 quota 都对）", () => {
    const accounts = accountLocatorFor(sqliteConfig());
    // `loadUserPolicy` 是**每请求**调用（core/access-control.ts 的个人层），它拿到的快照
    // 必须与整表读同源 —— 判据是内容，不是「函数返回了非 undefined」
    expect(loadUserPolicy("carol", accounts), "carol 的个人名单").toEqual({
      target: { whitelist: ["example.com", "*.cdn.io"], blacklist: ["ads.io"] },
    });
    expect(loadUserPolicy("alice", accounts), "没配 acl 的账号 = undefined（中性放行）").toBeUndefined();
    expect(loadUserQuota("bob", accounts), "bob 的配额").toEqual({ bytes: 1024, window: "day" });
    expect(loadUserQuota("alice", accounts), "没配 quota 的账号 = undefined").toBeUndefined();
  });

  it("启动期强校验：readAuthUsersAsyncStartup 按 driver 读（sqlite 档报的是库路径）", async () => {
    // 启动期那条是**另一个函数**（不经热加载缓存），接线错了一样只有生产会炸
    const pathFor = (driver: string): string => (driver === "sqlite" ? dbFile : jsonFile);
    const ok = await readAuthUsersAsyncStartup("sqlite", pathFor);
    expect(ok.error).toBeUndefined();
    expect(ok.value).toHaveLength(4);
    expect(ok.path).toBe(path.resolve(dbFile));
    // json 档那条不能被 sqlite 的接线带偏。**必须在这个用例里自己写那份 json** ——
    // 每个 it 都是全新的 mkdtemp 目录，指望上一个用例留下的文件是测试之间的隐式耦合
    // （而那种耦合恰好会在并发跑、或有人调整顺序时变成一个查不出来的偶发失败）。
    fs.writeFileSync(
      jsonFile,
      JSON.stringify([{ username: "from-json", password: "p" }]),
      "utf8",
    );
    const viaJson = await readAuthUsersAsyncStartup("json", pathFor);
    expect(viaJson.value.map((a) => a.username), "json 档仍读 json 文件").toEqual(["from-json"]);
  });

  it("库文件坏掉时 fail-closed：报 error 且沿用上一份有效值（与 json 档同形）", () => {
    const accounts = accountLocatorFor(sqliteConfig());
    expect(readAuthUsers({ locator: accounts, force: true }).value, "先建立一份有效值").toHaveLength(4);
    // 绕过 `put` 直接把一条**形状非法**的 doc 塞进库（真实来源：人手改过 / 从别的实现器迁来）
    const raw = openSqliteDriver()(dbFile);
    try {
      raw.run("INSERT INTO accounts (username, doc) VALUES (?, ?)", [
        "eve",
        JSON.stringify({ username: "eve", password: "p", quota: { bytes: 1, window: "week" } }),
      ]);
    } finally {
      raw.close();
    }
    const read = readAuthUsers({ locator: accounts, force: true });
    expect(read.error, "坏内容必须报 error（不静默接管）").toBeTruthy();
    expect(read.value, "沿用上一份有效值，而不是变成空表").toHaveLength(4);
  });
});

/**
 * 驱动是**开放集合**：`registerAccountSource` 插进去的名字必须真的被装配使用
 *
 * @description
 * 这组护的是「抽象真的可扩展」，而它最典型的腐坏形态是**静默回落**：装配点写成
 * `if (driver === "sqlite") … else → JsonAccountSource`，那么 `AUTH_USERS_DRIVER=mysql`
 * 会变成「静默按 json 跑」——运维以为接上了数据库，实际读的是 `users.json`，
 * 且**没有任何告警**。这种腐坏不会让任何既有用例变红（它们都走内置档），所以必须专门锁。
 *
 * ## 牙齿验证（拆掉接线会红，**已逐条实测**）
 *
 * 本组的三条断言逐条对着「接线真的被拆掉」这个变异做过变异测试，**全部会红**（实测记录）：
 * - 变异 A：把 `accountSourceFor` 里的 `resolveAccountSource(driver)` 换回硬编码
 *   `if (driver === "sqlite") … else → new JsonAccountSource(...)`，**① 与 ② 同时红**
 *   （① 读到的是 json 档那份、② 不抛错）。
 * - 变异 B：把 `registerAccountSource` 的写操作摘掉（退化成只读的内置表），
 *   **① 与 ③ 红**（① 注册的名字解析不到、③ 退订后 `list()` 仍含该项）。
 * - 另有一条跨层护栏同样实测过：给 `read.ts` 加一行
 *   `import type { ConfigAccessor } from "@/config/index.js"`，「读面不认配置端口」那条立刻红。
 *
 * 判据一律取**读出来的数据**或**抛出的错误文本**，不取「实例类型」——后者会被
 * 「按 driver 分别记忆」这类实现细节满足，哪怕装配压根没换过去。
 */
describe("account-source：驱动注册表（开放集合：自定义驱动必须真的被装配）", () => {
  const CUSTOM = "custom-mem";
  let off: (() => void) | undefined;
  let seenLocator: string | undefined;

  afterEach(() => {
    off?.();
    off = undefined;
    seenLocator = undefined;
  });

  /**
   * 一个内存账号源：数据不落盘，故「读到的是它」只可能是它真的被装配上了
   * @description `seenLocator` 在 **`list()` 时刻**取，而不是构造期——判据是「工厂拿到的是
   * 闭包、装配层每次现读」，不是「构造期烤死了什么」。构造期取一次只能证明「传进来过什么」，
   * 证明不了「路径可热改」。
   */
  class MemoryAccountSource implements AccountSource {
    public readonly kind = CUSTOM;
    public constructor(private readonly resolvePath: () => string) {}
    public list(): { value: AuthAccount[]; path: string; exists: boolean; error?: string } {
      seenLocator = this.resolvePath();
      return {
        value: [{ username: "from-custom", password: "p" }],
        path: this.resolvePath(),
        exists: true,
      };
    }
    public put(account: AuthAccount): AuthAccount {
      return account;
    }
    public delete(): void {
      /* 内存档无需实现写路径，本组只锁读 */
    }
  }

  it("① 自定义驱动经 AUTH_USERS_DRIVER 真的被装配（读到的是它的数据，不是内置档的）", () => {
    off = registerAccountSource(CUSTOM, (locator) => new MemoryAccountSource(locator));
    // 装配点拿到的那份**接线**：驱动名与路径都是闭包，装配层只负责「从 config 取值后传入」。
    const store = new ConfigStore();
    store.set("authUsersDriver", CUSTOM);
    store.set("authUsersFile", jsonFile);
    store.set("authUsersDb", dbFile);
    // 先在 json 档放一份**内容不同**的账号表：若接线误落到内置档，下面的断言会立刻对不上。
    fs.writeFileSync(jsonFile, JSON.stringify([{ username: "from-json", password: "p" }]), "utf8");

    const accounts: AccountLocator = accountLocatorFor(store);
    const read = readAuthUsers({ locator: accounts, force: true });
    expect(read.error, "自定义档无错误").toBeUndefined();
    // 判据是**内容**且与 json 档那份**不同**：若接线误落到内置档，这里会读到 `from-json`。
    // 「两边都读到空表」那种假绿被上面那句 json 文件的存在排除掉了。
    expect(read.value.map((a) => a.username), "读到的是自定义档的数据，不是 json 档那份").toEqual([
      "from-custom",
    ]);
    // 工厂收到的是**路径闭包**（数据源层零配置依赖的形状），且闭包现取：热改路径即时生效。
    expect(typeof seenLocator, "工厂收到的是路径闭包而不是烤死的字符串").toBe("string");
    store.set("authUsersFile", path.join(dir, "moved.json"));
    accountSourceFor(accounts).list();
    expect(seenLocator, "闭包现取：改 AUTH_USERS_FILE 后工厂看到的是新路径").toBe(
      path.resolve(path.join(dir, "moved.json")),
    );
  });

  it("② 未注册驱动必须抛错、点名驱动名并列出全部已注册项（绝不静默回落到 json 档）", () => {
    const accounts: AccountLocator = accountLocatorFor(
      Object.assign(new ConfigStore(), { get: (k: string) => (k === "authUsersDriver" ? "nope" : "") }) as never,
    );
    let thrown: Error | undefined;
    try {
      accountSourceFor(accounts).list();
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown, "未注册驱动必须抛错而不是静默按 json 跑").toBeDefined();
    expect(thrown?.message).toContain("nope");
    // 已注册项必须**全部**列出：拼错驱动名（`sqlit` ← `sqlite`）是最常见的部署错误，
    // 只说「未知驱动」而不说「有哪些」等于把「打开配置看一眼」变成「去翻源码」。
    for (const driver of listAccountSourceDrivers()) {
      expect(thrown?.message, `错误文本点名已注册驱动 ${driver}`).toContain(driver);
    }
    expect(listAccountSourceDrivers(), "内置两档始终在列").toEqual(
      expect.arrayContaining(["json", "sqlite"]),
    );
  });

  it("③ 退订是幂等的，且已被别人覆盖时退订不许删掉别人的项", () => {
    const before = listAccountSourceDrivers();
    const first = registerAccountSource("dup-driver", () => new MemoryAccountSource(() => ""));
    // 重名未给 override → 抛错（不静默替换）
    expect(() => registerAccountSource("dup-driver", () => new MemoryAccountSource(() => ""))).toThrow();
    first();
    first();
    expect(listAccountSourceDrivers(), "退订后回到原状（调两次不炸）").toEqual(before);
  });
});
