/**
 * 账号表的**装配接线**：两个 runtime 相位（`AUTH_USERS_DRIVER` / `AUTH_USERS_FILE`）+
 * 四个公开入口 + 读取点唯一 / 校验唯一 / 零 `@/config` 依赖三条源码级牙齿。
 *
 * @description
 * ⚠️ `tests/setup-env.ts` 把 `AUTH_USERS_DRIVER` 全局钉成 `json`，于是全仓**没有任何一个测试**
 * 让 sqlite 档走过 `readAuthUsers` —— 接线若坏了集成测试照样全绿而生产上全员 407。故判据一律取
 * **读取面上的真数据**，不是「实例类型」。记忆边界与防假绿清单见同目录 `AGENTS.md`。
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountLocatorFor, ConfigStore } from "@/config/index.js";
import {
  accountSourceFor,
  loadUserPolicy,
  loadUserQuota,
  readAuthUsers,
  readAuthUsersAsyncStartup,
  SqliteAccountSource,
} from "@/datasource/users/index.js";
import { openSqliteDriver } from "@/utils/sqlite/index.js";
import { codeOf } from "../../../helpers/source-scan.js";
import {
  ACCOUNTS,
  dbFile,
  dir,
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

describe("account-source：接线（readAuthUsers / loadUserPolicy / loadUserQuota 经驱动选后端）", () => {
  /**
   * 本组锁的是**接线**，不是存储类
   * @description
   * 判据一律取**读取面上的真数据**（`readAuthUsers(...).value`），不是「实例类型」也不是
   * 「库文件存在」—— 后两者在「接线断了但库里数据完好」时也成立。`loadUserPolicy` 是
   * **每请求**调用（core/access-control.ts 的个人层），它拿到的快照必须与整表读同源 ——
   * 判据是内容，不是「函数返回了非 undefined」。
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
