/**
 * 名单驱动注册表原语 + `aclSourceFor` 的记忆边界 + 「形状校验只有一份」——三件与
 * `ACL_DRIVER` 装配点**无关**的判据（那两档在 `driver-wiring.test.ts`）。
 *
 * @description
 * 记忆表只记「哪个驱动」绝不记「哪份数据」；而「一份判据」的牙齿是**不许有本地定义**而不是
 * 计数（三个使用点全都在调用同一个函数，用「全文恰好一次」当判据只会逼人为了对上而改数）。
 * 三次变异实测与判据形状见同目录 `AGENTS.md`。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "@/config/index.js";
import {
  aclSourceFor,
  hasAclSourceDriver,
  listAclSourceDrivers,
  registerAclSource,
  resolveAclSource,
  validateAcl,
  type AclLocator,
} from "@/datasource/acl/index.js";
import { blockAfter, codeOnly, codeOf, sourceOf } from "../../../helpers/source-scan.js";
import { CUSTOM, fakeSource, newProbe, register, storeWith } from "./_acl-driver.js";

let dir = "";

/** 由同一份 store 手搓一条接线（数据源层吃它；**不经 `aclLocatorFor`**，理由见 `AGENTS.md`） */
function locatorOf(store: ConfigStore): AclLocator {
  return Object.freeze({
    driver: () => store.get("aclDriver"),
    path: () => store.get("aclFile"),
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "acl-driver-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("名单驱动注册表", () => {
  it("内置 `json` 恒在已注册列表里（构造时写入，不靠谁被 import 到）", () => {
    expect(listAclSourceDrivers()).toContain("json");
    expect(hasAclSourceDriver("json")).toBe(true);
  });

  it("注册后可列出、退订后消失；退订幂等", () => {
    const off = register(newProbe());
    expect(listAclSourceDrivers()).toContain(CUSTOM);
    expect(hasAclSourceDriver(CUSTOM)).toBe(true);
    off();
    off();
    expect(hasAclSourceDriver(CUSTOM)).toBe(false);
  });

  it("重名且未给 override 抛错（不静默替换）", () => {
    const probe = newProbe();
    const off = register(probe);
    try {
      expect(() => registerAclSource(CUSTOM, () => fakeSource(probe))).toThrow(/已注册/);
    } finally {
      off();
    }
  });

  it("覆盖之后，先前那个注册方的退订不删当前值（退订只删自己写的那一项）", () => {
    const probe = newProbe();
    const offFirst = register(probe);
    const offSecond = registerAclSource(CUSTOM, () => fakeSource(probe), { override: true });
    offFirst();
    expect(hasAclSourceDriver(CUSTOM)).toBe(true);
    offSecond();
    expect(hasAclSourceDriver(CUSTOM)).toBe(false);
  });

  it("未注册驱动 resolve 抛错并列出全部已注册项", () => {
    expect(() => resolveAclSource("nope")).toThrow(/json/);
  });
});

describe("aclSourceFor 的记忆边界", () => {
  it("同一条接线恒返回同一个实现器（下游的节流缓存与编译缓存才命中）", () => {
    const locator = locatorOf(storeWith({ aclDriver: "json" }));
    expect(aclSourceFor(locator)).toBe(aclSourceFor(locator));
  });

  it("换驱动拿到另一个实现器（记忆按 `(接线, 驱动名)` 分槽）", () => {
    const probe = newProbe();
    const off = register(probe);
    try {
      const store = storeWith({ aclDriver: "json" });
      const locator = locatorOf(store);
      const json = aclSourceFor(locator);
      store.set("aclDriver", CUSTOM);
      expect(aclSourceFor(locator)).not.toBe(json);
      expect(probe.factoryCalls).toBe(1);
    } finally {
      off();
    }
  });

  it("实现器每次现取位置，故热改名单路径在下一次读即生效（位置不记忆）", () => {
    const first = path.join(dir, "one.json");
    const second = path.join(dir, "two.json");
    fs.writeFileSync(first, "{}");
    fs.writeFileSync(second, "{}");
    const store = storeWith({ aclDriver: "json", aclFile: first });
    const locator = locatorOf(store);
    const source = aclSourceFor(locator);
    expect(source.locator()).toBe(first);
    store.set("aclFile", second);
    // 同一个实例、位置变了：记忆里只有「哪个驱动」，路径永远是现取的
    expect(aclSourceFor(locator)).toBe(source);
    expect(source.locator()).toBe(second);
  });
});

describe("形状校验只有一份，与驱动无关", () => {
  it("实现器**只调用**那一个 validateAcl，从不自己实现一份", () => {
    // 判据是「实现器里**没有第二份实现**」，而不是「只有一处调用」——读路径
    // （`readJsonCached(…, validateAcl, …)`）与写路径（`write()` 落盘前那次）**各调一次**同一个
    // 函数，而那正是「一份判据」的正确形态：写之前不校验才是真正的漏洞（形状错的内容会落盘，
    // 要等到下一个请求周期才发现）。把计数判据改成「不许有本地定义」，才是这条不变量的形状。
    const code = codeOf("datasource", "acl", "json-source.ts");
    expect(code, "实现器里不许另定义一份校验").not.toMatch(
      /(function|const|let|var)\s+validateAcl\b/,
    );
    // 反向：它必须**从那一个模块**取判据（不是自己写、也不是从别处再引一份）
    expect(code).toMatch(/import\s*\{[^}]*\bvalidateAcl\b[^}]*\}\s*from\s*"\.\/validate\.js"/);
    // 反向：校验模块零 IO（不许自己读文件 —— 那会让「一份判据」变两份）
    expect(codeOnly(codeOf("datasource", "acl", "validate.ts"))).not.toContain("node:fs");
    expect(validateAcl({ target: { blacklist: ["192.168.*.*"] } })).toBeUndefined();
  });

  it("读路径恰好一处：形状校验挂在 readJsonCached 的校验位上", () => {
    // 判据形状是「校验必须是**交给 readJsonCached 的那个函数引用**」，不是计数。
    // ⚠️ 这里刻意**不**去 `blockAfter(source, "public read(")` 切函数体再数出现次数：
    // 那个锚点后面第一个 `{` 是形参默认值 `options: AclReadOptions = {}` 的花括号，
    // 于是切出来的是空对象的 `{}`，计数恒为 0 —— 一条恒为 0 的断言比没有断言更坏。
    // 同理**不**对全文数出现次数：本文件有三个使用点（读侧传引用、启动期调用、写前调用），
    // 数错一个就变成「为了对上而改数」，而那条断言的牙齿本来就不在计数上（真牙齿是上面那条
    // 「不许有本地定义」）。逐个点名，三个使用点各自的形状都被钉住。
    const source = sourceOf(path.join("datasource", "acl", "json-source.ts"));
    // ① 读侧：**传引用**给节流读取层的校验位
    expect(source).toContain("readJsonCached(options.path ?? this.resolveLocator(), validateAcl");
    // ② 启动期：直接调用（不进热加载缓存，故自己判一次）
    expect(source).toContain("const value = validateAcl(JSON.parse(content) as unknown);");
    // ③ 写前：先判再落盘（见下一条断言的次序）
    expect(source).toContain("const validated = validateAcl(next);");
  });

  it("写路径也经同一个 validateAcl：非法内容抛错、绝不落盘", () => {
    // 这是「一份判据」的**另一半**：读侧判一次不够，写侧也得判一次。判据形状是「write() 体内
    // 出现 validateAcl(」——若哪天改成「信任调用方已校验」，本条立刻红，而那正是「写进去了、
    // 下一个请求周期才发现读不出来」的来源。
    const source = codeOf("datasource", "acl", "json-source.ts");
    const writeBody = blockAfter(source, "public write(next: AclConfig)");
    expect(writeBody).toContain("validateAcl(");
    expect(writeBody).toMatch(/throw new Error/);
    // 校验必须在写盘之前（顺序反了就等于没校验）
    expect(writeBody.indexOf("validateAcl(")).toBeLessThan(writeBody.indexOf("writeJsonAtomic("));
  });

  it("数据源层不认识 `ConfigAccessor`（接线只有两个闭包，故可脱离代理单独使用）", () => {
    for (const rel of [
      ["datasource", "acl", "types.ts"],
      ["datasource", "acl", "registry.ts"],
      ["datasource", "acl", "json-source.ts"],
    ]) {
      const code = codeOf(...rel);
      expect(code, `${rel.join("/")} 不得认识 ConfigAccessor`).not.toContain("ConfigAccessor");
      expect(code, `${rel.join("/")} 不得 import @/config/index.js`).not.toContain(
        "@/config/index.js",
      );
    }
    // 名单条目语法住在 `@/utils/addr/`（纯函数词汇层），本层对它只有这一个合法引用
    expect(codeOf("datasource", "acl", "validate.ts")).toContain("@/utils/addr/index.js");
  });
});
