/**
 * 弹窗里**焦点那一格**的插入符：`input` 那一格画出「光标在第几个字」，而 `select` 那一格与
 * **非焦点**的那些**一个字都不画**。
 *
 * @description
 * ⚠️ 这一族要挡的是「屏上只有『焦点在这一格』而没有『光标在第几个字』」：那两件事是**两个通道**
 * （最亮那一档 + 加粗答前者，反底色块答后者），而少画后者的症状是「框里的光标钉在词尾不动」。
 * ⚠️ 而**留在屏上的反底色块等于说「焦点还在那儿」** —— 故非焦点那一格画它，与弹窗开着时
 * `Composer` 画它是同一类错误（那两个方向的判据分别在 `tests/layout/history.test.ts` 与
 * `tests/render/composer-selection.test.ts`）。
 *
 * @module tests/layout
 */

import { describe, expect, it, vi } from "vitest";

// ⚠️ 必须在 ink（因而 chalk）被 import 之前设好，否则每一档的着色判据恒为「没有序列」—— 见 `AGENTS.md`
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { widthOf } from "@/lib/format.js";
import { geometry } from "@/lib/geometry.js";
import { themeOf, toneColor, type Theme } from "@/theme/index.js";
import type { FieldCell, ModalView } from "@/components/index.js";
import { geoInput, props, renderRaw, stripAnsi } from "./_harness.js";
import { bgAtColumn, bgSgrOf, columnOfIndex, indexOfText, rawIndexOfColumn } from "./_probe.js";

/** 卡片吃的是**没盖遮罩**的那一份主题（`@/app.tsx` 三处都喂 `plain`） */
const card = (): Theme => themeOf({ color: true, scrimmed: false });

/** 一格（`cursor` 必带 —— 它在视图契约里**不是**可选的） */
function field(over: Partial<FieldCell> & Pick<FieldCell, "kind" | "label" | "value" | "focused">): FieldCell {
  return { cursor: over.value.length, ...over };
}

/** 五个字段（⚠️ **固定顺序**：地址 / API 格式 / id / 名称 / key —— 与 `AppState.tsx:PROVIDER_FIELDS` 同序） */
function fieldsOf(focusedAt: number): readonly FieldCell[] {
  return [
    field({ kind: "input", label: "地址", value: "abcd", focused: focusedAt === 0, cursor: 2 }),
    field({
      kind: "select",
      label: "API 格式",
      value: "openai",
      focused: focusedAt === 1,
      options: ["openai", "anthropic"],
    }),
    field({ kind: "input", label: "提供商 id", value: "live", focused: focusedAt === 2 }),
    field({ kind: "input", label: "提供商名称", value: "示例", focused: focusedAt === 3 }),
    // ⚠️ **凭据那一格恒是掩码或空串**：留空 = 不改，而它的插入符落在第 0 格（空着等你敲）
    field({ kind: "input", label: "key", value: "", focused: focusedAt === 4 }),
  ];
}

/** 提供商那张表单，焦点压在第 `focusedAt` 格上 */
function formView(focusedAt: number): ModalView {
  return {
    kind: "provider-form",
    title: "新增提供商",
    fields: fieldsOf(focusedAt),
    note: null,
    closeHint: true,
  };
}

/** 那一帧里带 `selected` 底色（反底色块）的**显示列**清单 */
function cursorColumns(line: string, width: number): readonly number[] {
  const want = bgSgrOf(toneColor("selected", card())!);
  const out: number[] = [];
  for (let x = 0; x < width; x += 1) {
    if (bgAtColumn(line, x) === want) out.push(x);
  }
  return out;
}

