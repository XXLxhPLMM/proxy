/**
 * 跨层一致性护栏：条目语法只经 `addr` 层、读面零直接读取器、启动期 `fail-closed`、
 * `acl` 对凭证索引不可见 —— 四条都是**源码级**断言（读 `src/datasource/users/**` 的文本）。
 *
 * 四条判据各自的取舍与「防假绿」在 `./AGENTS.md`；判定层的运行时语义在 `core/access-control/` 那几档。
 *
 * @module tests/unit/config/auth-users
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  credentialIndexesFor,
  encodeBasicCredentials,
  matchBasicCredential,
  matchUidCredential,
} from "@/core/helpers/index.js";
import { readAuthUsersAsync, validateAuthUsers } from "@/datasource/users/index.js";
import { codeOf } from "../../../helpers/source-scan.js";
import { MIXED_ACCOUNTS } from "./_auth-users.js";

describe("datasource/users 跨层一致性护栏", () => {
  it("数据层的条目合法性必须经 addr 层：validate.ts 全文只有一处 parseHostRule、零 IP/正则解析", () => {
    const code = codeOf("datasource", "users", "validate.ts");
    expect(code).toContain("@/utils/addr/index.js");
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

  it("读面零直接读取器（读取点全在两个后端各一处），且 loadUserPolicy 复用 readAuthUsers", () => {
    const code = codeOf("datasource", "users", "read.ts");
    // 读取点在两个后端里（json / sqlite 各一个实现器），故判据是
    // 「read.ts 一处都没有 + 每个后端恰好一处」。锚的是**今天仍存在的形状**（函数调用 + 文件名）。
    expect(code, "read.ts 不许自己开读取器").not.toMatch(/readJsonCached\(|readCachedSource\(/);
    expect(
      (codeOf("datasource", "users", "json-source.ts").match(/readJsonCached\(/g) ?? []).length,
      "json 后端恰好一处",
    ).toBe(1);
    expect(
      (codeOf("datasource", "users", "sqlite-source.ts").match(/readCachedSource\s*[<(]/g) ?? [])
        .length,
      "sqlite 档一处",
    ).toBe(1);

    const body = code.slice(code.indexOf("export function loadUserPolicy("));
    expect(body).toContain("readAuthUsers(");
    expect(body).not.toMatch(/readJsonCached\(|readCachedSource\(/);
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
