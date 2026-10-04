/**
 * 探测器与扫描面：判据**本身**看得见违规、且作用面不是空集。
 *
 * @description
 * 四条上限判据**天生怕空**：文件列表取不到就是零个文件、每条断言都在空集上通过；而探测器写坏了
 * 也会让同一批断言全绿（`headCommentLines` 恒返回 0 时，「文件头 ≤6 行」对任何输入都成立）。
 * 故本档逐条钉住探测器：喂进**合成的**违规文本必须被认出来，而喂进合规文本必须**认不出来**
 * （后者防的是「判据过宽，什么都算违规」这种反向失守）。
 *
 * ⚠️ 合成样本是**内联字面量**，不走磁盘：这样本档判的是探测器而不是语料，故它与 `limits.test.ts`
 * 零耦合 —— 语料变多、变少、或某个源文件改了注释，本档的结论都不该动。
 *
 * 四条上限的取值在 `limits.test.ts`；判据为什么是行数、为什么只管体量不管对错，见 `AGENTS.md`。
 *
 * @module tests/comment-budget
 */

import { describe, expect, it } from "vitest";
import { SRC, commentBlocks, headCommentLines, isBarrel } from "./_shared.js";

describe("覆盖面（防「扫描面是空的 → 下面全是空断言」）", () => {
  it("扫描面覆盖到本包的源文件，且新增文件自动入扫描", () => {
    const names = SRC.map(([name]) => name);
    expect(names.length).toBeGreaterThanOrEqual(40);
    expect(names).toContain("hooks/useTerminalSize.ts");
    expect(names).toContain("features/sessions/SessionSidebar.tsx");
    expect(names).toContain("api/endpoints/status.ts");
  });

  it("barrel 识别器认得出 barrel、且认不出普通实现文件（否则 barrel 那档判据会落空）", () => {
    expect(isBarrel(['export { a } from "./a.js";'])).toBe(true);
    expect(isBarrel(["const x = 1;", "export const a = x;"])).toBe(false);
  });

  it("头部行数判据数得出头部，且不把正文注释算进去", () => {
    const lines = ["/**", " * a", " */", "export const x = 1;", "/**", " * 正文注释", " */", ""];
    expect(headCommentLines(lines)).toBe(3);
    expect(headCommentLines(["// 一行", "const a = 1;"])).toBe(1);
    expect(headCommentLines(["const a = 1;", "/**", " * 正文", " */"])).toBe(0);
  });
});

describe("判据自检（防「探测器写坏了 → 全绿」）", () => {
  it("超长文件头被判为违规（探测器看得见，不是恒返回零）", () => {
    const long = ["/**", ...Array.from({ length: 20 }, (_, i) => ` * 第 ${i} 行`), " */", "export const a = 1;"];
    expect(headCommentLines(long)).toBeGreaterThan(6);
  });

  it("合规文件头判为不违规（防「判据过宽，什么都算违规」这种反向失守）", () => {
    const ok = ["/**", " * 一句话。", " */", "export const a = 1;"];
    expect(headCommentLines(ok)).toBeLessThanOrEqual(6);
  });

  it("超长 ⚠️ 块与超长普通块都被认出来（判据 3 与判据 4 各有各的探测器）", () => {
    const warn = ["/**", ...Array.from({ length: 6 }, () => " * ⚠️ 一句"), " */", "const a = 1;"];
    expect(commentBlocks(warn).some((b) => b.lines.length > 3 && b.lines.some((l) => l.includes("⚠")))).toBe(true);
    const plain = ["/**", ...Array.from({ length: 20 }, (_, i) => ` * 行 ${i}`), " */", "const a = 1;"];
    expect(commentBlocks(plain).some((b) => b.lines.length > 12)).toBe(true);
  });
});