/**
 * `validateAuthUsers` 的 `quota` 形状面：可选 / `bytes` 缺省补 0 / 非负安全整数 /
 * 未知子键与分方向上限字段一律 `fail-closed`。
 *
 * 「禁限速 / 禁并发 / 不做 aliases」与「`quota` 与 `acl` 各自独立决定整份文件是否作废」在 `./AGENTS.md`。
 *
 * @module tests/unit/config/auth-users
 */

import { describe, expect, it } from "vitest";
import {
  credentialIndexesFor,
  encodeBasicCredentials,
  matchBasicCredential,
} from "@/core/helpers/index.js";
import { validateAuthUsers } from "@/datasource/users/index.js";
import { MIXED, UNLIMITED } from "./_user-quota.js";

describe("config/auth-users validateAuthUsers 的 quota 形状", () => {
  it("ACCOUNT_KEYS 联动：带 quota 的文件校验通过（漏加白名单 → 整份文件被判非法）", () => {
    // 这条是「最容易漏的联动点」的专门断言：`ACCOUNT_KEYS` 不含 `quota` 时，
    // 上面 MIXED 里所有带配额的账号文件都会因「未知顶层键」整份作废。
    expect(validateAuthUsers(MIXED)).toEqual(MIXED);
  });

  it("旧格式逐字不变：不写 quota 键，键集合恰为 username/password", () => {
    const out = validateAuthUsers([{ username: "alice", password: "pw1" }])!;
    expect(out).toEqual([{ username: "alice", password: "pw1" }]);
    expect(Object.keys(out[0]!)).toEqual(["username", "password"]);
  });

  it("quota 可选：空对象补成 0（= 不限流），只写 window 时 bytes 也补 0", () => {
    expect(validateAuthUsers([{ username: "a", password: "x", quota: {} }])).toEqual([
      { username: "a", password: "x", quota: UNLIMITED },
    ]);
    expect(validateAuthUsers([{ username: "a", password: "x", quota: { window: "day" } }])).toEqual([
      { username: "a", password: "x", quota: { bytes: 0, window: "day" } },
    ]);
  });

  it("非负安全整数都合法：0 / 1 / 2^53-1（边界）", () => {
    const max = Number.MAX_SAFE_INTEGER;
    for (const bytes of [0, 1, max]) {
      expect(validateAuthUsers([{ username: "a", password: "x", quota: { bytes } }])).toEqual([
        { username: "a", password: "x", quota: { bytes } },
      ]);
    }
  });

  it("非法值一律整组非法：负数 / 小数 / 字符串 / 布尔 / null / NaN / Infinity / 超安全整数", () => {
    const bad = (quota: unknown): unknown =>
      validateAuthUsers([{ username: "a", password: "x", quota }]);
    expect(bad({ bytes: -1 })).toBeUndefined();
    expect(bad({ bytes: 1.5 })).toBeUndefined();
    expect(bad({ bytes: "1024" })).toBeUndefined();
    expect(bad({ bytes: true })).toBeUndefined();
    expect(bad({ bytes: null })).toBeUndefined();
    expect(bad({ bytes: Number.NaN })).toBeUndefined();
    expect(bad({ bytes: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(bad({ bytes: Number.MAX_SAFE_INTEGER + 2 })).toBeUndefined();
    // quota 本身不是对象
    expect(bad("x")).toBeUndefined();
    expect(bad(null)).toBeUndefined();
    expect(bad([])).toBeUndefined();
    expect(bad(1024)).toBeUndefined();
  });

  it("未知子键 fail-closed（不写 rateBps / concurrency 之类：限速与并发数明确不做）", () => {
    const bad = (quota: unknown): unknown =>
      validateAuthUsers([{ username: "a", password: "x", quota }]);
    expect(bad({ bytes: 1, rateBps: 100 })).toBeUndefined();
    expect(bad({ bytes: 1, maxConnections: 4 })).toBeUndefined();
    expect(bad({ bytes: 1, concurrency: 2 })).toBeUndefined();
    expect(bad({ bytes: 1, rate: 1 })).toBeUndefined();
    expect(bad({ bytesPerSecond: 1 })).toBeUndefined();
  });

  it("分方向上限字段一律非法（quota 只有一个合计上限，不做 aliases）", () => {
    // 零兼容：这两个名字**不在** QUOTA_KEYS 里，故出现即「未知子键」→ 整组非法 → 启动 abort。
    // 刻意不认它们：认下旧名等于给「我配了分向上限」一个假的安全感，而实际上判定是账号级封禁，
    // 配出来的语义与运维想的不同（见 `@/datasource/users/types.ts` 的 `UserQuota`）。
    const bad = (quota: unknown): unknown =>
      validateAuthUsers([{ username: "a", password: "x", quota }]);
    expect(bad({ bytesUp: 1 })).toBeUndefined();
    expect(bad({ bytesDown: 1 })).toBeUndefined();
    expect(bad({ bytes: 1, bytesUp: 1 })).toBeUndefined();
    expect(bad({ bytes: 1, bytesDown: 1 })).toBeUndefined();
    expect(bad({ bytesPerSecond: 1 })).toBeUndefined();
  });

  it("quota 与 acl 互不影响：各自独立校验、各自独立决定整份文件是否作废", () => {
    // 两者都合法 → 互不干扰
    expect(
      validateAuthUsers([
        {
          username: "a",
          password: "x",
          acl: { target: { blacklist: ["ads.io"] } },
          quota: { bytes: 10 },
        },
      ]),
    ).toEqual([
      {
        username: "a",
        password: "x",
        acl: { target: { whitelist: [], blacklist: ["ads.io"] } },
        quota: { bytes: 10 },
      },
    ]);
    // 一个合法一个非法 → **整份文件非法**（fail-closed），不是「只丢非法的那一个」
    expect(
      validateAuthUsers([
        { username: "a", password: "x", acl: { target: { blacklist: ["ads.io"] } }, quota: { bytes: -1 } },
      ]),
    ).toBeUndefined();
    expect(
      validateAuthUsers([
        { username: "a", password: "x", acl: { target: { blacklist: ["ads.io:80"] } }, quota: { bytes: 1 } },
      ]),
    ).toBeUndefined();
  });

  it("quota 不让原有账号规则退让（重复用户名 / 含 ':' / 未知顶层键 / 密码类型）", () => {
    expect(
      validateAuthUsers([
        { username: "a", password: "x", quota: {} },
        { username: "a", password: "y" },
      ]),
    ).toBeUndefined();
    expect(validateAuthUsers([{ username: "a:b", password: "x", quota: {} }])).toBeUndefined();
    expect(validateAuthUsers([{ username: "", password: "x", quota: {} }])).toBeUndefined();
    expect(
      validateAuthUsers([{ username: "a", password: "x", quota: {}, role: "admin" }]),
    ).toBeUndefined();
    expect(validateAuthUsers([{ username: "a", quota: {} }])).toBeUndefined();
    expect(validateAuthUsers([{ username: "a", password: 1, quota: {} }])).toBeUndefined();
  });

  it("凭证索引不受 quota 影响（quota 与 acl 一样对索引不可见）", () => {
    // 两侧**账号集合必须相同**，否则比的是「多了一个账号」而不是「quota 有没有污染索引」
    const plain = validateAuthUsers([
      { username: "alice", password: "pw1" },
      { username: "bob", password: "pw2" },
      { username: "carol", password: "pw3" },
    ])!;
    const withQuota = validateAuthUsers(MIXED)!;
    const a = credentialIndexesFor(plain);
    const b = credentialIndexesFor(withQuota);
    expect([...b.basic.entries()].sort()).toEqual([...a.basic.entries()].sort());
    expect([...b.uidUsers].sort()).toEqual([...a.uidUsers].sort());
    expect(matchBasicCredential(encodeBasicCredentials("carol", "pw3"), b)).toBe("carol");
    // 配额数字绝不进索引（basic 键只可能是 b64(user:pass) / user:pass 两种形态）
    expect([...b.basic.keys()].some((k) => k.includes("1024"))).toBe(false);
    expect([...b.basic.keys()].some((k) => k.includes("corp.com"))).toBe(false);
  });
});
