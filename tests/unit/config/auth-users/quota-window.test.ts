/**
 * `quota.window`：只认 `day` / `month` 两个日历窗（形状面八条 + 读取面三条）。
 *
 * 「禁滚动窗 / 禁限速 / 禁并发」与「缺省 `month` 归一在消费侧、不许塞进配置产物」的理由在
 * `./AGENTS.md`。
 *
 * @module tests/unit/config/auth-users
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { credentialIndexesFor } from "@/core/helpers/index.js";
import { loadUserQuota, readAuthUsers, validateAuthUsers } from "@/datasource/users/index.js";
import { restoreConfig, set, snapshotConfig } from "../../../helpers/config.js";
import { codeOf } from "../../../helpers/source-scan.js";
import { acc } from "./_user-quota.js";

describe("config/auth-users quota.window（只认 day/month 两个日历窗）", () => {
  it("白名单联动：带 window 的文件校验通过（把 window 从 QUOTA_KEYS 删掉 → 本条立刻红）", () => {
    // 这是「最容易漏的联动点」的第二处（第一处是 ACCOUNT_KEYS 里的 `quota` 本身）：
    // `QUOTA_KEY_SET` 是**闭合集合**，漏掉 `window` 会让所有写了窗口的文件因「未知子键」
    // 整组非法 → 启动期 abort。**已变异测试验证**：把它从 QUOTA_KEYS 删掉 → 本条红。
    expect(
      validateAuthUsers([
        { username: "a", password: "x", quota: { bytes: 10, window: "day" } },
        { username: "b", password: "x", quota: { bytes: 1, window: "month" } },
      ]),
    ).toEqual([
      { username: "a", password: "x", quota: { bytes: 10, window: "day" } },
      { username: "b", password: "x", quota: { bytes: 1, window: "month" } },
    ]);
  });

  it("合法值只有 day / month，且原样回显在归一化产物里", () => {
    for (const w of ["day", "month"]) {
      const out = validateAuthUsers([{ username: "a", password: "x", quota: { window: w } }]);
      expect(out).toEqual([
        { username: "a", password: "x", quota: { bytes: 0, window: w } },
      ]);
    }
  });

  it("缺省**不写** window 键（缺省 month 是消费侧裁决，不许塞进配置产物）", () => {
    // 为什么不在这里补 month：归一化产物只回显磁盘上写了什么。补了会让「旧文件产物逐字不变」
    // 那条不变量失效（运维没配 window，产物里却凭空多出一个值）。缺省归一在
    // `@/datasource/quota-window.ts:quotaWindow` —— 那是消费侧裁决，不是文件事实。
    const out = validateAuthUsers([{ username: "a", password: "x", quota: { bytes: 5 } }])!;
    expect(out[0]!.quota).toEqual({ bytes: 5 });
    expect(Object.keys(out[0]!.quota!).sort()).toEqual(["bytes"]);
    // 旧格式（没 quota）同样不凭空长出 quota/window 键
    const bare = validateAuthUsers([{ username: "a", password: "x" }])!;
    expect(Object.keys(bare[0]!)).toEqual(["username", "password"]);
  });

  it("非法 window 整组非法（其它字面量 / 大小写变体 / 空串 / 非字符串全部 abort）", () => {
    const bad = (window: unknown): unknown =>
      validateAuthUsers([{ username: "a", password: "x", quota: { bytes: 1, window } }]);
    // 不做滚动窗：week/hour 都是「看起来合理但明确不做」的值，必须 fail-closed
    expect(bad("week")).toBeUndefined();
    expect(bad("hour")).toBeUndefined();
    expect(bad("rolling")).toBeUndefined();
    expect(bad("weekly")).toBeUndefined();
    expect(bad("")).toBeUndefined();
    // 大小写敏感：枚举值一律精确匹配，"DAY" 这种"看懂了"的手滑必须报错而不是回退
    expect(bad("DAY")).toBeUndefined();
    expect(bad("Month")).toBeUndefined();
    expect(bad(true)).toBeUndefined();
    expect(bad(null)).toBeUndefined();
    expect(bad(1)).toBeUndefined();
    expect(bad(["day"])).toBeUndefined();
    // window 非法时**整组作废**（连字节字段一起丢），绝不是「只丢 window」
    expect(bad("week")).toBeUndefined();
  });

  it("window 与字节字段互不救场：任一非法即整组非法（fail-closed，与 acl 同语义）", () => {
    expect(
      validateAuthUsers([{ username: "a", password: "x", quota: { bytes: -1, window: "day" } }]),
    ).toBeUndefined();
    expect(
      validateAuthUsers([{ username: "a", password: "x", quota: { window: "day", rateBps: 1 } }]),
    ).toBeUndefined();
  });

  it("window 与 acl 各自独立：一个合法一个非法 → 整份文件作废", () => {
    expect(
      validateAuthUsers([
        {
          username: "a",
          password: "x",
          acl: { target: { whitelist: ["*.corp.com"] } },
          quota: { bytes: 10, window: "day" },
        },
      ]),
    ).toEqual([
      {
        username: "a",
        password: "x",
        acl: { target: { whitelist: ["*.corp.com"], blacklist: [] } },
        quota: { bytes: 10, window: "day" },
      },
    ]);
    expect(
      validateAuthUsers([
        {
          username: "a",
          password: "x",
          acl: { target: { whitelist: ["*.corp.com"] } },
          quota: { window: "week" },
        },
      ]),
    ).toBeUndefined();
    expect(
      validateAuthUsers([
        { username: "a", password: "x", acl: { target: { whitelist: ["a.com:80"] } }, quota: { window: "day" } },
      ]),
    ).toBeUndefined();
  });

  it("window 对凭证索引同样不可见（与 acl/quota 一样不进 basic/uidUsers）", () => {
    const plain = validateAuthUsers([{ username: "alice", password: "pw1" }])!;
    const withWindow = validateAuthUsers([
      { username: "alice", password: "pw1", quota: { bytes: 10, window: "day" } },
    ])!;
    const a = credentialIndexesFor(plain);
    const b = credentialIndexesFor(withWindow);
    expect([...b.basic.entries()].sort()).toEqual([...a.basic.entries()].sort());
    expect([...b.uidUsers].sort()).toEqual([...a.uidUsers].sort());
    expect([...b.basic.keys()].some((k) => k.includes("day"))).toBe(false);
  });

  it("本文件不出现任何滚动窗/速率/并发字段名（不预留占位值）", () => {
    const code = codeOf("datasource", "users", "read.ts");
    expect(code).not.toMatch(/rateBps|maxConnections|\bconcurrency\b/);
    // 滚动窗的字面量也不许出现在校验表里（真要支持必须连同账本形态一起设计）
    const quotaWindowSet = code.slice(code.indexOf("QUOTA_WINDOW_VALUES"), code.indexOf("USER_POLICY_GROUP_KEYS"));
    expect(quotaWindowSet).not.toMatch(/week|hour|rolling/);
  });
});

describe("config/auth-users loadUserQuota 的 window（读取面）", () => {
  let dir: string;
  let snap: Record<string, unknown>;
  let file: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-quota-window-test-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    snap = snapshotConfig(["authUsersFile", "logLevel", "logFile"]);
    set("logLevel", "silent");
    set("logFile", "");
    file = path.join(dir, `users-${Math.random().toString(36).slice(2)}.json`);
    set("authUsersFile", file);
  });

  afterEach(() => {
    restoreConfig(snap);
  });

  it("读出的配额带 window（缺省时该键不存在，由消费侧归一为 month）", () => {
    fs.writeFileSync(
      file,
      JSON.stringify([
        { username: "a", password: "x", quota: { bytes: 10, window: "day" } },
        { username: "b", password: "x", quota: { bytes: 10 } },
      ]),
    );
    expect(loadUserQuota("a", acc())).toEqual({
      bytes: 10,
      window: "day",
    });
    expect(loadUserQuota("b", acc())).toEqual({ bytes: 10 });
  });

  it("带 window 的返回值深度冻结，且热路径零分配（toBe 同身份）", () => {
    fs.writeFileSync(
      file,
      JSON.stringify([{ username: "a", password: "x", quota: { bytes: 10, window: "day" } }]),
    );
    const first = loadUserQuota("a", acc())!;
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      (first as { window?: string }).window = "month";
    }).toThrow(TypeError);
    // 记忆表按源对象身份命中：连续两次查询同一对象（带 window 的形态也必须成立）
    expect(loadUserQuota("a", acc())).toBe(first);
  });

  it("坏 window 保留上一份有效值（与字节字段同一条缓存与坏文件策略）", () => {
    fs.writeFileSync(
      file,
      JSON.stringify([{ username: "a", password: "x", quota: { bytes: 10, window: "day" } }]),
    );
    expect(loadUserQuota("a", acc())?.window).toBe("day");
    fs.writeFileSync(
      file,
      JSON.stringify([{ username: "a", password: "x", quota: { bytes: 10, window: "week" } }]),
    );
    expect(readAuthUsers({ locator: acc(), force: true }).error).toBeTruthy();
    expect(loadUserQuota("a", acc())?.window).toBe("day");
  });
});
