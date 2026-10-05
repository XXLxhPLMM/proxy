/**
 * 包元数据：子包清单的 `version` **恒等于**根包清单的 `version`
 *
 * @description
 * 本档答的是**两个包之间**的那件事，故它与根仓 `tests/unit/meta/version-sync.test.ts` 同属一族而
 * **不是**同一件事：那一档断「生成物印的 == 生成器输入」（横幅 vs 根 `package.json`），本档断
 * 「两个真相源本身相等」（子包 `package.json` vs 根 `package.json`）。
 *
 * ⚠️ **为什么这件事今天零报错**：屏上那个版本号来自 `build.mjs` 的 `readVersion()`（esbuild
 * `define` 把 `process.env.APP_VERSION` 替换成**本子包**那份清单的值 ⇒ `@/cli.tsx` ⇒ 状态行右半），
 * 而本包 `private: true`、**不发布**（`build:pkg` 那张表里没有它）⇒ 两边漂了外部根本查不到，
 * 唯一的症状是「TUI 印着一个比服务端旧的版本号」而没有任何进程会告诉你。
 *
 * ⚠️ **判据形状是「两个真相源相等」而不是「等于某个写死的串」**：钉字面量的话每次抬版本都得记得
 * 回来改它，而改漏了就是一次假绿 —— 症状不是「断言红」，而是「判据悄悄变成了另一个字符串」。
 * 同一条纪律在根仓那道护栏的头注释里写着，两处各守自己那一份。
 *
 * ⚠️ **牙齿是这一条断言，而不是一个「同步版本」的构建步骤**：把同步写进构建，等于让「抬了根包、
 * 忘了子包」这件事在产物里无声地改掉，而断言会让它在提交前红；且同步脚本会成为第二个真相源
 * （它自己那份「哪边为准」就是一条要单独维护的规则）。⚠️ 本仓零兼容，也不加别名。
 *
 * @module tests/meta
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** 本包那份清单（⚠️ 本档在 `tests/meta/`，上溯**两级**才是包根） */
const OWN_MANIFEST = path.join(__dirname, "..", "..", "package.json");
/** 根仓那份清单（⚠️ **四级**：`meta/` → `tests/` → `tui/` → `packages/` 才是仓根；数错一级会 `ENOENT`） */
const ROOT_MANIFEST = path.join(__dirname, "..", "..", "..", "..", "package.json");

/** 一份清单里的 `name` 与 `version`（两格**一起**取：缺任一格都是「探测器认错了东西」） */
function manifestOf(file: string): { name: unknown; version: unknown } {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  return { name: parsed.name, version: parsed.version };
}

describe("包元数据：子包清单的 `version` 恒等于根包清单的 `version`", () => {
  it("⚠️ 两个真相源相等（相等而**不是**「等于某个写死的串」）", () => {
    const own = manifestOf(OWN_MANIFEST);
    const root = manifestOf(ROOT_MANIFEST);

    // ⚠️ **防假绿的正向面**：先证明**读到的是那两份清单**（`name` 逐字对上）且两格 `version` 都非空，
    // 否则下面那句比较是「两个 `undefined` 相等」—— 路径数错一级、清单被改名、`version` 被搬走，
    // 三种破口在比较那一句上**长一模一样**。正向面与它要护的那句必须在同一条 `it` 里：
    // 分开放时谁删掉哪一条，剩下的那条都是纯装饰。
    expect(own.name, `读到的是 ${OWN_MANIFEST}`).toBe("@b-hole/proxy-tui");
    expect(root.name, `读到的是 ${ROOT_MANIFEST}`).toBe("@b-hole/proxy");
    expect(typeof own.version, "子包清单里没有 `version`").toBe("string");
    expect(typeof root.version, "根清单里没有 `version`").toBe("string");
    expect(String(own.version).length).toBeGreaterThan(0);
    expect(String(root.version).length).toBeGreaterThan(0);

    expect(
      own.version,
      `屏上那个版本号来自**子包**清单（build.mjs 的 readVersion()），它印的是 ${String(own.version)}`
        + ` 而根包是 ${String(root.version)} —— 抬版本时两份清单一起改`,
    ).toBe(root.version);
  });
});