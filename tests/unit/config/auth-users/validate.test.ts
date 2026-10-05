/**
 * `validateAuthUsers` 的形状校验：账号本身七条，加账号级 `acl` 那十。
 *
 * 形状是**闭合白名单**（`ACCOUNT_KEYS` / `QUOTA_KEYS` / `acl` 的组名集合），任一格不合法即
 * **整份文件作废**。共享的不变量（四个已否决方向、两条「对凭证索引不可见」）在 `./AGENTS.md`。
 *
 * @module tests/unit/config/auth-users
 */

import { describe, expect, it } from "vitest";
import { validateAuthUsers } from "@/datasource/users/index.js";
import { parseHostRule } from "@/utils/addr/index.js";
import { MIXED_ACCOUNTS } from "./_auth-users.js";

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