describe("弹窗的焦点格：插入符只在 `input` + 有焦点那一格上", () => {
  it("⚠️ 焦点格**有**一个反底色块且落在第 `cursor` 个字上；非焦点格与下拉格**一个都没有**", async () => {
    // ⚠️ **焦点格与下拉格各自起一帧**：下拉那一格**被按成焦点**的那一帧才有鉴别力 ——
    // 「`select` 不许画」在「它本来就没焦点」的实现上是恒真的（那个块压根不画）。
    const p = props({ color: true, view: formView(0) });
    const g = geometry(geoInput(p));
    const raw = await renderRaw(p);
    const rowOf = (slot: number): string => raw[g.windowSlots[slot]!.y] ?? "";
    const slotWidth = (slot: number): number => g.windowSlots[slot]!.width;
    // ⚠️ **正向对照**：五格**都真的画出来了**（少读一格的话下面那些「一个都没有」恒成立）
    expect(stripAnsi(rowOf(0))).toContain("abcd");
    expect(stripAnsi(rowOf(1))).toContain("openai");
    expect(stripAnsi(rowOf(2))).toContain("live");
    expect(stripAnsi(rowOf(4))).toContain("key");

    // ── ① 焦点那一格：恰好一个反底色块，且**盖住光标所在的那个字** ──
    const focused = rowOf(0);
    const at = cursorColumns(focused, slotWidth(0));
    expect(at).toHaveLength(1);
    // ⚠️ **期望值从几何与那一串字现算**：块落在 `value` 起画那一列 + 光标之前那几个字的宽。
    // ⚠️ 锚点用**光标之前那一段**（「`ab`」）：那个块把整串切成三段，锚整串的话永远找不到。
    const headAt = indexOfText(focused, "ab");
    expect(headAt).toBeGreaterThanOrEqual(0);
    const startColumn = columnOfIndex(focused, headAt);
    expect(startColumn).toBeGreaterThanOrEqual(0);
    expect(at[0]).toBe(startColumn + widthOf("ab"));
    const glyph = focused[rawIndexOfColumn(focused, at[0]!)];
    // ⚠️ `cursor: 2` ⇒ 那个块盖住的是**第三个字**（下标 2），不是第二个
    expect(glyph).toBe("c");

    // ── ② 非焦点那一格：一个都不许有（留着它等于说「焦点还在那儿」） ──
    expect(cursorColumns(rowOf(2), slotWidth(2))).toEqual([]);
    // ⚠️ **凭据那一格**（空串）同样不许有 —— 而它那一格真的画出来了（上面已自检）
    expect(cursorColumns(rowOf(4), slotWidth(4))).toEqual([]);

    // ── ③ 下拉那一格：**焦点压在它上面**也一个都不许有（下拉里没有可编辑文本） ──
    const onSelect = props({ color: true, view: formView(1) });
    const gSelect = geometry(geoInput(onSelect));
    const selectRaw = await renderRaw(onSelect);
    const selectRow = selectRaw[gSelect.windowSlots[1]!.y] ?? "";
    // ⚠️ **正向对照**：那一帧里焦点真的压在**下拉**格上（值与可选项都画着，且它是唯一有焦点那一格）
    expect(stripAnsi(selectRow)).toContain("openai");
    expect(stripAnsi(selectRow)).toContain("anthropic");
    // ⚠️ **反向自检**：同一帧里**别的 `input` 格也没有块**（焦点唯一 ⇒ 那一帧恒只有一个块的位置）
    expect(cursorColumns(selectRaw[gSelect.windowSlots[0]!.y] ?? "", gSelect.windowSlots[0]!.width)).toEqual([]);
    expect(cursorColumns(selectRow, gSelect.windowSlots[1]!.width)).toEqual([]);
  });

  it("⚠️ 焦点在**别的格**上时，那一格一个块都没有（空的那几格不许留着上一帧的块）", async () => {
    const p = props({ color: true, view: formView(2) });
    const g = geometry(geoInput(p));
    const raw = await renderRaw(p);
    // ⚠️ **正向对照**：焦点那一格**真的有**块（不钉它的话下面三条在「什么都没画」时恒成立）
    expect(cursorColumns(raw[g.windowSlots[2]!.y] ?? "", g.windowSlots[2]!.width)).toHaveLength(1);
    for (const slot of [0, 1, 3, 4]) {
      expect(cursorColumns(raw[g.windowSlots[slot]!.y] ?? "", g.windowSlots[slot]!.width), `第 ${String(slot)} 格`).toEqual([]);
    }
  });
});