/**
 * `hasConfiguredAcl`（`acl-inert` 启动期告警的判据）的真值表与实现纪律。
 *
 * @description
 * 三档硬约定：① 三组名单任一非空即 true；② 读失败 → false（**刻意取舍**，且必须另有可见
 * 信号）；③ 复用既有读取路径（零新增 `readJsonCached` 调用点）。⚠️ 每例一份**独立路径** ——
 * `readJsonCached` 的 1s 节流缓存是模块级、键 `label + path`。「为什么值得一档独立护栏」
 * （假阴性/假阳性两个方向）与主题级不变量见同目录 `AGENTS.md`。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasConfiguredAcl, type AclLocator } from "@/datasource/acl/index.js";
import type { JsonFileEvent } from "@/utils/json-file/index.js";
import { testConfig } from "../../../helpers/config.js";
import { sleep } from "../../../helpers/net.js";
import { codeOf, sourceOf } from "../../../helpers/source-scan.js";

/** 私有接线：只让名单位置指向本例的文件，驱动名取测试实例的缺省。 */
function locatorFor(aclFile: string): AclLocator {
  return Object.freeze({
    driver: () => testConfig.get("aclDriver"),
    path: () => aclFile,
  });
}

let dir = "";
/** 每档一个**独立路径**：绕开 `readJsonCached` 的 1s 节流缓存（模块级，键 `label + path`） */
let seq = 0;
function freshPath(tag: string): string {
  seq += 1;
  return path.join(dir, `${tag}-${seq}.json`);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "acl-configured-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不应遮蔽用例结论（与仓内其它临时目录用例同纪律）
  }
});

describe("hasConfiguredAcl：三组名单任一非空即 true", () => {
  /** 写一份名单并读一次（每档独立路径，绕开 1s 节流） */
  function check(name: string, body: unknown): boolean {
    const p = freshPath(name);
    fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
    return hasConfiguredAcl(locatorFor(p));
  }

  it("整份缺失 → false", () => {
    expect(hasConfiguredAcl(locatorFor(path.join(dir, "no-such-acl.json")))).toBe(false);
  });

  it("整份是空对象 `{}` → false（文件在，但三组都没配）", () => {
    expect(check("empty-object", {})).toBe(false);
  });

  it("三组都在、六个名单全空 → false（判据看的是「非空」不是「键在不在」）", () => {
    expect(
      check("all-empty", {
        clientIp: { whitelist: [], blacklist: [] },
        target: { whitelist: [], blacklist: [] },
        upstream: { whitelist: [], blacklist: [] },
      }),
    ).toBe(false);
  });

  it("只出现键、不给名单内容（`{}` 组）→ false", () => {
    expect(check("bare-groups", { clientIp: {}, target: {}, upstream: {} })).toBe(false);
  });

  it("`clientIp` 非空 → true（且只有一个组非空）", () => {
    expect(
      check("clientip", {
        clientIp: { blacklist: ["203.0.113.9"] },
        target: {},
        upstream: {},
      }),
    ).toBe(true);
  });

  it("`target` 非空 → true（与 clientIp 互不影响）", () => {
    expect(
      check("target", {
        clientIp: {},
        target: { whitelist: ["*.example.com"] },
        upstream: {},
      }),
    ).toBe(true);
  });

  it("`upstream` 非空 → true（**client 模式的路由名单也算「配了访问控制」**)", () => {
    // `upstream` 组的动作与其余两组相反（命中 = 回落直连，不交上游），但它**同样是 acl.json
    // 里的名单**，同样会因 `access` 被覆盖而不生效。故判据必须把它算进来 —— 否则
    // 「只配了路由名单」的部署收不到告警，而那正是 `acl-inert` 文案里点名的那一类失效。
    expect(
      check("upstream", {
        clientIp: {},
        target: {},
        upstream: { blacklist: ["intranet.example.com"] },
      }),
    ).toBe(true);
  });

  it("名单只有空串/空白 → 校验层已 trim 掉，判据仍是 false（不重复校验语义）", () => {
    // `validateAcl` 拒掉空串条目（整组非法 → 走 fallback 空 ACL），故这里恒 false。
    // 断言它 false 是在说「判据读的是**校验后的**名单，不是原始 JSON 文本」。
    expect(check("blank-entries", { target: { blacklist: ["   "] } })).toBe(false);
  });
});

