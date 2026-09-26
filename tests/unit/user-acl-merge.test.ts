/**
 * 每用户访问名单（`users.json` 的 `acl`）与全局 `acl.json` 的**合流判定**护栏
 *
 * @description
 * 锁的是一条合并语义 + 它的三条边界，全部在判定层（`src/core/access-control.ts`）断言：
 *
 * ```
 * 放行 ⇔ 全局 target 组放行 ∧ 该用户的 target 组放行
 * ```
 * - **先全局、后个人、全局短路**：全局拒绝是**绝对**的（个人名单只能更严、不能更松）
 * - **两关都拒时报全局那一条**（`source:"global"`）：全局是权威层，运维先看到自己的全局配置
 * - **无身份即无个人层**：`user` 省略 / 用户不存在 / 未配 `acl` → 中性放行
 * - **个人名单不越界**：绝不参与 `checkClient`（鉴权之前没有身份）与 `checkRoute`
 *   （client 模式的路由决策与「你是谁」正交）
 * - **内置引擎的 `reason` 恒为 `whitelist|blacklist`、分层信息只走独立的 `source` 字段**：
 *   写成 `"user:blacklist"` 就是把层级前缀塞进 reason。所以除了运行期断言，这里还有一条
 *   源码级负向断言（`hostDenied` 只返回两个字面量 + 写出的 `source:` 字面量集合恰为
 *   `{global,user}`）——**这条纪律的落点是「生产者」不是「类型」**：`AclReason` 是
 *   `access-control.ts` 的**模块私有类型、不导出**（端口对外是自由 `string`，替换实现
 *   要能表达自己的原因），于是「内置引擎只说这两个字」从**编译期**降级为
 *   **文档 + 源码级断言 + 运行期取值集合**三重自律。见下方 describe 的说明。
 * - **热路径零分配**：策略快照未变时 `loadUserPolicy` 不再产生新对象（同身份 `toBe`）
 *
 * 四条转发路径的接线（HTTP / CONNECT / Upgrade / SOCKS）与事件去重在
 * `tests/integration/user-acl-enforcement.test.ts`；本文件只管判定层。
 */

import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadUserPolicy, readAcl, readAuthUsers } from "@/config/index.js";
import { createFileAccessControl } from "@/core/access-control.js";
import { EventHub } from "@/core/events/index.js";
import type { EventEnvelope, EventName } from "@/core/events/index.js";
import type { CoreContext } from "@/core/context.js";
import type { AccessControl, AccessDecision, PipeEvent } from "@/core/types/proxy.js";
import { CoreEventBridge } from "@/runtime/bridge.js";
import { restoreConfig, set, silenceLogs, snapshotConfig, testConfig, testLogger } from "../helpers/config.js";
import { blockAfter, codeOf } from "../helpers/source-scan.js";
import { sleep } from "../helpers/net.js";

/** 判定对象固定用这一个域名（名单按 host 字符串匹配，不做 DNS） */
const HOST = "target.test";
/** 用来构造「白名单非空但未命中」的另一个域名 */
const OTHER = "other.test";
const USER = "alice";

const KEYS = ["aclFile", "authUsersFile", "logLevel", "logFile"] as const;

/** 本文件每例用**独立的一对文件**：绕开 `readJsonCached` 的 1s 节流与缓存键复用，例与例之间零耦合 */
const dirs: string[] = [];

/** 写 acl.json + users.json 并各强制读一次（让两个读取器立刻建好缓存条目） */
function writeLists(acl: unknown, users: unknown): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-acl-merge-"));
  dirs.push(dir);
  const aclPath = path.join(dir, "acl.json");
  const usersPath = path.join(dir, "users.json");
  fs.writeFileSync(aclPath, JSON.stringify(acl));
  fs.writeFileSync(usersPath, JSON.stringify(users));
  set("aclFile", aclPath);
  set("authUsersFile", usersPath);
  readAcl({ config: testConfig, force: true });
  readAuthUsers({ config: testConfig, force: true });
}

