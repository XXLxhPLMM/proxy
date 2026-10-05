/**
 * 需求 3 §3：用户消息在结果区里画成**一块带底色的行** —— 左边距一列 + **恰好一枚**箭头
 * （与输入框同一枚、同一列宽）+ 底色 `bubble`，而**命令回显保持现状（无底色）**。
 *
 * @description
 * ⚠️ 这一档分两半：**逐格**量「那一个组件画成什么样」（`renderElement`），与**接线**那一半
 * （`@/features/output/OutputView` 真的把行模型里那一档 `user` 派给了它，走整屏的 `@/app.js` 那一帧）。
 * ⚠️ 两半都要的理由：组件本身对了而分派没接上时，逐格那一半**全绿**（它压根不经过分派），
 * 而屏上仍是「一色一行」—— 与「组件画错了」在屏上长得一样。
 * ⚠️ 而「折行的**每一行**都重复那一个箭头」由**行模型**保证（一段折行 = 若干行，每行一段文字），
 * 所以这一档量的是**每一段**的形状，而「一段 = 一行」这件事归 `tests/log/`。
 *
 * @module tests/render
 */

import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

// ⚠️ 必须在 ink（因而 chalk）被 import 之前设好，否则着色判据恒为「没有序列」—— 见本目录 `AGENTS.md`
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { Box, Text } from "ink";
import { PROMPT_COLUMNS, geometry } from "@/lib/geometry.js";
import { widthOf } from "@/lib/format.js";
import { flatten, type LogEntry } from "@/lib/log/index.js";
import { themeOf, toneColor, type Theme } from "@/theme/index.js";
import { UserBubble } from "@/features/output/UserBubble.js";
import {
  bgAtColumn,
  bgSgrOf,
  columnOfIndex,
  fgSgrOf,
  geoInput,
  indexOfText,
  props,
  renderElement,
  renderElementRaw,
  renderRaw,
  sgrColorAt,
  stripAnsi,
} from "./_harness.js";

/** **不盖遮罩**时的那份主题（结果区吃的就是它） */
const card = (): Theme => themeOf({ color: true, scrimmed: false });

/** 结果区的内容宽度（⚠️ 与 `tests/layout` 那一档同一个数：那正是 `Geometry.outputWidth`） */
const WIDTH = 62;

describe("需求 3 §3：用户消息是一块带底色的行，而命令回显没有底色", () => {
  it("⚠️ **左边距一列 + 恰好一枚箭头**，而那一枚与输入框**同一列宽**", async () => {
    const screen = await renderElement(
      createElement(UserBubble, { text: "看看 alice 的用量", width: WIDTH, theme: card() }),
      WIDTH,
      1,
    );
    const line = screen[0] ?? "";
    // ⚠️ **探针先自检**：渲染为空的话下面每一条都在零行上「绿」
    const at = indexOfText(line, "看看 alice 的用量");
    expect(at).toBeGreaterThanOrEqual(0);
    const arrowAt = indexOfText(line, "❯");
    expect(arrowAt).toBeGreaterThanOrEqual(0);
    // ⚠️ **左边距恰好一列**：箭头落在第 1 列（第 0 列是留白）
    expect(columnOfIndex(line, arrowAt)).toBe(1);
    // ⚠️ 而**那一行只有一个箭头**（第二枚会读成「我又敲了一句」）
    expect(line.split("❯").length - 1).toBe(1);
    // ⚠️ **与输入框是同一枚、同一列宽**：那一列宽恒等于几何层那一个数（改常量与改实现同时发生就恒绿）
    expect(PROMPT_COLUMNS).toBe(2);
    expect(widthOf("❯ ")).toBe(PROMPT_COLUMNS);
    // ⚠️ 而**文字从箭头右缘起**（它与输入框里那些字竖直对齐）
    expect(columnOfIndex(line, at)).toBe(1 + PROMPT_COLUMNS);
  });

  it("⚠️ 那一行**每一格都是那一层底色**（气泡是一整块，不是一段彩条）", async () => {
    const raw = await renderElementRaw(
      createElement(UserBubble, { text: "短", width: WIDTH, theme: card() }),
      WIDTH,
      1,
    );
    const wantBg = bgSgrOf(toneColor("bubble", card())!);
    // ⚠️ **反向自检**：底色**真的**是 `bubble` 那一档（主题里它与 `panel` 逐字不同 ⇒ 拿错档会被逮住）
    expect(toneColor("bubble", card())).not.toBe(toneColor("panel", card()));
    const line = raw[0] ?? "";
    for (const x of [0, 1, WIDTH - 2, WIDTH - 1]) {
      expect(bgAtColumn(line, x), `第 ${String(x)} 列`).toBe(wantBg);
    }
    // ⚠️ 而**短消息也铺满整行**（那条底色归**外层那个 `<Box>`**：Ink 把带底色的盒子整块写成
    // 带底色的空格，而子节点从**最近的带底色的祖先**继承 —— 漏掉外层那一份会在这一格上戳个洞）
    for (let x = 0; x < WIDTH; x += 1) {
      expect(bgAtColumn(line, x), `第 ${String(x)} 列`).toBe(wantBg);
    }
  });

  it("⚠️ **命令回显那一行没有底色**（两者在屏上必须分得开 —— 那正是加这一档色的判据）", async () => {
    // ⚠️ 这里量的是「**没有**底色的那一半」：一块没有 `bubble` 底的普通文本行
    const screen = await renderElement(
      createElement(
        Box,
        { width: WIDTH, height: 1 },
        createElement(Text, null, "❯ /targets"),
      ),
      WIDTH,
      1,
    );
    expect(screen[0] ?? "").toContain("/targets");
    const raw = await renderElementRaw(
      createElement(
        Box,
        { width: WIDTH, height: 1 },
        createElement(Text, null, "❯ /targets"),
      ),
      WIDTH,
      1,
    );
    // ⚠️ **逐格**问「哪一个底色」而不是「开没开」：结果区没有祖先底色，于是两句话在这里同形，
    // 而**有底色**的那一半在下一条里量 ⇒ 两条合起来才是「两者分得开」。
    for (const x of [0, 5, WIDTH - 1]) {
      expect(bgAtColumn(raw[0] ?? "", x), `第 ${String(x)} 列`).not.toBe(
        bgSgrOf(toneColor("bubble", card())!),
      );
    }
  });

  it("⚠️ 超长的一段被**裁**到那一宽，而那一行仍**恰好**那一宽（Ink 静默软换行会多出一行）", async () => {
    const screen = await renderElement(
      createElement(UserBubble, { text: "很长".repeat(200), width: WIDTH, theme: card() }),
      WIDTH,
      2,
    );
    // ⚠️ **反向自检**：两行里只有第一行有字（软换行的话会占满两行，而那正是「裁漏了」的形状）
    expect(screen.filter((one) => one !== "").length).toBe(1);
    expect(screen[0] ?? "").toContain("…");
    expect(widthOf(screen[0] ?? "")).toBeLessThanOrEqual(WIDTH);
  });
});

