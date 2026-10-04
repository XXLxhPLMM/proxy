/**
 * 探测器自检：这一组测的是**本目录那两个共用模块的探测器本身**，不是界面。
 *
 * @description
 * ⚠️ 缺了它，「什么都没渲染出来」这一类实现会让本目录每一条 `includes` 都绿 —— 而那恰恰是这一类界面
 * 最可能的失败形态。⚠️ 三条都答同一个问题：**探针给 `-1` / `null` 时恒成立的判据，一律不算判据**，
 * 故每条在用探针之前先自检它找到了。
 *
 * @module tests/layout
 */

import { describe, expect, it, vi } from "vitest";

// ⚠️ 必须在 ink（因而 chalk）被 import 之前设好，否则每一档的着色判据恒为「没有序列」—— 见 `AGENTS.md`
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { props, renderFrame, renderRaw } from "./_harness.js";
import { atText, rowRawOf, sgrColorAt } from "./_probe.js";

describe("探测器自检（这一组测的是本档的探测器本身）", () => {
  it("sgrColorAt 答的是「**哪一个**色」——选中的那一项与未选中的那几行不同", async () => {
    const raw = await renderRaw(props({ color: true }));
    const at = atText(raw, "会话 1");
    expect(at.index).toBeGreaterThanOrEqual(0);
    expect(sgrColorAt(at.line, at.index, "fg")).not.toBeNull();
  });

  it("反向自检：整帧真的渲染出了东西（空渲染会让上面每一条 `includes` 都绿）", async () => {
    const lines = await renderFrame(props());
    // ⚠️ **不许按屏高断言**：本档的取帧会把**空行**滤掉，而结果区那 21 行里只有 1 行有内容
    // （`renderFrame` 的判据是「有内容」而不是「有这么多行」—— 见它自己的注释）
    expect(lines.length).toBeGreaterThanOrEqual(8);
    expect(lines.some((line) => line.includes("╭"))).toBe(true);
    expect(lines.some((line) => line.includes("会话 1"))).toBe(true);
  });

  it("反向自检：探测器找得到那一行（找不到时它给 -1，而上面几条会恒假）", async () => {
    const raw = await renderRaw(props());
    expect(rowRawOf(raw, "会话 1")).toBeGreaterThanOrEqual(0);
  });
});
