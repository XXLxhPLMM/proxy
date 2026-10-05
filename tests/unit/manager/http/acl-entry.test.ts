/**
 * 名单条目的字符集：与数据层语法对齐，且**不与** username 那一份合并
 *
 * @description
 * 本档盯 `routes/input.ts` 里那份 `SAFE_ACL_ENTRY` 正则：数据层（`parseIpRule` / `parseHostRule`）
 * 接受的每一种形态它都表达得了、`syntaxHint` 承诺的例子它都收着、而穿越与控制字符它一个都不放过。
 * 判据**从源码现取**（不手抄第三份字符集）；跨层对齐与变异实测的解释见各 `it` 内的注释。
 * 共用 fixture 与主题级不变量见 `./_manager-http.ts` / `./AGENTS.md`。
 * @module tests/unit/manager/http
 */
import { describe, expect, it } from "vitest";
import type { AclConfig } from "@/datasource/acl/index.js";
import { OpsError } from "@/ops/index.js";
import { requireSafeAclEntry } from "@/manager/routes/input.js";
import { parseHostRule, parseIpRule } from "@/utils/addr/index.js";
import { blockAfter, codeOf } from "../../../helpers/source-scan.js";
import { EMPTY_ACL_DOC, call, port, writeAcl } from "./_manager-http.js";

/**
 * 数据层（`parseIpRule` / `parseHostRule`）接受的形态清单
 * @description
 * 逐条覆盖 `@/addr` 里每一个**字符级**来源：IPv4 / CIDR、IPv6 的 `::` 压缩与
 * 内嵌 v4 尾、方括号字面量、`%zone`、域名 / 通配域名 / FQDN 尾点 / 连字符标签 / 混合大小写。
 * 「数据层接受」这件事由 {@link DATA_LAYER_FORMS} 那条护栏自己复核（`accepted.length` 必须等于
 * 全长），所以这份清单不会因为数据层收窄而悄悄退化成空断言。
 */
const DATA_LAYER_FORMS = [
  "1.2.3.4",
  "10.0.0.0/8",
  "0.0.0.0/0",
  "255.255.255.255/32",
  "::1",
  "::",
  "2001:db8::/32",
  "2001:db8::1",
  "::ffff:1.2.3.4",
  "::ffff:7f00:1",
  "fe80::1%eth0",
  "[::1]",
  "[2001:db8::1]",
  "example.com",
  "*.cdn.io",
  "*.example.com",
  "EXAMPLE.COM",
  "example.com.",
  "a-b.c-d.example",
  "xn--fiqs8s.test",
  "1.example",
] as const;

/**
 * 从 `input.ts` **现取**那两条字符集（源码里的正则字面量）并编成 `RegExp`
 * @description
 * 护栏的作用对象必须是**交付出去的那份**字符集。测试自己抄一份 `new RegExp("[...]")` 等于把
 * 判据又复制了一遍——实现改了、测试没改，它照样绿。这里从源码字面量取，于是「变异那份源码」
 * 就等于「变异被测的那份判据」。
 */
function classFromSource(name: "SAFE_USERNAME" | "SAFE_ACL_ENTRY"): RegExp {
  const code = codeOf("manager", "routes", "input.ts");
  const at = code.indexOf(`const ${name} = /`);
  expect(at, `源码里找不到 ${name}`).toBeGreaterThanOrEqual(0);
  const literal = code.slice(at + `const ${name} = `.length, code.indexOf(";", at));
  expect(literal.startsWith("/") && literal.endsWith("/"), `${name} 已经不是正则字面量了`).toBe(true);
  return new RegExp(literal.slice(1, -1));
}

/**
 * `@/ops/acl.ts:syntaxHint` 在错误信息里举的**每个例子**（从源码现取，不手抄）
 * @description
 * `syntaxHint` 是 ops 层对操作者的**承诺**（「正确写法长成这样」）。它举的形态如果 HTTP 层
 * 表达不了，那条承诺就是假的——于是本组从那份源码里把例子抠出来逐条验，而不是维护第三份
 * 清单（第三份必然腐烂）。抠不出来（`examples` 为空）时断言显式失败，防空转。
 */
