/**
 * `users.json` 的账号级 `acl`（数据层：形状校验 + 条目语法的唯一判据）
 *
 * @description
 * ## ① 账号级 `acl` **只允许 `target` 一个组**；`clientIp` / `upstream` / 任何未知键一律整组非法（fail-closed）
 * — 否掉「把全局三组都搬到账号级」— 判定顺序是 **clientIp → auth → target ACL → 路由**，
 * 客户端名单判定发生在**鉴权之前**，那时还不知道用户是谁，「按用户限制来源 IP」在当前顺序下
 * **不可实现**；收下一个永不生效的字段等于给假的安全感，不如启动期报错。`upstream` 是 client
 * 模式的路由名单，与「你是谁」正交。
 * 牙齿（本档「非法组名：clientIp / upstream / 任意未知键 → 整组非法（fail-closed）」那条）：
 * `expect(validateAuthUsers([{ username: "a", password: "x", acl: { clientIp: {} } }])).toBeUndefined()` /
 * `clientIp: { blacklist: ["1.2.3.4"] }` / `upstream: {}` / `acl: { quota: 10 }`（未知键）四格。
 * ⚠️ 「整组非法」的严重程度由本档「非法 acl 让整份文件作废（同表里其它合法账号也救不回来）」那条
 * 与 `tests/unit/user-quota.test.ts` 的「quota 与 acl 各自独立决定整份文件是否作废」共同锁住。
 *
 * ## ② 账号级 `acl` 的条目语法与全局 `acl.json` 的 `target` 组**完全同形**，合法性**只经**
 * `rules/host.ts:parseHostRule` 判定 — 否掉「在 `users.ts` 里另写一份解析」—
 * `[{username,password}]` 形状的账号文件必须逐字合法，所以这个可选字段不能引入任何新的失败面。
 * 牙齿**两面**：
 * - 行为面（本档「条目的合法性判据就是 rules 层的 parseHostRule（两文件对同一批条目结论必须一致）」那条）：
 *   一批样本（`example.com` / `*.a.com` / `10.0.0.0/8` / `::1` / `[::1]:443` / `example.com:8080` /
 *   `192.168.*.*` / `exämple.com` / `a_b.com` / `10.0.0.0/33`）逐条断言
 *   `expect(viaUsers === undefined).toBe(parseHostRule(entry) === undefined)` ——两个判据一旦分家就红。
 * - 源码面（本档「数据层的条目合法性必须经 rules 层」那条）：
 *   `expect(code).toContain('from "./rules/index.js"')`、
 *   `expect((code.match(/parseHostRule\(/g) ?? []).length).toBe(1)`、
 *   `expect(code).not.toContain("parseIpRule")`（引了就等于开第二套解析）、
 *   `expect(code).not.toContain("normalizeHost(")` / `normalizeIp(` / `not.toMatch(/const\s+RE_/)`
 *   （不许自己拿归一函数或正则去判条目合法性）。
 * 配套：「一次内容变更只报一次 `reloaded`」与「`loadUserPolicy` 复用 `readAuthUsers`」证明数据层
 * **不新开读取器**（`users.ts` 全文 `readJsonCached(` 恰好一处）——那与条目语法是**两条独立**的纪律。
 *
 * ## ③ `acl` 对凭证索引**不可见** — `core/helpers/credentials.ts` 消费的是 core 那份两字段
 * `AuthAccount`（`core/types/proxy.ts`）；加进索引会让「同一个用户名+密码在不同文件里表现不同」。
 * 牙齿（本档「凭证索引不受 acl 影响」那条）：
 * `expect([...b.basic.entries()].sort()).toEqual([...a.basic.entries()].sort())` 与
 * `expect(b.basic.size).toBe(4)`（带 acl 与不带 acl 的**账号集合必须相同**），
 * 外加 `expect([...b.basic.keys()]).not.toContain("*.corp.com")`。
 * 配额的另一半在 `tests/unit/user-quota.test.ts`（`quota` / `window` 那一侧），两档合起来才是这句话的全部含义。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadAuthUsers,
  loadUserPolicy,
  readAuthUsers,
  readAuthUsersAsync,
  validateAuthUsers,
} from "@/config/files/users.js";
import { parseHostRule } from "@/config/files/rules/index.js";
import {
  credentialIndexesFor,
  encodeBasicCredentials,
  matchBasicCredential,
  matchUidCredential,
} from "@/core/helpers/index.js";
import { set, testConfig } from "../helpers/config.js";
import { restoreConfig, snapshotConfig } from "../helpers/config.js";
import { codeOf } from "../helpers/source-scan.js";

describe("config/auth-users validateAuthUsers", () => {
  it("合法账号表：保留顺序，密码允许空串（uid 模式只用用户名）", () => {
    const accounts = [
      { username: "alice", password: "pw1" },
      { username: "bob", password: "" },
    ];
    expect(validateAuthUsers(accounts)).toEqual(accounts);
  });

  it("空数组合法", () => {
    expect(validateAuthUsers([])).toEqual([]);
  });

  it("非数组 / 元素非对象 非法", () => {
    expect(validateAuthUsers({})).toBeUndefined();
    expect(validateAuthUsers(null)).toBeUndefined();
    expect(validateAuthUsers("x")).toBeUndefined();
    expect(validateAuthUsers(["x"])).toBeUndefined();
    expect(validateAuthUsers([[]])).toBeUndefined();
    expect(validateAuthUsers([null])).toBeUndefined();
  });

  it("缺 password / password 非 string 非法", () => {
    expect(validateAuthUsers([{ username: "a" }])).toBeUndefined();
    expect(validateAuthUsers([{ username: "a", password: 123 }])).toBeUndefined();
  });

  it("username 空串或含 ':' 非法", () => {
    expect(validateAuthUsers([{ username: "", password: "x" }])).toBeUndefined();
    expect(validateAuthUsers([{ username: "a:b", password: "x" }])).toBeUndefined();
  });

  it("重复用户名非法", () => {
    expect(
      validateAuthUsers([
        { username: "a", password: "x" },
        { username: "a", password: "y" },
      ]),
    ).toBeUndefined();
  });

  it("未知键非法", () => {
    expect(validateAuthUsers([{ username: "a", password: "x", role: "admin" }])).toBeUndefined();
  });
});

describe("config/auth-users readAuthUsers", () => {
  let dir: string;
  let snap: Record<string, unknown>;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-users-test-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // 保存并静音日志，避免非法文件用例把 warn 写进项目 log 目录
    snap = snapshotConfig(["authUsersFile", "logLevel", "logFile"]);
    set("logLevel", "silent");
    set("logFile", "");
  });

  afterEach(() => {
    restoreConfig(snap);
  });

  it("文件缺失 → 空数组且无 error", () => {
    const r = readAuthUsers({
      config: testConfig,
      force: true,
      path: path.join(dir, "missing.json"),
    });
    expect(r.exists).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual([]);
  });

  it("合法文件 → 账号顺序原样保留", () => {
    const p = path.join(dir, "ok.json");
    const accounts = [
      { username: "bob", password: "b" },
      { username: "alice", password: "" },
    ];
    fs.writeFileSync(p, JSON.stringify(accounts));
    const r = readAuthUsers({ config: testConfig, force: true, path: p });
    expect(r.exists).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual(accounts);
    expect(r.value.map((a) => a.username)).toEqual(["bob", "alice"]);
  });

  it("非法结构（缺 password）→ 记 error 并保留上一份有效值", () => {
    const p = path.join(dir, "retain.json");
    fs.writeFileSync(p, JSON.stringify([{ username: "alice", password: "pw" }]));
    const first = readAuthUsers({ config: testConfig, force: true, path: p });
    expect(first.error).toBeUndefined();
    expect(first.value).toEqual([{ username: "alice", password: "pw" }]);

    fs.writeFileSync(p, JSON.stringify([{ username: "alice" }]));
    const second = readAuthUsers({ config: testConfig, force: true, path: p });
    expect(second.error).toBeTruthy();
    expect(second.value).toEqual([{ username: "alice", password: "pw" }]);
  });

  it("非法 JSON → 同样保留上一份有效值", () => {
    const p = path.join(dir, "bad-json.json");
    fs.writeFileSync(p, JSON.stringify([{ username: "carol", password: "c" }]));
    expect(readAuthUsers({ config: testConfig, force: true, path: p }).value).toEqual([
      { username: "carol", password: "c" },
    ]);

    fs.writeFileSync(p, "{ 坏 JSON");
    const r = readAuthUsers({ config: testConfig, force: true, path: p });
    expect(r.error).toBeTruthy();
    expect(r.value).toEqual([{ username: "carol", password: "c" }]);
  });

  it("loadAuthUsers：经 store 的 authUsersFile 读取", () => {
    const p = path.join(dir, "store.json");
    fs.writeFileSync(p, JSON.stringify([{ username: "dave", password: "d" }]));
    set("authUsersFile", p);
    expect(loadAuthUsers(testConfig)).toEqual([{ username: "dave", password: "d" }]);
  });
});

/* ---------------------------------------------------------------------------
 * 账号级可选名单 `acl`（本档锁数据层：形状校验 + 热加载 + 零分配）
 * ------------------------------------------------------------------------- */

