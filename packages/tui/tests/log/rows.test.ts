/**
 * 用户那句话那一档行的**折行形状**：按显示列折、**不标截断**，且**每一段**都带 `kind:"user"`
 *
 * @description
 * ⚠️ 这一档量的对象是 `LogRow` 那一档 `user`（不是 `Turn` 的变体清单 —— 那是 `turn.test.ts` 的活）：
 * 判据是**摊平之后逐行**的 `kind`，而「每一段都带那一档」正是屏上「折行的每一行都重复那枚箭头」的
 * 前提（呈现层按**逐行**的 `kind` 分派，只给第一段带的话气泡左边会参差不齐）。
 *
 * ⚠️ **纯 ASCII 的用例对两种度量都成立**，故每条折行判据都必须带 CJK 行，否则那条护栏恒绿。
 *
 * 不变量与「为什么拆掉哪一处会红」见本目录 `AGENTS.md`。
 *
 * @module tests/log
 */

import { describe, expect, it } from "vitest";
import { flatten, type LogEntry, type LogRow, type Turn } from "@/lib/log/index.js";

/** 一格装着「操作者敲的那一句话」的对话（⚠️ **一格装的是 `Turn` 而不是 `LogRow`**） */
function userEntry(text: string): LogEntry {
  return { id: 1, at: 0, turns: [{ kind: "user", text } satisfies Turn] };
}

/** 把一行装进 `tool-result` 那一档（那是「一格行」的另一个入口） */
function toolResult(row: LogRow): Turn {
  return { kind: "tool-result", rows: [row] };
}

describe("不变量 ⑨：用户那句话按显示列折行，且**每一段**都带 `kind:\"user\"`", () => {
  it("CJK「一二三四五六七八九十」宽 4 → 5 段（字符数度量会说「5 个字装得下」而给 3 段）", () => {
    const lines = flatten([userEntry("一二三四五六七八九十")], 4).lines;
    expect(lines.map((l) => l.text)).toEqual(["一二", "三四", "五六", "七八", "九十"]);
  });

  it("⚠️ **每一段的 `kind` 与色档都带 `user` 那一档**（气泡按逐行的 `kind` 分派）", () => {
    // ⚠️ 探针先自检：那一档今天真的被摊出来了（探测器恒空的话下面每一条都在零行上绿）
    expect(flatten([userEntry("看看 alice")], 40).lines[0]!.kind).toBe("user");

    const lines = flatten([userEntry("一二三四五六七八九十")], 4).lines;
    expect(lines).toHaveLength(5);
    expect(lines.map((l) => l.kind)).toEqual(["user", "user", "user", "user", "user"]);
    expect(lines.map((l) => l.tone)).toEqual(["muted", "muted", "muted", "muted", "muted"]);
    // ⚠️ `part` 是**段序号**（从 0 起）：呈现层拿它当 React 的 key 的一半，
    // 而「一段折行 = 若干行、每行一段文字」这件事破了的话 key 也就跟着撞
    expect(lines.map((l) => l.part)).toEqual([0, 1, 2, 3, 4]);
  });

  it("⚠️ **折行不标截断**（换行已完整呈现全部内容；标了就是一句假话）", () => {
    const wrapped = flatten([userEntry("很长".repeat(200))], 8).lines;
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.filter((l) => l.clipped)).toEqual([]);
    // ⚠️ **正向对照**：同一段文本装进 `table` 那一档**会**标截断（那一族按 `clipped` 钉，不折行）
    // ⇒ 「一个都没标」不是判据太宽
    const fitted = flatten(
      [{ id: 1, at: 0, turns: [toolResult({ kind: "table", head: ["列"], rows: [["很长".repeat(200)]] })] }],
      8,
    ).lines;
    expect(fitted.filter((l) => l.clipped)).toHaveLength(1);
  });

  it("**逐字不丢**（折开再接回去必须与原文逐字相等）", () => {
    const text = "一二三四五六七八九十，够长";
    expect(flatten([userEntry(text)], 4).lines.map((l) => l.text).join("")).toBe(text);
  });

  it("含 `\\n` 的一段：⚠️ **它切硬行**（与输入框同一条纪律），而**每一段**照样带 `user`", () => {
    // ⚠️ 判据形状是 `split("\\n")` 的**长度**而不是「非空段」：末尾那个空段与连续两个 `\\n` 各占一格，
    // 而每一段都被折成整格宽的文本 ⇒ 屏上续段那一行画得出来、也带得上那枚箭头
    const lines = flatten([userEntry("第一句\n第二句第二句")], 6).lines;
    expect(lines.map((l) => l.text)).toEqual(["第一句", "第二句", "第二句"]);
    expect(lines.map((l) => l.kind)).toEqual(["user", "user", "user"]);
    // ⚠️ **空段也不许被吞**：那两个用例的空段形状上与上面那条不可区分，故单独钉住
    expect(flatten([userEntry("ab\n")], 6).lines.map((l) => l.text)).toEqual(["ab", ""]);
    expect(flatten([userEntry("\n")], 6).lines.map((l) => l.text)).toEqual(["", ""]);
  });

  it("⚠️ **正向对照：命令回显那一档逐段带的是 `echo`**（新加的那一支没把别档抢走）", () => {
    // ⚠️ 没有这一组的话「所有散文档都返回 `user`」那种实现也能全绿
    const echoed = flatten(
      [{ id: 1, at: 0, turns: [{ kind: "tool-call", echo: { kind: "echo", text: "一二三四五六七八九十" } }] }],
      4,
    ).lines;
    expect(echoed.map((l) => l.kind)).toEqual(["echo", "echo", "echo", "echo", "echo"]);
  });

  it("⚠️ **显式写出来的那一行与从 `Turn` 摊出来的同形**（两条路必须收敛到同一档）", () => {
    // ⚠️ `rowsOf` 只判 `row.kind` 而折行算术归 `pushWrapped`：显式行若走成别的那一档，
    // 「一格对话」与「一格行」在屏上就会差一个形状
    const row: LogRow = { kind: "user", text: "一二三四五六七八九十" };
    expect(flatten([{ id: 1, at: 0, turns: [toolResult(row)] }], 4).lines).toEqual(
      flatten([userEntry(row.text)], 4).lines,
    );
  });
});