function syntaxHintExamples(): string[] {
  const branch = blockAfter(codeOf("ops", "acl.ts"), "function syntaxHint(");
  const out: string[] = [];
  for (const m of branch.matchAll(/（如 ([^）]*)）/g)) {
    for (const item of (m[1] ?? "").split("、")) {
      out.push(item.trim());
    }
  }
  return out;
}

describe("名单条目字符集：对齐数据层语法，且不与 username 合并", () => {
  it("CIDR / 通配域名 / IPv6 都过，且**删得掉**（`changed:true`）", async () => {
    const cases: Array<[string, string, string]> = [
      ["clientip", "whitelist", "10.0.0.0/8"],
      ["clientip", "blacklist", "2001:db8::/32"],
      ["target", "whitelist", "*.cdn.io"],
      ["target", "blacklist", "example.com"],
    ];
    for (const [group, list, entry] of cases) {
      const added = await call(port, { method: "POST", path: "/api/acl", body: { group, list, entry } });
      expect(added.status, `POST ${entry} 必须 200：${added.raw}`).toBe(200);
      expect((added.json as { changed: boolean }).changed).toBe(true);

      const read = await call(port, { path: "/api/acl" });
      const acl = (read.json as { acl: AclConfig }).acl;
      const key = group === "clientip" ? "clientIp" : group;
      expect(acl[key as keyof AclConfig][list as "whitelist"], `GET 必须读回 ${entry}`).toEqual([entry]);

      // 这一步是本组存在的理由：以前 CIDR 同样进得来、却**永远删不掉**
      const removed = await call(port, {
        method: "DELETE",
        path: `/api/acl?group=${group}&list=${list}&entry=${encodeURIComponent(entry)}`,
      });
      expect(removed.status, `DELETE ${entry} 必须 200`).toBe(200);
      expect((removed.json as { changed: boolean }).changed, `DELETE ${entry} 必须真的删掉`).toBe(true);
    }
  });

  it("手改进 acl.json 的 CIDR 也能经 HTTP 删掉（读得到 ⇒ 删得掉）", async () => {
    // 直接落盘一个「传输层曾经表达不了」的合法条目 —— 运维改文件后不必再改第二次
    writeAcl({
      ...structuredClone(EMPTY_ACL_DOC),
      clientIp: { whitelist: ["10.0.0.0/8"], blacklist: [] },
    });
    const removed = await call(port, {
      method: "DELETE",
      path: "/api/acl",
      body: { group: "clientip", list: "whitelist", entry: "10.0.0.0/8" },
    });
    expect(removed.status).toBe(200);
    expect((removed.json as { changed: boolean }).changed).toBe(true);
    const read = await call(port, { path: "/api/acl" });
    expect(((read.json as { acl: AclConfig }).acl).clientIp.whitelist).toEqual([]);
  });

  it("穿越与控制字符仍被拒（放开 `/` 之后**没有**顺手放开这些）", async () => {
    const bad = [
      "../../x",
      "../x",
      "x/../y",
      "..",
      "/10.0.0.0/8",
      "10.0.0.0/8/",
      "a\u0000b",
      "a\nb",
      "a\tb",
      "10.0.0.0 /8",
      "a\\b",
      'a"b',
      "a_b",
      "",
      "a".repeat(256),
    ];
    for (const entry of bad) {
      expect(() => requireSafeAclEntry(entry), `${JSON.stringify(entry)} 必须被拒`).toThrow(OpsError);
    }
    for (const entry of ["../../etc/passwd", ".."]) {
      const reply = await call(port, {
        method: "POST",
        path: "/api/acl",
        body: { group: "clientip", list: "whitelist", entry },
      });
      expect(reply.status, `POST ${JSON.stringify(entry)} 必须是 400`).toBe(400);
    }
  });

  it("**username 仍然拒绝 `/`（两份判据不许合并成一个）**", async () => {
    const user = classFromSource("SAFE_USERNAME");
    const entry = classFromSource("SAFE_ACL_ENTRY");
    expect(user.source, "两个判据合并了").not.toBe(entry.source);
    // 差异方向必须是「条目那份更宽、username 那份更窄」，逐字符点出来
    for (const ch of ["/", ":", "*", "[", "]", "%"]) {
      expect(user.test(`a${ch}b`), `username 字符集必须拒 ${ch}`).toBe(false);
      expect(entry.test(`a${ch}b`), `名单字符集应当收 ${ch}`).toBe(true);
    }
    for (const ch of [".", "-", "_", "0", "A"]) {
      expect(user.test(`a${ch}b`), `username 字符集必须收 ${ch}`).toBe(true);
    }
    // 线上观测：同一个 `/`，username 400、acl entry 200
    expect(
      (await call(port, { method: "POST", path: "/api/users", body: { username: "a/b", password: "pw" } }))
        .status,
    ).toBe(400);
    expect(
      (await call(port, {
        method: "POST",
        path: "/api/acl",
        body: { group: "clientip", list: "whitelist", entry: "10.0.0.0/8" },
      })).status,
    ).toBe(200);
  });

  it("**跨层对齐 ①**：数据层接受的每一种形态，HTTP 层字符集都表达得了", () => {
    const cls = classFromSource("SAFE_ACL_ENTRY");
    const accepted = DATA_LAYER_FORMS.filter(
      (e) => parseIpRule(e) !== undefined || parseHostRule(e) !== undefined,
    );
    // 防假绿：样本若已不被数据层接受，本组会退化成「断言了一个空集合」
    expect(accepted.length, "DATA_LAYER_FORMS 与数据层语法漂了").toBe(DATA_LAYER_FORMS.length);
    for (const e of accepted) {
      expect(cls.test(e), `数据层接受 ${JSON.stringify(e)}，HTTP 字符集却表达不了`).toBe(true);
      expect(() => requireSafeAclEntry(e), `requireSafeAclEntry 拒了 ${JSON.stringify(e)}`).not.toThrow();
    }
  });

  it("**跨层对齐 ②**：ops 的 `syntaxHint` 举的每个例子，数据层认、HTTP 层也认", () => {
    const examples = syntaxHintExamples();
    expect(examples.length, "从 syntaxHint 抠不出例子：护栏空转").toBeGreaterThan(0);
    expect(examples).toContain("10.0.0.0/8");
    for (const e of examples) {
      expect(parseIpRule(e) ?? parseHostRule(e), `${e} 必须被数据层接受`).toBeDefined();
      expect(() => requireSafeAclEntry(e), `syntaxHint 承诺了 ${e}，HTTP 层却表达不了`).not.toThrow();
    }
  });

  it("**变异实测 ⑤**：从名单字符集里去掉 `/` ⇒ 跨层对齐 ①② 必须红", () => {
    // 判据从源码现取，故这个变异作用在**交付出去的那份**字符集上
    const shipped = classFromSource("SAFE_ACL_ENTRY");
    const mutated = new RegExp(shipped.source.replace("/", ""));
    // 变异只摘掉 `/` 这一个字符：其余能力必须还在（否则「红」是因为别的原因，不算实测）
    expect(mutated.test("example.com")).toBe(true);
    expect(mutated.test("::1")).toBe(true);
    expect(mutated.test("fe80::1%eth0")).toBe(true);
    // 依赖 `/` 的规范形态逐条表达不了 —— 跨层对齐 ① 会在这里红
    const needsSlash = DATA_LAYER_FORMS.filter((e) => e.includes("/"));
    expect(needsSlash.length, "样本里没有依赖 `/` 的形态：这条护栏会空转").toBeGreaterThan(0);
    for (const e of needsSlash) {
      expect(shipped.test(e), `${e} 必须被现行字符集收`).toBe(true);
      expect(mutated.test(e), `变异后 ${JSON.stringify(e)} 应表达不了`).toBe(false);
    }
    // `syntaxHint` 举的那两个例子：跨层对齐 ② 会在这里红
    for (const e of syntaxHintExamples()) {
      expect(shipped.test(e), `syntaxHint 承诺了 ${e}，现行字符集必须收`).toBe(true);
      if (e.includes("/")) {
        expect(mutated.test(e), `变异后 ${e} 应表达不了`).toBe(false);
      }
    }
  });
});