/** 一个带 acl 的账号表，形状见任务书：旧的 `{username,password}` 与新的混排也合法 */
const MIXED_ACCOUNTS = [
  { username: "alice", password: "pw1" },
  {
    username: "bob",
    password: "pw2",
    acl: { target: { whitelist: ["*.corp.com"], blacklist: ["ads.io"] } },
  },
];

describe("config/auth-users validateAuthUsers 账号级 acl", () => {
  it("ACCOUNT_KEYS 联动：带 acl 的文件校验通过（新增字段漏进白名单会让整份文件判非法）", () => {
    expect(validateAuthUsers(MIXED_ACCOUNTS)).toEqual(MIXED_ACCOUNTS);
  });

  it("旧格式逐字不变：产物不含 acl 键，未配置个人名单的账号不受影响", () => {
    expect(validateAuthUsers([{ username: "alice", password: "pw1" }])).toEqual([
      { username: "alice", password: "pw1" },
    ]);
    expect(Object.keys(validateAuthUsers([{ username: "alice", password: "pw1" }])![0]!)).toEqual([
      "username",
      "password",
    ]);
  });

  it("acl 可选：空对象 / 缺 target 组 / 缺名单键都补空（= 无个人限制）", () => {
    expect(validateAuthUsers([{ username: "a", password: "x", acl: {} }])).toEqual([
      { username: "a", password: "x", acl: { target: { whitelist: [], blacklist: [] } } },
    ]);
    expect(validateAuthUsers([{ username: "a", password: "x", acl: { target: {} } }])).toEqual([
      { username: "a", password: "x", acl: { target: { whitelist: [], blacklist: [] } } },
    ]);
    expect(
      validateAuthUsers([{ username: "a", password: "x", acl: { target: { blacklist: ["1.2.3.4"] } } }]),
    ).toEqual([
      {
        username: "a",
        password: "x",
        acl: { target: { whitelist: [], blacklist: ["1.2.3.4"] } },
      },
    ]);
  });

  it("target 条目与全局 acl.json 同形：IP / CIDR / 域名 / *.域名 都合法", () => {
    const acl = validateAuthUsers([
      {
        username: "a",
        password: "x",
        acl: { target: { whitelist: ["example.com", "*.a.com", "10.0.0.0/8", "::1"] } },
      },
    ]);
    expect(acl?.[0]?.acl?.target.whitelist).toEqual([
      "example.com",
      "*.a.com",
      "10.0.0.0/8",
      "::1",
    ]);
  });

  it("非法组名：clientIp / upstream / 任意未知键 → 整组非法（fail-closed）", () => {
    // clientIp 判定发生在鉴权之前（handleForward 顺序 clientIp → auth → target），
    // 那时还不知道用户是谁，按用户限制来源 IP 在当前判定顺序下不可实现 → 收下即假安全感
    expect(validateAuthUsers([{ username: "a", password: "x", acl: { clientIp: {} } }])).toBeUndefined();
    expect(
      validateAuthUsers([{ username: "a", password: "x", acl: { clientIp: { blacklist: ["1.2.3.4"] } } }]),
    ).toBeUndefined();
    // upstream 是 client 模式路由名单，与用户正交
    expect(validateAuthUsers([{ username: "a", password: "x", acl: { upstream: {} } }])).toBeUndefined();
    // 未知键
    expect(validateAuthUsers([{ username: "a", password: "x", acl: { quota: 10 } }])).toBeUndefined();
  });

  it("非法 acl 值：非对象 / 数组 / null / 组非对象 / 组内未知键 / 名单非数组", () => {
    expect(validateAuthUsers([{ username: "a", password: "x", acl: "x" }])).toBeUndefined();
    expect(validateAuthUsers([{ username: "a", password: "x", acl: null }])).toBeUndefined();
    expect(validateAuthUsers([{ username: "a", password: "x", acl: [] }])).toBeUndefined();
    expect(validateAuthUsers([{ username: "a", password: "x", acl: { target: "x" } }])).toBeUndefined();
    expect(
      validateAuthUsers([{ username: "a", password: "x", acl: { target: { deny: ["a.com"] } } }]),
    ).toBeUndefined();
    expect(
      validateAuthUsers([{ username: "a", password: "x", acl: { target: { whitelist: "a.com" } } }]),
    ).toBeUndefined();
  });

  it("非法条目：任一条非法即整组非法（与全局 ACL 同语义，绝不静默丢弃）", () => {
    const bad = (list: string[]): unknown =>
      validateAuthUsers([{ username: "a", password: "x", acl: { target: { whitelist: list } } }]);
    // 条目不支持端口（与全局 target 组一致）
    expect(bad(["example.com:8080"])).toBeUndefined();
    // 非法通配写法
    expect(bad(["192.168.*.*"])).toBeUndefined();
    // IDN / 下划线域名被规则层拒绝
    expect(bad(["exämple.com"])).toBeUndefined();
    expect(bad(["a_b.com"])).toBeUndefined();
    // CIDR 前缀越界 / 空串 / 非字符串
    expect(bad(["10.0.0.0/33"])).toBeUndefined();
    expect(bad(["   "])).toBeUndefined();
    expect(bad([123 as unknown as string])).toBeUndefined();
    // blacklist 侧同样 fail-closed
    expect(
      validateAuthUsers([
        { username: "a", password: "x", acl: { target: { whitelist: ["a.com"], blacklist: ["a.com:1"] } } },
      ]),
    ).toBeUndefined();
  });

  it("条目的合法性判据就是 rules 层的 parseHostRule（两文件对同一批条目结论必须一致）", () => {
    const entries = [
      "example.com",
      "*.a.com",
      "10.0.0.0/8",
      "::1",
      "[::1]:443",
      "example.com:8080",
      "192.168.*.*",
      "exämple.com",
      "a_b.com",
      "10.0.0.0/33",
    ];
    for (const entry of entries) {
      const viaUsers = validateAuthUsers([
        { username: "a", password: "x", acl: { target: { blacklist: [entry] } } },
      ]);
      // 唯一的合法性判据：rules 层说非法，users.json 就必须判非法
      expect(viaUsers === undefined, `parseHostRule(${entry}) 与 validateAuthUsers 结论不一致`).toBe(
        parseHostRule(entry) === undefined,
      );
    }
  });

  it("放松规则的回归防护：acl 不得让原有账号规则退让（重复用户名 / 含 ':' / 未知顶层键）", () => {
    // 重复用户名（一个带 acl 一个不带，仍然重复）
    expect(
      validateAuthUsers([
        { username: "a", password: "x" },
        { username: "a", password: "y", acl: { target: { blacklist: ["ads.io"] } } },
      ]),
    ).toBeUndefined();
    // 用户名含 ':'
    expect(
      validateAuthUsers([{ username: "a:b", password: "x", acl: { target: {} } }]),
    ).toBeUndefined();
    // 用户名为空
    expect(validateAuthUsers([{ username: "", password: "x", acl: { target: {} } }])).toBeUndefined();
    // 未知顶层键
    expect(
      validateAuthUsers([{ username: "a", password: "x", acl: { target: {} }, role: "admin" }]),
    ).toBeUndefined();
    // 密码类型 / 缺失
    expect(validateAuthUsers([{ username: "a", acl: { target: {} } }])).toBeUndefined();
    expect(
      validateAuthUsers([{ username: "a", password: 1, acl: { target: {} } }]),
    ).toBeUndefined();
    // 元素非对象
    expect(validateAuthUsers([[{ username: "a", password: "x" }]])).toBeUndefined();
  });

  it("非法 acl 让整份文件作废（同表里其它合法账号也救不回来）", () => {
    expect(
      validateAuthUsers([
        { username: "alice", password: "pw1" },
        { username: "bob", password: "pw2", acl: { target: { blacklist: ["ads.io:80"] } } },
      ]),
    ).toBeUndefined();
  });
});

