/**
 * `hasConfiguredAcl`（`acl-inert` 启动期告警的判据）的真值表与实现纪律。
 *
 * @description
 * **它为什么值得一档独立护栏**：它是「**调用方注入了自定义 `access` → `acl.json` 不会生效**」
 * 这条启动期告警的**唯一**判据。判据错了有**两个方向**的错误，后果都很难查：
 * - **假阴性**（配了名单说没配）→ 该响的告警不响，「我配了名单怎么没生效」继续无解；
 * - **假阳性**（没配说配了）→ 告警变成常态噪音，运维学会忽略它，**比没有这条告警更坏**。
 *
 * 三档硬约定，本档逐条钉住：
 * 1. **三组名单任一非空即 true**（`clientIp` / `target` / `upstream` 各算一次，全空与
 *    整份缺失都算 false）；
 * 2. **读失败 → false**（**刻意取舍，不是遗漏**：宁可少告警也不误报。此时**另有**可见信号
 *    ——`readJsonCached` 经 `onEvent` 报 `error` → runtime 发 `config.file-error` → CLI 落日志。
 *    本档**同时断言那条信号确实响了**，否则「读失败静默 false」就是货真价实的假阴性）；
 * 3. **复用既有读取路径**（`loadAcl` → `readJsonCached`）——另开一个调用点会造成两份节流缓存、
 *    两份解析、两套坏文件处理并互相污染同一缓存键（`config/AGENTS.md` 有记载 + 变异测试）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasConfiguredAcl, type ConfigAccessor } from "@/config/index.js";
import type { JsonFileEvent } from "@/utils/json-file/index.js";
import { codeOf, sourceOf } from "../helpers/source-scan.js";
import { testConfig as base } from "../helpers/config.js";
import { sleep } from "../helpers/net.js";

/** 私有 accessor：只让 `aclFile` 指向本例的文件，其余键取测试实例的缺省。 */
function accessorFor(aclFile: string): ConfigAccessor {
  return Object.freeze({
    get: ((key: string) =>
      key === "aclFile" ? aclFile : (base.get as (k: string) => unknown)(key)) as ConfigAccessor["get"],
  });
}

let dir = "";
/** 每档一个**独立路径**：`readJsonCached` 的 1s 节流缓存是模块级、键为 `label + path`，
 *  同路径连写两档会互相污染（这正是本档要证明「只有一份读取路径」时必须绕开的机制）。 */
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

// ---------------------------------------------------------------------------
// 1. 真值表：三组名单任一非空即 true
// ---------------------------------------------------------------------------

describe("hasConfiguredAcl：三组名单任一非空即 true", () => {
  /** 写一份名单并读一次（每档独立路径，绕开 1s 节流） */
  function check(name: string, body: unknown): boolean {
    const p = freshPath(name);
    fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
    return hasConfiguredAcl(accessorFor(p));
  }

  it("整份缺失 → false", () => {
    expect(hasConfiguredAcl(accessorFor(path.join(dir, "no-such-acl.json")))).toBe(false);
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

// ---------------------------------------------------------------------------
// 2. 读失败 → false，**且另有可见信号**（否则就是货真价实的假阴性）
// ---------------------------------------------------------------------------

describe("hasConfiguredAcl：读失败的取舍 —— false，但必须另有可见信号", () => {
  it("stat 权限错误（EACCES）且无历史 → false，**同时**报一条 `error` 事件", () => {
    const p = freshPath("eacces");
    fs.writeFileSync(p, JSON.stringify({ target: { blacklist: ["203.0.113.9"] } }));
    const events: JsonFileEvent[] = [];
    // `probeFile` 走 `fs.statSync` 属性访问（正是为了让这层可 spy）——与
    // `tests/unit/json-file.test.ts` 同一手法，且**跨平台**（`chmod` 在 Windows 上
    // 只切只读属性、造不出稳定的 EACCES，本仓已因同一原因踩过一次）。
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    let verdict: boolean | undefined;
    try {
      verdict = hasConfiguredAcl(accessorFor(p), (e) => events.push(e));
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
    expect(hasConfiguredAcl(accessorFor(p), (e) => events.push(e))).toBe(true);

    // 越过 1s 节流后写坏内容（读不到新内容 → 保留上一份有效值）
    fs.writeFileSync(p, "{ this is not json");
    return sleep(1100).then(() => {
      const after: JsonFileEvent[] = [];
      expect(hasConfiguredAcl(accessorFor(p), (e) => after.push(e))).toBe(true);
      expect(after.filter((e) => e.type === "error")).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. 实现纪律：复用既有读取路径（零新增 `readJsonCached` 调用点）
// ---------------------------------------------------------------------------

describe("源码级：`hasConfiguredAcl` 走既有读取路径", () => {
  it("`acl.ts` 全文 `readJsonCached` 恰好一处（在 `readAcl` 里），`hasConfiguredAcl` 只经 `loadAcl`", () => {
    // ⚠️ 这条判据**今天仍有牙齿**：`readJsonCached` 在 `readAcl` 里**存在**，
    // 另开一个调用点会让「恰好一处」变两处。若哪天 `readAcl` 整体被重构掉，
    // 本条会以「0 处」变红，提示把锚点改到新形状（而不是变成恒真的空断言）。
    const code = codeOf("config", "files", "acl.ts");
    const occurrences = code.split("readJsonCached(").length - 1;
    expect(occurrences, "acl.ts 全文 readJsonCached 调用点（含声明行）").toBe(1);
    expect(sourceOf(path.join("config", "files", "acl.ts"))).toContain("readJsonCached(filePath, validateAcl");

    // 判据本体只调 `loadAcl`（那份带 1s 节流与坏内容保留的实现），不自己读盘
    const body = code.slice(code.indexOf("export function hasConfiguredAcl"));
    expect(body).toContain("loadAcl(config, onFileEvent)");
    expect(body).not.toContain("readJsonCached");
    expect(body).not.toContain("fs.");
  });
});