/** 只改写 users.json（acl.json 不动），并把 mtime 顶到未来以确保「内容已变」是确定的 */
function writeUsers(users: unknown): void {
  const usersPath = testConfig.get("authUsersFile");
  clock += 1000;
  fs.writeFileSync(usersPath, JSON.stringify(users));
  fs.utimesSync(usersPath, clock / 1000, clock / 1000);
}

let clock = 0;
let snap: Record<string, unknown>;

/** 账号表：alice 的个人名单由用例给；bob 恒为「白名单圈住 HOST」（对照组：证明判定确实是按用户的） */
function accounts(aliceAcl?: unknown): unknown[] {
  return [
    ...(aliceAcl === undefined ? [] : [{ username: USER, password: "pw1", acl: aliceAcl }]),
    { username: "bob", password: "pw2", acl: { target: { whitelist: [HOST] } } },
  ];
}

/**
 * 判定面收成 `AccessControl` 端口后，每例建一份、共用 `testConfig` 访问器。
 * 「每例新建」不影响本文件任何一条热加载用例：编译结果按 accessor 记忆、名单快照未变即复用，
 * 变的是 `aclFile`/`authUsersFile` 指向的文件**内容**，`readAcl`/`loadUserPolicy` 现读
 * + 快照身份变化自然触发重编译。
 */
let access: AccessControl;

beforeEach(() => {
  snap = snapshotConfig(KEYS);
  silenceLogs();
  access = createFileAccessControl(testConfig);
});