describe("config/auth-users loadUserPolicy", () => {
  let dir: string;
  let snap: Record<string, unknown>;
  /** 单调递增的 mtime 写入：绕开文件系统时间戳粒度，让「内容已变」这件事是确定的 */
  let clock = 0;
  let file: string;

  const write = (data: unknown): void => {
    clock += 1000;
    fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
    fs.utimesSync(file, clock / 1000, clock / 1000);
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-policy-test-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // 保存并静音日志，避免非法文件用例把 warn 写进项目 log 目录
    snap = snapshotConfig(["authUsersFile", "logLevel", "logFile"]);
    set("logLevel", "silent");
    set("logFile", "");
    file = path.join(dir, `users-${Math.random().toString(36).slice(2)}.json`);
    set("authUsersFile", file);
  });

  afterEach(() => {
    restoreConfig(snap);
  });

  it("用户存在且配了 acl → 返回该用户的策略；未配 acl 的账号返回 undefined", () => {
    write(MIXED_ACCOUNTS);
    expect(loadUserPolicy("bob", testConfig)).toEqual({
      target: { whitelist: ["*.corp.com"], blacklist: ["ads.io"] },
    });
    expect(loadUserPolicy("alice", testConfig)).toBeUndefined();
  });

  it("用户不存在 → undefined（不是抛错，也不是空策略）", () => {
    write(MIXED_ACCOUNTS);
    expect(loadUserPolicy("nobody", testConfig)).toBeUndefined();
    expect(loadUserPolicy("", testConfig)).toBeUndefined();
  });

  it("文件缺失 → undefined 且不算错误", () => {
    const r = readAuthUsers({ config: testConfig, force: true });
    expect(r.exists).toBe(false);
    expect(r.error).toBeUndefined();
    expect(loadUserPolicy("bob", testConfig)).toBeUndefined();
  });

  it("坏文件保留上一份有效值：改坏后策略仍是旧的那份（经账号表同一缓存条目）", () => {
    write(MIXED_ACCOUNTS);
    expect(loadUserPolicy("bob", testConfig)).toEqual({
      target: { whitelist: ["*.corp.com"], blacklist: ["ads.io"] },
    });

    // 改坏：acl 出现未知组（fail-closed 形态）
    write([{ username: "bob", password: "pw2", acl: { clientIp: { blacklist: ["1.2.3.4"] } } }]);
    // 强制重读一次，让「这份内容非法」这件事真正落到缓存条目上
    const forced = readAuthUsers({ config: testConfig, force: true });
    expect(forced.error).toBeTruthy();
    // 同一缓存条目：非强制的账号表读也能看到那个 error（独立读取器做不到这点）
    expect(readAuthUsers({ config: testConfig }).error).toBeTruthy();
    // 策略仍是上一份有效值，没有被清成「无限制」
    expect(loadUserPolicy("bob", testConfig)).toEqual({
      target: { whitelist: ["*.corp.com"], blacklist: ["ads.io"] },
    });
  });

  it("非法 JSON 同样保留上一份有效值", () => {
    write(MIXED_ACCOUNTS);
    expect(loadUserPolicy("bob", testConfig)?.target.blacklist).toEqual(["ads.io"]);
    write("{ 坏 JSON");
    expect(readAuthUsers({ config: testConfig, force: true }).error).toBeTruthy();
    expect(loadUserPolicy("bob", testConfig)?.target.blacklist).toEqual(["ads.io"]);
  });

  it("热加载完整循环：改好 → 越过 1s 节流后新策略生效", () => {
    vi.useFakeTimers();
    try {
      write([{ username: "bob", password: "pw2", acl: { target: { blacklist: ["ads.io"] } } }]);
      expect(loadUserPolicy("bob", testConfig)).toEqual({
        target: { whitelist: [], blacklist: ["ads.io"] },
      });

      // 改坏：未越过节流，读到的仍是上一份有效值
      write([{ username: "bob", password: "pw2", acl: { target: { blacklist: ["ads.io:80"] } } }]);
      expect(loadUserPolicy("bob", testConfig)?.target.blacklist).toEqual(["ads.io"]);

      // 越过节流：坏内容不接管
      vi.advanceTimersByTime(1500);
      expect(loadUserPolicy("bob", testConfig)?.target.blacklist).toEqual(["ads.io"]);

      // 修好并越过节流：新策略生效
      write([{ username: "bob", password: "pw2", acl: { target: { whitelist: ["*.corp.com"] } } }]);
      vi.advanceTimersByTime(1500);
      expect(loadUserPolicy("bob", testConfig)).toEqual({
        target: { whitelist: ["*.corp.com"], blacklist: [] },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("返回值只读：深度冻结，且改动拿到的对象不污染缓存", () => {
    write(MIXED_ACCOUNTS);
    const policy = loadUserPolicy("bob", testConfig)!;
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.target)).toBe(true);
    expect(Object.isFrozen(policy.target.whitelist)).toBe(true);
    expect(Object.isFrozen(policy.target.blacklist)).toBe(true);
    expect(() => (policy.target.whitelist as string[]).push("evil.com")).toThrow(TypeError);
    expect(loadUserPolicy("bob", testConfig)?.target.whitelist).toEqual(["*.corp.com"]);
    // 账号表里那份也仍是原值（缓存没被调用方改坏）
    expect(loadAuthUsers(testConfig)[1]?.acl?.target.whitelist).toEqual(["*.corp.com"]);
  });

  it("热路径零分配：同一用户连续两次查询返回同一对象身份", () => {
    // 保护：`loadUserPolicy` 是**每请求**调用（core/access-control.ts:checkTargetHost 的个人层），
    // 「每次调用深冻结一份新对象」在热路径上是纯浪费。判据用 toBe（同身份）而不是 toEqual：
    // 后者对「重新冻结了一份内容相同的新对象」照样通过，锁不住分配。
    write(MIXED_ACCOUNTS);
    const first = loadUserPolicy("bob", testConfig);
    const second = loadUserPolicy("bob", testConfig);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    // 复用不放宽只读：那份对象仍是深度冻结的，且与缓存里的内部数组无关
    expect(Object.isFrozen(first!.target.whitelist)).toBe(true);
    // 按用户名分槽，不串号
    expect(loadUserPolicy("alice", testConfig)).not.toBe(first);
  });

  it("事件回调经账号表同一条观察面抛出（与 loadAuthUsers 同一份 label/path 契约）", () => {
    write(MIXED_ACCOUNTS);
    const events: string[] = [];
    const onEvent = (e: { type: string; label: string }): void => {
      events.push(`${e.label}:${e.type}`);
    };
    loadUserPolicy("bob", testConfig, onEvent);
    write([{ username: "bob", password: "pw2" }]);
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(1500);
      // 一次内容变更只报一次（两个读取器共用同一缓存条目与去重状态）
      expect(loadUserPolicy("bob", testConfig, onEvent)).toBeUndefined();
      expect(events).toEqual(["用户账号文件:reloaded"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("config/auth-users 跨层一致性护栏", () => {
  it("数据层的条目合法性必须经 rules 层：users.ts 全文只有一处 parseHostRule、零 IP/正则解析", () => {
    const code = codeOf("config", "files", "users.ts");
    expect(code).toContain('from "./rules/index.js"');
    expect((code.match(/parseHostRule\(/g) ?? []).length).toBe(1);
    // 账号级名单只服务 target 组，零 IP 规则层入口（引了就等于开第二套解析）
    expect(code).not.toContain("parseIpRule");
    // 也不许自己拿 normalizeHost/normalizeIp/正则去判条目合法性
    expect(code).not.toContain("normalizeHost(");
    expect(code).not.toContain("normalizeIp(");
    // 正则只许出现在**账号有效期**那一处（`RE_ACCOUNT_EXPIRY`，判的是 ISO 时刻形态，
    // 与名单条目语法正交）。锚是**具体符号名**而不是泛化的 `const RE_` —— 后者会把任何新增的
    // 正则都算成违规，于是下一个来的人只能把有效期判据改写成字符串切片来绕过它。
    // 名单条目一侧的「零正则」由上面那三条 + 本档的行为面（parseHostRule 与 users 结论一致）锁住。
    const regexConsts = [...code.matchAll(/const\s+(RE_[A-Z_]+)\s*=/g)].map((m) => m[1]);
    expect(regexConsts).toEqual(["RE_ACCOUNT_EXPIRY"]);
  });

  it("users.ts 只有一处 readJsonCached，且 loadUserPolicy 复用 readAuthUsers（不新开读取器）", () => {
    const code = codeOf("config", "files", "users.ts");
    expect((code.match(/readJsonCached\(/g) ?? []).length).toBe(1);

    const body = code.slice(code.indexOf("export function loadUserPolicy("));
    expect(body).toContain("readAuthUsers(");
    expect(body).not.toContain("readJsonCached(");
    expect(body).not.toContain("readFileSync(");
    expect(body).not.toContain("promises");
  });

  it("启动期强校验：readAuthUsersAsync 对带 acl 的文件同样 fail-closed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-policy-async-"));
    try {
      const ok = path.join(dir, "ok.json");
      fs.writeFileSync(ok, JSON.stringify(MIXED_ACCOUNTS));
      const good = await readAuthUsersAsync(ok);
      expect(good.error).toBeUndefined();
      expect(good.value).toEqual(MIXED_ACCOUNTS);

      // 未知组 → 启动期 abort（exists=true + error，绝不静默当没配）
      const bad = path.join(dir, "bad.json");
      fs.writeFileSync(bad, JSON.stringify([{ username: "b", password: "p", acl: { foo: {} } }]));
      const r = await readAuthUsersAsync(bad);
      expect(r.error).toBeTruthy();
      expect(r.exists).toBe(true);
      expect(r.value).toEqual([]);

      // 非法条目同样 fail-closed
      const badEntry = path.join(dir, "bad-entry.json");
      fs.writeFileSync(
        badEntry,
        JSON.stringify([{ username: "b", password: "p", acl: { target: { blacklist: ["a.com:80"] } } }]),
      );
      expect((await readAuthUsersAsync(badEntry)).error).toBeTruthy();

      // 缺失文件仍只算缺失
      const missing = await readAuthUsersAsync(path.join(dir, "absent.json"));
      expect(missing.exists).toBe(false);
      expect(missing.error).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("凭证索引不受 acl 影响：带 acl 的账号表与不带 acl 的产出逐项相同", () => {
    const plain = validateAuthUsers([
      { username: "alice", password: "pw1" },
      { username: "bob", password: "pw2" },
    ])!;
    const withAcl = validateAuthUsers(MIXED_ACCOUNTS)!;

    const a = credentialIndexesFor(plain);
    const b = credentialIndexesFor(withAcl);
    expect([...b.basic.entries()].sort()).toEqual([...a.basic.entries()].sort());
    expect([...b.uidUsers].sort()).toEqual([...a.uidUsers].sort());

    // acl 文本绝不进索引（basic 键只有 b64(user:pass) 与 user:pass 两种形态）
    expect(b.basic.size).toBe(4);
    expect([...b.basic.keys()]).not.toContain("*.corp.com");
    expect(matchBasicCredential(encodeBasicCredentials("bob", "pw2"), b)).toBe("bob");
    expect(matchBasicCredential(encodeBasicCredentials("bob", "wrong"), b)).toBeUndefined();
    expect(matchUidCredential("bob", b)).toBe("bob");
    expect(matchUidCredential("nobody", b)).toBeUndefined();
  });
});


/**
 * `users.json` 的账号 `expiresAt`（数据层：ISO 形态的 fail-closed 归一）
 *
 * @description
 * 判定在 `tests/unit/identity.test.ts` 的「账号有效期 expiresAt」那一档（认证点）；本档只答
 * 「磁盘上这个字符串能不能被读成一个时刻」，锁四件事：
 *
 * 1. **形态必须带时区偏移**：`Date.parse` 会把 `"2026-10-01"` 读成 **UTC 午夜**、把
 *    `"2026-10-01 00:00"` 读成**本地午夜**——同一份配置在 UTC 机器与 `+08:00` 机器上差 8 小时，
 *    而运维写它时心里想的是本地零点。收下它等于把「这台机器的时区」变成隐藏真相。
 * 2. **日历上不存在的日必须拒**：`Date.parse("2026-02-30T00:00:00Z")` 实测返回**有限值**
 *    （静默滚成 3 月 2 日），故按「该月天数」显式再判一次。
 * 3. **已过期是合法值**（那就是这个字段要表达的状态），只有**形态**非法才让整份文件作废。
 * 4. **`ACCOUNT_KEYS` 联动**：带 `expiresAt` 的文件必须校验通过（漏加白名单会让**所有**带
 *    有效期的账号文件被判非法 → 启动期 abort）。
 */
describe("config/auth-users 账号 expiresAt", () => {
  /** 判据：归一后是 epoch 毫秒 */
  const at = (iso: unknown): unknown =>
    (validateAuthUsers([{ username: "a", password: "x", expiresAt: iso }]) ?? [])[0];

  it("白名单联动：带 expiresAt 的文件校验通过并归一成 epoch 毫秒", () => {
    expect(validateAuthUsers([{ username: "a", password: "x", expiresAt: "2026-10-01T00:00:00Z" }])).toEqual([
      { username: "a", password: "x", expiresAt: Date.parse("2026-10-01T00:00:00Z") },
    ]);
    // 偏移被如实尊重：同一时刻的两种写法归一到同一个毫秒数
    expect(
      validateAuthUsers([
        { username: "a", password: "x", expiresAt: "2026-10-01T08:00:00+08:00" },
        { username: "b", password: "x", expiresAt: "2026-10-01T00:00:00Z" },
      ]),
    ).toEqual([
      { username: "a", password: "x", expiresAt: Date.parse("2026-10-01T00:00:00Z") },
      { username: "b", password: "x", expiresAt: Date.parse("2026-10-01T00:00:00Z") },
    ]);
  });

  it("缺省不写 expiresAt 键（最小账号产物逐字不变）", () => {
    expect(Object.keys(validateAuthUsers([{ username: "a", password: "x" }])![0]!)).toEqual([
      "username",
      "password",
    ]);
  });

  it("必须带时区偏移：无偏移 / 空格分隔 / 只有日期一律整份文件非法", () => {
    // `Date.parse` 会给前三个都返回一个数（分别按 UTC 午夜 / 本地午夜 / 本地午夜猜），
    // 那是「看起来配了、实际是另一个时刻」的假安全感。
    expect(at("2026-10-01")).toBeUndefined();
    expect(at("2026-10-01 00:00")).toBeUndefined();
    expect(at("2026-10-01T00:00:00")).toBeUndefined();
    expect(at("2026-10-01T00:00:00+08")).toBeUndefined();
    // 毫秒只允许出现在**秒之后**（`…T00:00:00.5Z` 合法；`…T00:00.5Z` 是别的形态，拒）
    expect(at("2026-10-01T00:00:00.5Z")).toBeDefined();
    expect(at("2026-10-01T00:00.5Z")).toBeUndefined();
  });

  it("日历上不存在的日非法（Date.parse 会静默滚成下个月）", () => {
    // 实测 `Date.parse("2026-02-30T00:00:00Z")` = 1772409600000（= 3 月 2 日），有限值
    expect(Date.parse("2026-02-30T00:00:00Z")).not.toBeNaN();
    expect(at("2026-02-30T00:00:00Z")).toBeUndefined();
    expect(at("2026-04-31T00:00:00Z")).toBeUndefined();
    expect(at("2027-02-29T00:00:00Z")).toBeUndefined(); // 2027 不是闰年
    // 合法闰日仍然通过（别把判据写太紧）
    expect(at("2028-02-29T00:00:00Z")).toBeDefined();
  });

  it("非字符串 / 月 13 / 时 24 非法", () => {
    expect(at(1234567890)).toBeUndefined();
    expect(at(null)).toBeUndefined();
    expect(at("")).toBeUndefined();
    expect(at("2026-13-01T00:00:00Z")).toBeUndefined();
    expect(at("2026-10-01T24:00:00Z")).toBeUndefined();
  });

  it("已过期是合法值（只有形态非法才作废整份文件）", () => {
    // 判它非法等于「把账号设成过期 → 整个服务起不来」
    expect(at("2020-01-01T00:00:00Z")).toEqual({
      username: "a",
      password: "x",
      expiresAt: Date.parse("2020-01-01T00:00:00Z"),
    });
  });

  it("与 quota / acl 各自独立：expiresAt 非法让整份文件作废（同表其它账号也救不回）", () => {
    expect(
      validateAuthUsers([
        { username: "ok", password: "x", quota: { bytes: 10 } },
        { username: "bad", password: "x", expiresAt: "2026-10-01" },
      ]),
    ).toBeUndefined();
  });
});
