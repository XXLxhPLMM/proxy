import { describe, expect, it } from "vitest";
import {
  OpsError,
  addAclEntry,
  applyPatch,
  inertNoticeFor,
  readAcl,
  removeAclEntry,
  resolveOpsSources,
  type OpsSources,
} from "@/ops/index.js";
import type { AclConfig, AclSource } from "@/datasource/acl/index.js";
import { ACCOUNT, ACCOUNT_DOC, dir, ops, writeUsers } from "./_ops.js";

/**
 * `ops` 写面（幂等 no-op、字段保全、判据只有一份）
 *
 * @description
 * 本档管两件事：**幂等 no-op 要断言底层 `write` 没被调**（不是断言返回值是 `false`），
 * 以及**判据只有一份 / 未指定字段逐字保留**。
 * 为什么幂等那组用替身 `AclSource` 而不是真文件，见 `./AGENTS.md`；
 * 读面与失败分类在 `./read.test.ts`，层边界在 `./source-guards.test.ts`。
 */

/** 一个**记账数**的名单数据源替身：`read` 永远给同一份，写面每被调一次计数 +1 */
function countingAcl(initial: AclConfig): { acl: AclSource; writes: number } {
  let next = initial;
  const box = { acl: undefined as unknown as AclSource, writes: 0 };
  box.acl = {
    driver: "counting",
    locator: () => "/nowhere/acl.json",
    read: () => ({ value: next, path: "/nowhere/acl.json", exists: true }),
    readStartup: async () => ({ value: next, path: "/nowhere/acl.json", exists: true }),
    write: (value) => {
      box.writes += 1;
      next = value;
    },
  };
  return box;
}

describe("ops 名单写：幂等 no-op 如实返回 changed:false，且绝不重写", () => {
  const base: AclConfig = {
    clientIp: { whitelist: ["10.0.0.0/8"], blacklist: [] },
    target: { whitelist: [], blacklist: ["evil.com"] },
    upstream: { whitelist: [], blacklist: [] },
  };

  it("重复 add → changed:false，且 write **一次都没被调**", async () => {
    const spy = countingAcl(base);
    const sources = { ...(await ops()), acl: spy.acl };

    const first = addAclEntry(sources, "clientip", "whitelist", "192.168.0.0/16");
    expect(first.changed).toBe(true);
    expect(spy.writes).toBe(1);

    const again = addAclEntry(sources, "clientip", "whitelist", "192.168.0.0/16");
    expect(again.changed).toBe(false);
    expect(again.message).toContain("没动");
    // ⚠️ **牙齿在这里**：不是「返回值是 false」，而是「底层写面**没被调用**」。内容逐字相同地
    // 重写一遍，文件上根本看不出来 —— 而那正是「幂等」这个词最容易变成假绿的地方。
    expect(spy.writes, "第二次调用必须连 write 都不碰").toBe(1);
  });

  it("移出本来就没有的 → changed:false，且 write 一次都没被调", async () => {
    const spy = countingAcl(base);
    const sources = { ...(await ops()), acl: spy.acl };

    const miss = removeAclEntry(sources, "upstream", "blacklist", "never.example.com");
    expect(miss.changed).toBe(false);
    expect(miss.message).toContain("没动");
    expect(spy.writes).toBe(0);
  });

  it("真的移出 → changed:true，且只动那一个格子", async () => {
    const spy = countingAcl(base);
    const sources = { ...(await ops()), acl: spy.acl };

    const gone = removeAclEntry(sources, "target", "blacklist", "evil.com");
    expect(gone.changed).toBe(true);
    expect(spy.writes).toBe(1);
    const after = readAcl(sources);
    expect(after.target.blacklist).toEqual([]);
    expect(after.clientIp.whitelist, "别的格子逐字不动").toEqual(["10.0.0.0/8"]);
  });
});

describe("ops 账号写：判据只有一份，未指定字段逐字保留", () => {
  it("applyPatch 是纯函数且只动 patch 里出现的字段", () => {
    const next = applyPatch(ACCOUNT, { disabled: true });
    expect(next.disabled).toBe(true);
    expect(next.quota).toEqual(ACCOUNT.quota);
    expect(next.expiresAt).toBe(ACCOUNT.expiresAt);
    expect(next.acl).toEqual(ACCOUNT.acl);
    // 原对象逐字不动（纯函数，不是就地改）
    expect(ACCOUNT.disabled).toBe(false);
  });

  it("`--expires` 的时刻形态由数据源层那个唯一的归一判定（ops 不自己 Date.parse）", () => {
    // `Date.parse("2027-01-01")` 返回一个**有限值**（UTC 午夜），`Date.parse("2027-01-01 00:00")`
    // 返回**本地**午夜 —— 同一份配置在 UTC 机器与 +08:00 机器上差 8 小时，而运维写它时心里想的
    // 一定是本地零点。ops 若自己 Date.parse 判，就成了「这一层认得、代理不认得」的那一档。
    expect(() => applyPatch(ACCOUNT, { expiresAt: "2027-01-01" })).toThrow(OpsError);
    expect(() => applyPatch(ACCOUNT, { expiresAt: "2027-02-30T00:00:00Z" })).toThrow(
      OpsError,
    );
    const ok = applyPatch(ACCOUNT, { expiresAt: "2027-03-01T12:00:00+08:00" });
    expect(typeof ok.expiresAt).toBe("number");
  });

  it("jwt 模式下提醒、非 jwt 不提醒（提醒是纯查询，不改数据）", async () => {
    writeUsers([{ ...ACCOUNT_DOC, disabled: true }]);
    const at = (authType: string): Promise<OpsSources> =>
      resolveOpsSources({ NODE_ENV: "development", AUTH_TYPE: authType }, dir);
    expect(inertNoticeFor(await at("basic"))).toBeUndefined();
    expect(inertNoticeFor(await at("jwt"))).toContain("不会生效");
  });
});