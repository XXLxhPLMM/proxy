/**
 * 显示宽度下的截断与对齐：`ellipsis` 与 `padToWidth`。
 *
 * @description
 * ⚠️ 度量是 `widthOf`（显示宽度）而不是 `String.length`：中文与 emoji 一格宽 2，故**只测 ASCII 的那一档
 * 对两种度量都成立** —— 换成 `String.length` 时单测照样全绿，而真终端里的表格已经歪了。切点因此不许落在
 * 宽字符中间，也不许切出半个代理对（半个 emoji 在终端上是豆腐块）。
 *
 * 锁什么与「为什么拆掉哪一处会红」见本目录 `AGENTS.md`。
 *
 * @module tests/format
 */

import { describe, expect, it } from "vitest";
import { ellipsis, padToWidth, widthOf } from "@/lib/format.js";

describe("ellipsis：按显示宽度切，不是按 String.length", () => {
  it("装得下就原样返回", () => {
    expect(ellipsis("abcd", 4)).toBe("abcd");
    expect(ellipsis("ab", 4)).toBe("ab");
  });

  it("ASCII：留一格给 `…`", () => {
    expect(ellipsis("abcdef", 4)).toBe("abc…");
  });

  it("中文按显示宽度算（`账号` 宽 4，length 只有 2）", () => {
    expect(widthOf("账号")).toBe(4);
    expect("账号".length).toBe(2);
    // 5 格：放得下「账号」（4）再放不下「列」（要 6）⇒ 切成一个字的 `…`
    expect(ellipsis("账号列表", 5)).toBe("账号…");
    expect(widthOf(ellipsis("账号列表", 5))).toBe(5);
  });

  it("⚠️ 中文的切点在宽字符上不切开（宁可少一个字形，也不让这一列越出位置）", () => {
    // 宽 2 的字 + `…`（宽 1）：剩 2 格刚好放一个「账」；再多一格也放不下第二个字
    expect(ellipsis("账号列表", 3)).toBe("账…");
    expect(widthOf(ellipsis("账号列表", 3))).toBe(3);
  });

  it("emoji 按显示宽度算（😀 宽 2）", () => {
    expect(widthOf("😀")).toBe(2);
    expect(ellipsis("😀😀", 3)).toBe("😀…");
    expect(widthOf(ellipsis("😀😀", 3))).toBe(3);
  });

  it("⚠️ 任何宽度下都不产生半个代理对（半个 emoji 在终端上是豆腐块）", () => {
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const width of [1, 2, 3, 4, 5, 6]) {
      expect(ellipsis("😀😀", width), `宽度 ${width} 切出了半个代理对`).not.toMatch(loneSurrogate);
    }
  });

  it("宽度 1 只剩 `…`；宽度 <= 0 是空串（Ink 在 0 宽盒子里排版会抛）", () => {
    expect(ellipsis("abc", 1)).toBe("…");
    expect(ellipsis("abc", 0)).toBe("");
    expect(ellipsis("abc", -3)).toBe("");
  });
});

describe("padToWidth：右对齐按显示宽度补空格", () => {
  it("左对齐补在右边", () => {
    expect(padToWidth("ab", 5, "left")).toBe("ab   ");
  });

  it("⚠️ 右对齐中文补的是**空格**、按显示宽度数（补错就整列歪）", () => {
    const padded = padToWidth("账号", 8, "right");
    expect(widthOf(padded)).toBe(8);
    // 「账号」显示宽度 4 ⇒ 补 4 格；按 length 补会补成 6 格（整列右移两格）
    expect(padded).toBe("    账号");
    expect("账号".length).toBe(2);
  });

  it("已经等宽时**不**动它（切只有 ellipsis 一个出口）", () => {
    expect(padToWidth("abcd", 4, "left")).toBe("abcd");
  });

  it("超宽时原样返回（调用方必须先 ellipsis）", () => {
    expect(padToWidth("abcdef", 3, "right")).toBe("abcdef");
  });
});