describe("hasConfiguredAcl：读失败的取舍 —— false，但必须另有可见信号", () => {
  it("stat 权限错误（EACCES）且无历史 → false，**同时**报一条 `error` 事件", () => {
    const p = freshPath("eacces");
    fs.writeFileSync(p, JSON.stringify({ target: { blacklist: ["203.0.113.9"] } }));
    const events: JsonFileEvent[] = [];
    // `probeFile` 走 `fs.statSync` 属性访问（正是为了让这层可 spy）——与
    // `tests/unit/utils/json-file/read.test.ts` 同一手法，且**跨平台**（`chmod` 在 Windows 上
    // 只切只读属性、造不出稳定的 EACCES，本仓已因同一原因踩过一次）。
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    let verdict: boolean | undefined;
    try {
      verdict = hasConfiguredAcl(locatorFor(p), (e) => events.push(e));
    } finally {
      statSpy.mockRestore();
    }

    // ① 判据：读不到名单时**不报**（宁可少告警也不误报）
    expect(verdict).toBe(false);
    // ② ⚠️ **但必须有别的可见信号**，否则「false」就等于静默：
    //    运维在 `config.file-error` / CLI 日志上仍能看到「名单文件读不了」。
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(events.some((e) => e.type === "missing")).toBe(false);
  });

  it("坏 JSON（且有历史）→ 保留上一份有效值 ⇒ 判据仍为 true", () => {
    // 「保留上一份有效值」是 `readJsonCached` 的既有语义；判据只是**读它**，
    // 所以这一档证明「读坏内容不会被判成『没配』」（否则会把「配了但坏了」误报成没配）。
    const p = freshPath("bad-json");
    fs.writeFileSync(p, JSON.stringify({ target: { blacklist: ["203.0.113.9"] } }));
    const events: JsonFileEvent[] = [];
    expect(hasConfiguredAcl(locatorFor(p), (e) => events.push(e))).toBe(true);

    // 越过 1s 节流后写坏内容（读不到新内容 → 保留上一份有效值）
    fs.writeFileSync(p, "{ this is not json");
    return sleep(1100).then(() => {
      const after: JsonFileEvent[] = [];
      expect(hasConfiguredAcl(locatorFor(p), (e) => after.push(e))).toBe(true);
      expect(after.filter((e) => e.type === "error")).toHaveLength(1);
    });
  });
});

describe("源码级：`hasConfiguredAcl` 走既有读取路径", () => {
  it("`json-source.ts` 全文 `readJsonCached` 恰好一处（在 `read` 里），`hasConfiguredAcl` 只经 `loadAcl`", () => {
    // ⚠️ 这条判据**今天仍有牙齿**：`readJsonCached` 在 `JsonAclSource.read` 里**存在**，
    // 另开一个调用点会让「恰好一处」变两处。若哪天 `read` 整体被重构掉，
    // 本条会以「0 处」变红，提示把锚点改到新形状（而不是变成恒真的空断言）。
    const code = codeOf("datasource", "acl", "json-source.ts");
    const occurrences = code.split("readJsonCached(").length - 1;
    expect(occurrences, "json-source.ts 全文 readJsonCached 调用点（含声明行）").toBe(1);
    expect(sourceOf(path.join("datasource", "acl", "json-source.ts"))).toContain(
      "readJsonCached(options.path ?? this.resolveLocator(), validateAcl",
    );

    // 判据本体只调 `loadAcl`（那份带 1s 节流与坏内容保留的实现），不自己读盘
    const registry = codeOf("datasource", "acl", "registry.ts");
    const body = registry.slice(registry.indexOf("export function hasConfiguredAcl"));
    expect(body).toContain("loadAcl(locator, onFileEvent)");
    expect(body).not.toContain("readJsonCached");
    expect(body).not.toContain("fs.");
  });
});
