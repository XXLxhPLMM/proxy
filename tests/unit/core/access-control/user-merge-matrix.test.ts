/**
 * 个人名单与全局名单**合流的优先级真值表**（全局 3 档 × 个人 3 档，穷举不抽样）
 *
 * 以及它两个邻档：内置引擎的 `reason` 取值集合（含那条**闭合集守卫已从编译期降级**的
 * 纪律）、无身份即无个人层。三档共用的夹具（账号表构造器 / 名单档位常量 / 写盘器 /
 * 判定面工厂）归 `./_user-acl-merge.ts`，**为什么这么合流**归 `./AGENTS.md`。
 *
 * @module tests/unit/core/access-control/user-merge-matrix
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type { AccessControl, AccessDecision } from "@/core/types/proxy.js";
import { blockAfter, codeOf } from "../../../helpers/source-scan.js";
import { restoreConfig, silenceLogs, snapshotConfig } from "../../../helpers/config.js";
import {
  GLOBAL_ALLOW,
  GLOBAL_BLACKLIST,
  GLOBAL_WHITELIST_MISS,
  HOST,
  MERGE_KEYS,
  USER,
  USER_ALLOW,
  USER_BLACKLIST,
  USER_WHITELIST_MISS,
  accounts,
  cleanupMergeDirs,
  newAccess,
  writeLists,
} from "./_user-acl-merge.js";

let snap: Record<string, unknown>;
let access: AccessControl;

beforeEach(() => {
  snap = snapshotConfig(MERGE_KEYS);
  silenceLogs();
  access = newAccess();
});

afterEach(() => {
  restoreConfig(snap);
  cleanupMergeDirs();
});

/**
 * 本目录自有的名单原因字面量集 —— **不是**从 `@/core/access-control.js` 导出的公共别名
 * （那里的 `AclReason` 是模块私有类型、不导出）。而「内置引擎只产这两个值」这条不变量
 * **一条都没弱**：编译期那一半已不可能存在（端口对外是自由 `string`），改由运行期取值集合
 * （下面那张 9 档穷举表）、源码级（`hostDenied` 只返回两个字面量）与事件面（`source`
 * 独立字段）三重自律接住 —— 逐条论证归 `./AGENTS.md`。
 */
type ListReason = "whitelist" | "blacklist";

interface MergeCase {
  global: string;
  acl: unknown;
  user: string;
  userAcl: unknown;
  allowed: boolean;
  reason?: ListReason;
  source?: "global" | "user";
}

const MERGE_CASES: readonly MergeCase[] = [
  // 全局放行：个人层说了算
  { global: "放行", acl: GLOBAL_ALLOW, user: "放行", userAcl: USER_ALLOW, allowed: true },
  {
    global: "放行",
    acl: GLOBAL_ALLOW,
    user: "黑名单命中",
    userAcl: USER_BLACKLIST,
    allowed: false,
    reason: "blacklist",
    source: "user",
  },
  {
    global: "放行",
    acl: GLOBAL_ALLOW,
    user: "白名单未命中",
    userAcl: USER_WHITELIST_MISS,
    allowed: false,
    reason: "whitelist",
    source: "user",
  },
  // 全局黑名单命中：绝对拒绝，个人名单一律不看
  {
    global: "黑名单命中",
    acl: GLOBAL_BLACKLIST,
    user: "放行",
    userAcl: USER_ALLOW,
    allowed: false,
    reason: "blacklist",
    source: "global",
  },
  // 两关都拒（且 reason 相同）→ 报全局那一条
  {
    global: "黑名单命中",
    acl: GLOBAL_BLACKLIST,
    user: "黑名单命中",
    userAcl: USER_BLACKLIST,
    allowed: false,
    reason: "blacklist",
    source: "global",
  },
  {
    global: "黑名单命中",
    acl: GLOBAL_BLACKLIST,
    user: "白名单未命中",
    userAcl: USER_WHITELIST_MISS,
    allowed: false,
    reason: "blacklist",
    source: "global",
  },
  // 全局白名单未命中：同样绝对拒绝
  {
    global: "白名单未命中",
    acl: GLOBAL_WHITELIST_MISS,
    user: "放行",
    userAcl: USER_ALLOW,
    allowed: false,
    reason: "whitelist",
    source: "global",
  },
  // 两关都拒且 reason 不同（个人是 blacklist、全局是 whitelist）→ 仍报全局那一条
  {
    global: "白名单未命中",
    acl: GLOBAL_WHITELIST_MISS,
    user: "黑名单命中",
    userAcl: USER_BLACKLIST,
    allowed: false,
    reason: "whitelist",
    source: "global",
  },
  {
    global: "白名单未命中",
    acl: GLOBAL_WHITELIST_MISS,
    user: "白名单未命中",
    userAcl: USER_WHITELIST_MISS,
    allowed: false,
    reason: "whitelist",
    source: "global",
  },
];

describe("判定层/个人名单合流：优先级真值表（3×3 穷举）", () => {
  for (const c of MERGE_CASES) {
    it(`全局 ${c.global} × 个人 ${c.user} → ${c.allowed ? "放行" : `拒(${c.source}:${c.reason})`}`, () => {
      writeLists(c.acl, accounts(c.userAcl));

      expect(access.checkTarget({ host: HOST, user: USER })).toEqual({
        allowed: c.allowed,
        reason: c.reason,
        source: c.source,
      });
      // 键的集合也锁住：放行**不写** reason/source（source 只在拒绝时有意义）
      expect(Object.keys(access.checkTarget({ host: HOST, user: USER })).sort()).toEqual(
        c.allowed ? ["allowed"] : ["allowed", "reason", "source"],
      );
    });
  }

  it("对照组：同一个 alice 换成 bob 的判定结果，证明判定确实按用户取名单", () => {
    // 全局放行、alice 禁 HOST、bob 圈住 HOST
    writeLists(GLOBAL_ALLOW, accounts(USER_BLACKLIST));

    expect(access.checkTarget({ host: HOST, user: USER })).toEqual({
      allowed: false,
      reason: "blacklist",
      source: "user",
    });
    expect(access.checkTarget({ host: HOST, user: "bob" })).toEqual({ allowed: true });
  });
});

