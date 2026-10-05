import { describe, expect, it } from "vitest";
import { codeOf, sourceFiles } from "../../helpers/source-scan.js";

/**
 * `@/ops` 的层边界（源码级：结构化 + 单向依赖）
 *
 * @description
 * 本档只读**源码文本**（`codeOnly` 去注释），不构造任何对象、不起临时目录。
 * 五条主题级不变量与「为什么这几条必须成对断言」见 `./AGENTS.md`。
 * ⚠️ **这些判据天生怕空**：`sourceFiles("ops")` 路径写错、或者本层某个文件被整体搬走，
 * 下面每一条都会在空集上通过 —— 故第一条就是「扫描面非空且含本层出口」。
 */

describe("ops 层边界：结构化 + 单向依赖", () => {
  // 与 `admin/cli/` 那组共用同一个「列目录」helper，零 console / 零 process / 不 import
  // 代理侧三条**不在这里重复断言**（那是整工具的护栏，它的牙齿在那边）。
  const opsFiles = sourceFiles("ops");

  it("扫描范围非空且含本层的出口（否则下面两条断言会整组恒绿）", () => {
    expect(opsFiles).toContain("ops/index.ts");
    expect(opsFiles.length).toBeGreaterThanOrEqual(5);
  });

  it("**ops 绝不 import `@/admin/*`**（数据操作不该知道谁在显示它的结果）", () => {
    for (const file of opsFiles) {
      expect(codeOf(file), `${file} 不许反向依赖传输层`).not.toMatch(/from\s+"@\/admin\//);
    }
    // ⚠️ **双向判据自检**：单看上面那条的话，把实现整份搬回 admin 就能让这组恒绿。正向这一侧证明
    // 「admin → ops」这条边今天真的存在，于是「ops → admin」才是真的没有。
    expect(codeOf("admin/users.ts")).toMatch(/from\s+"@\/ops\/index\.js"/);
    expect(codeOf("admin/index.ts")).toMatch(/from\s+"@\/ops\/index\.js"/);
  });

  it("ops 对 `@/config` 只用那一个 barrel 出口（条目语法原语走 `@/addr`）", () => {
    // 与本仓「目录对外只暴露一个 barrel」同纪律：ops 破一次，配置层的内部布局就跟着它漂。
    for (const file of opsFiles) {
      for (const match of codeOf(file).matchAll(/from\s+"@\/config\/([^"]+)"/g)) {
        expect(["index.js"], `${file} 引了 @/config/${match[1]}（只有 barrel 是合法的）`).toContain(
          match[1],
        );
      }
    }
  });

  it("ops 引 `@/utils/addr` 时只引它那一个 barrel（地址层不对外露深层路径）", () => {
    // ⚠️ **双向判据自检**：单看允许集的话，把 `acl.ts` 整份搬走就没人引 `@/utils/addr` 了、这组恒绿。
    // 正向这一侧证明「ops → addr」这条边今天真的存在（`acl.ts` 是名单条目语法的消费方）。
    expect(codeOf("ops/acl.ts")).toContain('from "@/utils/addr/index.js"');
    for (const file of opsFiles) {
      for (const match of codeOf(file).matchAll(/from\s+"@\/utils\/addr\/([^"]+)"/g)) {
        expect(["index.js"], `${file} 引了 @/utils/addr/${match[1]}（只有 barrel 是合法的）`).toContain(
          match[1],
        );
      }
    }
  });

  it("ops 不 import `@/core` / `@/runtime` / `@/server`（管理工具不启动代理）", () => {
    for (const file of opsFiles) {
      expect(codeOf(file), `${file} 不许 import 代理侧`).not.toMatch(/from\s+"@\/(core|runtime|server)\//);
    }
  });
});