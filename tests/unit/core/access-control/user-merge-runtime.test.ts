/**
 * 个人名单那条链在**运行时**的三件事：不越界、热加载生效、策略快照零分配
 *
 * 这三档共用「改一份 `users.json`」这个动作，但锁的是三条不同的不变式：个人名单绝不
 * 参与 `checkClient` / `checkRoute`（行为面 + 源码面两面）、越过 1s 节流后不重启即生效、
 * 以及 `loadUserPolicy` 在快照未变时返回**同一对象身份**。合流语义本身（3×3 穷举
 * 真值表）在 `user-merge-matrix.test.ts`，事件面在 `user-merge-event.test.ts`。
 *
 * @module tests/unit/core/access-control/user-merge-runtime
 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadUserPolicy, readAuthUsers } from "@/datasource/users/index.js";
import type { AccessControl } from "@/core/types/proxy.js";
import { blockAfter, codeOf } from "../../../helpers/source-scan.js";
import { restoreConfig, silenceLogs, snapshotConfig, testConfig } from "../../../helpers/config.js";
import { sleep } from "../../../helpers/net.js";
import {
  GLOBAL_ALLOW,
  HOST,
  MERGE_KEYS,
  OTHER,
  USER,
  USER_BLACKLIST,
  USER_WHITELIST_MISS,
  acc,
  accounts,
  cleanupMergeDirs,
  newAccess,
  writeLists,
} from "./_user-acl-merge.js";

/**
 * 只改写 users.json（acl.json 不动），并把 mtime 顶到未来以确保「内容已变」是确定的
 * @description `clock` 只服务这一处「让 mtime 确定地前进」，故刻意不外提共用面
 * （只被本档用到）。
 */
let clock = 0;

function writeUsers(users: unknown): void {
  const usersPath = testConfig.get("authUsersFile");
  clock += 1000;
  fs.writeFileSync(usersPath, JSON.stringify(users));
  fs.utimesSync(usersPath, clock / 1000, clock / 1000);
}

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

    // 锚点是 `function checkClient(` / `function checkRoute(`：判定面收成
    // `createFileAccessControl` 端口后，三个判定降为**模块私有函数**（不再导出，调用方拿不到
    // 裸判定函数）。锚点必须跟着走，但断言的**不变量一字未变**：
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

    expect(readAuthUsers({ locator: acc() }).error).toBeTruthy();
    expect(access.checkTarget({ host: HOST, user: USER })).toEqual({
      allowed: false,
      reason: "blacklist",
      source: "user",
    });
  });
});

describe("判定层/个人名单热路径零分配", () => {
  it("同一用户连续两次查询返回同一对象身份（快照未变即复用已冻结结果）", () => {
    writeLists(GLOBAL_ALLOW, accounts(USER_BLACKLIST));

    const first = loadUserPolicy(USER, acc());
    const second = loadUserPolicy(USER, acc());

    expect(first).toBeDefined();
    // 核心断言：toBe（同身份）——若实现退回「每次深冻结一份」，这里立刻变红
    expect(second).toBe(first);
    // 复用不放松只读约束：那份对象仍是深度冻结的
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.target)).toBe(true);
    expect(Object.isFrozen(first?.target.whitelist)).toBe(true);
    // 不同用户各是各的（记忆表按用户名分槽，不串号）
    expect(loadUserPolicy("bob", acc())).not.toBe(first);
  });

  it("策略内容变化后身份随之改变（新快照不复用旧冻结结果）", async () => {
    writeLists(GLOBAL_ALLOW, accounts(USER_BLACKLIST));
    const before = loadUserPolicy(USER, acc());

    writeUsers([{ username: USER, password: "pw1", acl: USER_WHITELIST_MISS }]);
    await sleep(1100);

    const after = loadUserPolicy(USER, acc());
    expect(after).not.toBe(before);
    expect(after?.target.whitelist).toEqual([OTHER]);
  });
});