afterEach(() => {
  restoreConfig(snap);
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 护栏 1：优先级真值表（全局 3 档 × 个人 3 档 = 穷举 9 档，不抽样）
// ---------------------------------------------------------------------------

/** 全局 target 组对 HOST 的三种结果 */
const GLOBAL_ALLOW = {};
const GLOBAL_BLACKLIST = { target: { blacklist: [HOST] } };
const GLOBAL_WHITELIST_MISS = { target: { whitelist: [OTHER] } };

/** 个人 target 组对 HOST 的三种结果（「放行」用**显式白名单命中**，不留「没配 acl」的模糊空间） */
const USER_ALLOW = { target: { whitelist: [HOST] } };
const USER_BLACKLIST = { target: { blacklist: [HOST] } };
const USER_WHITELIST_MISS = { target: { whitelist: [OTHER] } };

/**
 * 本文件自有的名单原因字面量集。
 *
 * ⚠️ 它是**本测试档自有的**字面量集，不是从 `@/core/access-control.js` 导出的公共别名 ——
 * 那里面的 `AclReason` 是**模块私有类型、不导出**（端口对外是自由 `string`，限速 / 地域封锁 /
 * 订阅网关那些替换实现要能表达自己的结论，闭合集会让它们 `as never` 强转）。
 * 但「内置引擎只产这两个值」这条不变量**一条都没弱**：编译期那一半（`expectTypeOf`）
 * 已不可能存在，改由本文件的三重自律接住 ——
 * ① 运行期：9 档真值表的 reason 全部落在集合内，且两种值都真出现过；
 * ② 源码级：`hostDenied` 函数体只返回这两个字面量、写出的 `source:` 字面量集合恰为
 *    `{global, user}`，且不出现 `user:blacklist` 之类拼接式 reason；
 * ③ 事件面：分层信息只走独立的 `source` 字段。
 * 「闭合集守卫从编译期降级为文档与内置引擎的自律」——降级这件事必须被写下来，否则
 * 下一个读代码的人会以为内置引擎可以随便吐 reason。
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
  // 护栏 7：两关都拒（且 reason 相同）→ 报全局那一条
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
  // 护栏 7：两关都拒且 reason 不同（个人是 blacklist、全局是 whitelist）→ 仍报全局那一条
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

// ---------------------------------------------------------------------------
// 护栏 2：内置引擎只产名单那两个 reason（分层信息只走 source）
// ---------------------------------------------------------------------------

describe("判定层/内置引擎的 reason 取值集合", () => {
  it("编译期：AccessDecision.reason 是自由 string（端口放宽的既定事实）", () => {
    // 这条断言锁的是「reason 已是自由 string」，方向写清楚：
    // 曾经的形状是 `expectTypeOf<AclReason>().toEqualTypeOf<"whitelist"|"blacklist">()` ——
    // 用一个**导出的公共闭合集**把「名单只说这两个字」提到编译期。
    // 现在 `AccessDecision.reason` 是 `string | undefined`：`AclReason` 随端口放宽一并删除，
    // 因为访问控制一旦对外暴露，替换实现（限速引擎 / 地理封锁 / 订阅制网关）必须能表达
    // 自己的结论（`"rate-limited"` / `"geo-blocked"`），闭合集会让它们**没法用类型描述结论**。
    //
    // 代价是**「内置引擎只产两个字」这条不变量失去了编译期保证**——它降级为三重自律：
    // 文档（本文件的 `ListReason` 注释）+ 源码级断言（下一条：hostDenied 只返回两个字面量 +
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

// ---------------------------------------------------------------------------
// 护栏 3：无身份即无个人层
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 护栏 4：个人名单不越界（不参与 clientIp / upstream 路由判定）
// ---------------------------------------------------------------------------

describe("判定层/个人名单不越界", () => {
  const GLOBAL = {
    clientIp: { blacklist: ["203.0.113.9"] },
    upstream: { blacklist: ["routed.test"] },
    target: { whitelist: [HOST] },
  };

  it("checkClient / checkRoute 的结果与个人名单无关（带 acl 与不带 acl 逐项相同）", () => {
    // 两份账号表只差 alice 有没有 acl；全局 acl.json 逐字相同
    writeLists(GLOBAL, accounts(USER_BLACKLIST));
    const withAcl = {
      clientIp: access.checkClient({ client: "203.0.113.9" }),
      clientIpOther: access.checkClient({ client: "198.51.100.5" }),
      upstream: access.checkRoute({ host: "routed.test" }),
      upstreamOther: access.checkRoute({ host: "kept.test" }),
    };

    writeLists(GLOBAL, accounts());
    const withoutAcl = {
      clientIp: access.checkClient({ client: "203.0.113.9" }),
      clientIpOther: access.checkClient({ client: "198.51.100.5" }),
      upstream: access.checkRoute({ host: "routed.test" }),
      upstreamOther: access.checkRoute({ host: "kept.test" }),
    };

    expect(withAcl).toEqual(withoutAcl);
    // 顺带钉住全局两组本身的语义（证明上面对比的是真判定，不是两个 undefined）
    expect(withAcl.clientIp).toEqual({ allowed: false, reason: "blacklist" });
    expect(withAcl.clientIpOther).toEqual({ allowed: true });
    expect(withAcl.upstream).toEqual({ direct: true, reason: "blacklist" });
    expect(withAcl.upstreamOther).toEqual({ direct: false });
  });

  it("源码级：checkClient / checkRoute 两个函数体零个人名单痕迹", () => {
    const code = codeOf("core", "access-control.ts");

    // 锚点从 `export function checkClientIp(` 迁到 `function checkClient(`：
    // 判定面收成 `createFileAccessControl` 端口后，三个判定降为**模块私有函数**（不再导出，
    // 调用方拿不到裸判定函数）。锚点必须跟着走，但断言的**不变量一字未变**：
    // 「个人名单绝不参与入站准入与路由判定」——它成立的理由是 `checkClient` 发生在鉴权**之前**
    // （那一刻还不存在「你是谁」），`checkRoute` 是 client 模式的路由决策（与身份正交）。
    // 「函数体里连 user 三个字母都不许出现」是这条不变量唯一可被自动检查的形态。
    for (const anchor of ["function checkClient(", "function checkRoute("]) {
      const body = blockAfter(code, anchor);
      expect(body).not.toContain("user");
      expect(body).not.toContain("loadUserPolicy");
      expect(body).not.toContain("compiledUserTarget");
    }
  });
});

// ---------------------------------------------------------------------------
// 护栏 5：热加载生效（改 users.json，不重启）
// ---------------------------------------------------------------------------

describe("判定层/个人名单热加载", () => {
  it("改 users.json 并越过 1s 节流：该用户判定改变，其他用户不受影响", async () => {
    writeLists(GLOBAL_ALLOW, accounts(USER_BLACKLIST));

    // 改前：alice 禁 HOST，bob 圈住 HOST
    expect(access.checkTarget({ host: HOST, user: USER })).toEqual({
      allowed: false,
      reason: "blacklist",
      source: "user",
    });
    expect(access.checkTarget({ host: HOST, user: "bob" })).toEqual({ allowed: true });

    // 只把 alice 换成「黑名单圈住 OTHER」（白名单留空）：HOST 放行、OTHER 禁
    writeUsers([
      { username: USER, password: "pw1", acl: { target: { blacklist: [OTHER] } } },
      { username: "bob", password: "pw2", acl: { target: { whitelist: [HOST] } } },
    ]);
    // 未越过节流：仍是上一份有效值（与账号表同一套节流语义）
    expect(access.checkTarget({ host: HOST, user: USER })).toEqual({
      allowed: false,
      reason: "blacklist",
      source: "user",
    });

    await sleep(1100);

    // 越过节流后新策略生效（编译缓存按策略快照身份失效，无需重启）
    expect(access.checkTarget({ host: HOST, user: USER })).toEqual({ allowed: true });
    expect(access.checkTarget({ host: OTHER, user: USER })).toEqual({
      allowed: false,
      reason: "blacklist",
      source: "user",
    });
    // 另一个用户完全不受这次改动的牵连（且 reason 不同 → 证明读的是它自己那份名单）
    expect(access.checkTarget({ host: HOST, user: "bob" })).toEqual({ allowed: true });
    expect(access.checkTarget({ host: OTHER, user: "bob" })).toEqual({
      allowed: false,
      reason: "whitelist",
      source: "user",
    });
  });

  it("坏内容不接管：users.json 改坏后沿用上一份有效策略（不放行一切）", async () => {
    writeLists(GLOBAL_ALLOW, accounts(USER_BLACKLIST));
    expect(access.checkTarget({ host: HOST, user: USER })).toEqual({
      allowed: false,
      reason: "blacklist",
      source: "user",
    });

    // 非法条目（带端口）→ 整份账号表非法，读侧保留上一份有效值
    writeUsers([{ username: USER, password: "pw1", acl: { target: { blacklist: ["ads.io:80"] } } }]);
    await sleep(1100);

    expect(readAuthUsers({ config: testConfig }).error).toBeTruthy();
    expect(access.checkTarget({ host: HOST, user: USER })).toEqual({
      allowed: false,
      reason: "blacklist",
      source: "user",
    });
  });
});

// ---------------------------------------------------------------------------
// 热路径：loadUserPolicy 零分配（同身份 toBe）
// ---------------------------------------------------------------------------

describe("判定层/个人名单热路径零分配", () => {
  it("同一用户连续两次查询返回同一对象身份（快照未变即复用已冻结结果）", () => {
    writeLists(GLOBAL_ALLOW, accounts(USER_BLACKLIST));

    const first = loadUserPolicy(USER, testConfig);
    const second = loadUserPolicy(USER, testConfig);

    expect(first).toBeDefined();
    // 核心断言：toBe（同身份）——若实现退回「每次深冻结一份」，这里立刻变红
    expect(second).toBe(first);
    // 复用不放松只读约束：那份对象仍是深度冻结的
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.target)).toBe(true);
    expect(Object.isFrozen(first?.target.whitelist)).toBe(true);
    // 不同用户各是各的（记忆表按用户名分槽，不串号）
    expect(loadUserPolicy("bob", testConfig)).not.toBe(first);
  });

  it("策略内容变化后身份随之改变（新快照不复用旧冻结结果）", async () => {
    writeLists(GLOBAL_ALLOW, accounts(USER_BLACKLIST));
    const before = loadUserPolicy(USER, testConfig);

    writeUsers([{ username: USER, password: "pw1", acl: USER_WHITELIST_MISS }]);
    await sleep(1100);

    const after = loadUserPolicy(USER, testConfig);
    expect(after).not.toBe(before);
    expect(after?.target.whitelist).toEqual([OTHER]);
  });
});

// ---------------------------------------------------------------------------
// 事件面：source 透传 + 判不出就不倒填
// ---------------------------------------------------------------------------

describe("事件面/access.target-denied 的 source", () => {
  const PROTOCOL = "http";
  let hub: EventHub;
  let ctx: CoreContext;
  let bridge: CoreEventBridge;
  let events: EventEnvelope<EventName>[];

  beforeEach(() => {
    hub = new EventHub({ onListenerError: () => undefined });
    ctx = { config: testConfig, logger: testLogger, events: hub };
    events = [];
    for (const name of ["access.target-denied"] as const) {
      hub.subscribe(name, (e) => {
        events.push(e as EventEnvelope<EventName>);
      });
    }
    bridge = new CoreEventBridge({ hub, protocol: PROTOCOL });
    bridge.attach(ctx);
  });

  afterEach(() => {
    bridge.subscription.dispose();
  });

  it("personal 拒绝的 source=user 原样透传（且 reason 仍是闭合集合那一档）", () => {
    hub.publish("pipe", {
      type: "target-denied",
      target: "target.test:80",
      host: "target.test",
      reason: "blacklist",
      source: "user",
      user: USER,
    } satisfies PipeEvent);

    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("access.target-denied");
    expect(events[0].data).toEqual({
      host: "target.test",
      target: "target.test:80",
      reason: "blacklist",
      source: "user",
    });
  });

  it("分层信息仍不许塞进 reason：内置引擎不产这种值，bridge 也原样透传不加工", () => {
    // ⚠️ 这条断言**方向变了**，必须说清楚为什么：
    // ⚠️ 别把这条改回「`reason: "user:blacklist"` 会被 bridge 静默丢弃（0 条）」——
    // 那时 `runtime/bridge.ts:aclReason` 认一张闭合集，表外值一律不发布。
    // 4B2 起访问控制端口放开，bridge 改为**原样透传**（`passthroughReason`）：
    // 静默丢事件比字段缺失更坏 —— 字段缺失至少还有一条已发布事件可查，整条不发布连
    // 「发生过一次拒绝」都没了，且没有任何报错。
    //
    // 于是「分层信息不许塞进 reason」这条纪律的**落点从消费者搬回生产者**：
    // ① 本文件上一组 describe 的源码级断言锁住生产者（`hostDenied` 只返回两个字面量、
    //    不出现拼接式 reason、写出的 `source:` 恰为 {global,user}）；
    // ② 下面这两条锁住消费者只做「缺失即跳过、绝不臆造」，对表外值**不加工**。
    // 换句话说：内置引擎做不到的事，由源码断言拦；外部引擎做的事，bridge 忠实转述。
    hub.publish("pipe", {
      type: "target-denied",
      target: "target.test:80",
      host: "target.test",
      reason: "user:blacklist",
    } as unknown as PipeEvent);
    hub.publish("pipe", {
      type: "target-denied",
      target: "target.test:80",
      host: "target.test",
      reason: "blacklist",
      source: "user",
    } satisfies PipeEvent);

    // 两条输入产出两条事件，reason **逐字原样**到达（bridge 不改写、不丢弃）
    expect(events).toHaveLength(2);
    expect(events[0].data).toMatchObject({ reason: "user:blacklist" });
    expect(events[0].data).not.toHaveProperty("source");
    expect(events[1].data).toMatchObject({ reason: "blacklist", source: "user" });
  });

  it("source 缺失就不写该键、绝不倒填成 global（宁可让订阅者知道「未知」）", () => {
    hub.publish("pipe", {
      type: "target-denied",
      target: "target.test:80",
      host: "target.test",
      reason: "blacklist",
    } satisfies PipeEvent);
    hub.publish("pipe", {
      type: "target-denied",
      target: "target.test:80",
      host: "target.test",
      reason: "blacklist",
      source: "geoip",
    } as unknown as PipeEvent);

    expect(events).toHaveLength(2);
    // 缺失 → 键不存在（**不是** `"global"`、也不是 `undefined` 占位）
    expect(events[0].data).not.toHaveProperty("source");
    // 表外来源原样透传，但同样绝不被改写成 global —— 运维去改错文件的代价太高
    expect(events[1].data).toMatchObject({ source: "geoip" });
    expect(events[1].data).not.toMatchObject({ source: "global" });
  });
});