/**
 * 接线那一半：**整屏那一帧**里，行模型那一档 `user` 真的走了气泡那一支，而命令回显没走
 *
 * @description
 * ⚠️ **判据是屏上那两个通道**（底色 `bubble` + 文字那一档），而**不是**「分派用的那个集合里有
 * `user`」：后者是内部结构，而一个恒真的内部断言与「屏上根本没有气泡」在症状上完全一样。
 * ⚠️ 两条判据**必须同属一个 `it`**：只有「`user` 那一行有底色」的话，一个把**所有**行都画成气泡的
 * 实现照样绿 —— 而那正是「分派判据写反了」那一种。
 */
describe("接线：行模型那一档 `user` 真的派给了气泡那一支（整屏那一帧）", () => {
  /** 一格「我说的话」+ 一格「要执行的那条命令」（⚠️ **同一帧里**才有对照可读） */
  function twoRows(): readonly LogEntry[] {
    return [
      { id: 1, at: 0, turns: [{ kind: "user", text: "把名单发给所有控制面" }] },
      { id: 2, at: 0, turns: [{ kind: "tool-call", echo: { kind: "echo", text: "/targets" } }] },
    ];
  }

  it("⚠️ `user` 那一行**有底色**、字是 `muted`；同一帧里命令回显**两者都没有**", async () => {
    const base = props({ color: true });
    // ⚠️ **折行宽度从几何现取**（拿常量当期望值的话，改几何不改断言 ⇒ 恒绿）
    const width = geometry(geoInput(base)).outputWidth;
    const raw = await renderRaw({ ...base, flat: flatten(twoRows(), width) });
    const rowOf = (needle: string): string => {
      const at = raw.findIndex((line) => stripAnsi(line).includes(needle));
      // ⚠️ **探针先自检**：`raw[at]` 给 `undefined` 时下面每一条都在「空行」上绿
      expect(at, `那一帧里没有「${needle}」`).toBeGreaterThanOrEqual(0);
      return raw[at]!;
    };
    const said = rowOf("把名单发给所有控制面");
    const echoed = rowOf("/targets");
    // ⚠️ **底色**：那一格真的落在 `bubble` 上（分派没走气泡那一支时它是 `null`）
    const saidAt = indexOfText(said, "把名单");
    expect(saidAt).toBeGreaterThanOrEqual(0);
    const saidColumn = columnOfIndex(said, saidAt);
    expect(saidColumn).toBeGreaterThanOrEqual(0);
    expect(bgAtColumn(said, saidColumn)).toBe(bgSgrOf(toneColor("bubble", card())!));
    // ⚠️ **文字色**：与命令回显的 `accent` **不同档**（同档的话两个通道塌成一个）
    expect(sgrColorAt(said, saidAt, "fg")).toBe(fgSgrOf(toneColor("muted", card())!));
    // ⚠️ **反向对照（同一个 `it`）**：命令回显那一行既没有那层底色，字也仍是自己那一档
    const echoAt = indexOfText(echoed, "/targets");
    expect(echoAt).toBeGreaterThanOrEqual(0);
    const echoColumn = columnOfIndex(echoed, echoAt);
    expect(echoColumn).toBeGreaterThanOrEqual(0);
    expect(bgAtColumn(echoed, echoColumn)).not.toBe(bgSgrOf(toneColor("bubble", card())!));
    expect(sgrColorAt(echoed, echoAt, "fg")).toBe(fgSgrOf(toneColor("accent", card())!));
  });
});