describe("判定层/内置引擎的 reason 取值集合", () => {
  it("编译期：AccessDecision.reason 是自由 string（端口放宽的既定事实）", () => {
    // 这条断言锁的是「reason 已是自由 string」，方向写清楚：
    // 被否掉的是「用一个**导出的公共闭合集**把『名单只说这两个字』提到编译期」。
    // `AccessDecision.reason` 是 `string | undefined`：因为访问控制一旦对外暴露，替换实现
    // （限速引擎 / 地域封锁 / 订阅制网关）必须能表达
    // 自己的结论（`"rate-limited"` / `"geo-blocked"`），闭合集会让它们**没法用类型描述结论**。
    //
    // 代价是**「内置引擎只产两个字」这条不变量失去了编译期保证**——它降级为三重自律：
    // 文档（上面那个 `ListReason`）+ 源码级断言（下一条：hostDenied 只返回两个字面量 +
    // `source:` 字面量集合恰为 {global,user}）+ 运行期取值集合（再下一条：9 档全落集合内、
    // 两种值都真出现过）。**任何一层失效，另外两层还在。**
    expectTypeOf<AccessDecision["reason"]>().toEqualTypeOf<string | undefined>();
    // source 同样放宽：内置引擎仍只出 global|user，但类型层不再兜（见下一条源码断言）
    expectTypeOf<AccessDecision["source"]>().toEqualTypeOf<string | undefined>();
  });

  it("运行期：上述 9 档的 reason 全部落在名单集合内（放行档不带 reason）", () => {
    const reasons: ListReason[] = [];

    for (const c of MERGE_CASES) {
      writeLists(c.acl, accounts(c.userAcl));
      const decision = access.checkTarget({ host: HOST, user: USER });
      if (decision.allowed) {
        expect(decision.reason).toBeUndefined();
        continue;
      }
      expect(["whitelist", "blacklist"]).toContain(decision.reason);
      reasons.push(decision.reason as ListReason);
    }

    // 两种 reason 都真的出现过（否则上面只是「恰好同一种值」也算过）
    expect(new Set(reasons).size).toBe(2);
  });

  it("源码级：判定层不出现任何 'user:blacklist' / 拼接式 reason", () => {
    const code = codeOf("core", "access-control.ts");

    // 分层信息只许走独立的 source 字段
    expect(code).not.toContain("user:blacklist");
    expect(code).not.toContain("global:blacklist");
    // reason 不许由模板串/变量拼出「层级前缀」：两关的 reason 只能来自 hostDenied 的两个字面量
    expect(code).not.toMatch(/`[^`]*\$\{[^}]*\}[^`]*blacklist/);
    // 判定层写出的 source 只可能是 global / user 这两个字面量（新增第三个即红）
    expect([...code.matchAll(/source:\s*"([^"]*)"/g)].map((m) => m[1]).sort()).toEqual([
      "global",
      "user",
    ]);
    // 两层名单判定确实共用同一个实现（抄两份迟早漂移）
    const hostDenied = blockAfter(code, "function hostDenied(");
    expect(hostDenied).toContain('return "blacklist";');
    expect(hostDenied).toContain('return "whitelist";');
    expect(hostDenied).not.toContain("user");
    expect(hostDenied).not.toContain("global");
  });
});

describe("判定层/无身份即无个人层", () => {
  it("省略 user：个人名单完全不生效（alice 的黑名单不拦）", () => {
    writeLists(GLOBAL_ALLOW, accounts(USER_BLACKLIST));

    expect(access.checkTarget({ host: HOST })).toEqual({ allowed: true });
    // 显式 undefined 与省略同义
    expect(access.checkTarget({ host: HOST, user: undefined })).toEqual({ allowed: true });
  });

  it("用户不存在 / 未配 acl / 两组皆空：个人层中性放行", () => {
    // 未配 acl 的账号（alice 缺席，只有 bob 在表里）
    writeLists(GLOBAL_ALLOW, accounts());
    expect(access.checkTarget({ host: HOST, user: USER })).toEqual({ allowed: true });
    expect(access.checkTarget({ host: HOST, user: "nobody" })).toEqual({ allowed: true });
    expect(access.checkTarget({ host: HOST, user: "" })).toEqual({ allowed: true });

    // 配了 acl 但 target 两组皆空 = 不做限制（与全局组「皆空即放行」同语义）
    writeLists(GLOBAL_ALLOW, accounts({ target: {} }));
    expect(access.checkTarget({ host: HOST, user: USER })).toEqual({ allowed: true });
    writeLists(GLOBAL_ALLOW, accounts({ target: { whitelist: [], blacklist: [] } }));
    expect(access.checkTarget({ host: HOST, user: USER })).toEqual({ allowed: true });
  });

  it("用户未配 acl 时全局判定照旧生效（中性 ≠ 放行一切）", () => {
    writeLists(GLOBAL_BLACKLIST, accounts());

    expect(access.checkTarget({ host: HOST, user: USER })).toEqual({
      allowed: false,
      reason: "blacklist",
      source: "global",
    });
  });
});