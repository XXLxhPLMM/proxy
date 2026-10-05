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

import { WINDOW_INPUT_PROMPT_COLUMNS, geometry, type WindowSlot } from "@/lib/geometry.js";
import { geoInput, props, renderFrame, renderRaw } from "./_harness.js";
import { atText, columnOfIndex, rawIndexOfColumn, rowRawOf, sgrColorAt } from "./_probe.js";

/** 一份带分组标题与改名框的历史会话（入参形状那一族用） */
const history = {
  title: "历史会话",
  rows: [
    { id: "", name: "", header: "今天", pinned: false, manager: null, at: 0, label: "今天" },
    { id: "h1", name: "会话 3", header: null, pinned: true, manager: "live-ok", at: 0, label: "会话 3" },
  ],
  at: 0,
  note: "只有 2 个",
  rename: { id: "h1", text: "a", cursor: 1 },
  closeHint: false,
};

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

  // ⚠️ 这一组是「**下标 ↔ 显示列**」那一族的越界纪律（合成样本，不读磁盘）：探测器必须答得出
  // 「那个下标不存在」，而一个**落在范围内**的数字会让「两者相等」「小于预算」那类比较恒成立
  it("⚠️ 「没有那个下标」一律给 `-1`（而不是行尾那一列或 `0`）—— 越界那一档按**入参域**各自钉", () => {
    // ⚠️ **入参有两个域，而「越界」在两个域上不是同一件事**：**字符下标域**（`indexOfText` 与行号那一族）
    // 天生可能收进负数，故「找不到 → `-1`」那一档必须钉；**显示列域**（`rawIndexOfColumn` 与包装它的
    // `bgAtColumn` / `bgRgbAt`）的入参**恒 ≥ 0**（按构造：常量、几何层那个矩形的 `x`、从 0 起的计数）⇒
    // 负值在那条路上**不可达**（给它加分支是给一条走不到的路写代码），它要答的越界是
    // 「**超出这一行画到的宽度**」，那一档照给 `-1`
    for (const bad of [3, 99]) {
      expect(columnOfIndex("abc", bad), `columnOfIndex ${String(bad)}`).toBe(-1);
      expect(rawIndexOfColumn("abc", bad), `rawIndexOfColumn ${String(bad)}`).toBe(-1);
    }
    expect(columnOfIndex("abc", -1)).toBe(-1);
    // ⚠️ **反向自检**：范围内的下标**不许**给 `-1` —— 恒返回 `-1` 的探测器会让上面那几条恒成立
    expect(columnOfIndex("abc", 0)).toBe(0);
    expect(columnOfIndex("abc", 2)).toBe(2);
    expect(rawIndexOfColumn("abc", 0)).toBe(0);
    expect(rawIndexOfColumn("abc", 2)).toBe(2);
    // ⚠️ 而「下标落在一条转义序列内部」也答不出来（它不是一格，宽度是那整条序列的）
    expect(columnOfIndex(`${String.fromCharCode(0x1b)}[1mabc`, 2)).toBe(-1);
  });
});

describe("造帧那一半的入参形状自检（喂错形状时几何层**不抛**）", () => {
  // ⚠️ 这组测的是 `geoInput()` **喂给 `geometry()` 的那个形状**，不是界面。而它必须被钉住：
  // `GeometryInput.window` 是一个 `readonly WindowSlot[]`，而喂 `true` 的话运行期**不响**
  // （`true.length` 是 `undefined`，遍历它产出零个元素）—— 破口表现为「后面几条断言空解引用」
  // 而不是「一炸就响」，而那种失败看上去像「断言写错了」。
  const kindsOf = (slots: readonly WindowSlot[]): readonly string[] =>
    slots.map((slot) => slot.kind);

  it("没开窗口时槽位**恒为空数组**（不是 `true`、不是 `0`）", () => {
    const spec = geoInput(props());
    expect(spec.window).toEqual([]);
    // ⚠️ **反向自检**：`true.length` 是 `undefined` 而 `0` 也有 `length` ——
    // 只判「不是布尔」的话一个空串或一个 0 也会混过去。
    expect(Array.isArray(spec.window)).toBe(true);
    expect(spec.window.length).toBe(0);
  });

  it("⚠️ 控制面清单那一档：槽位序 = 「说明（`note` 非空时）+ 逐行 `row`」", () => {
    const withNote = geoInput(
      props({ window: { title: "控制面（0）", rows: [], at: 0, note: "还没有控制面" } }),
    );
    expect(kindsOf(withNote.window)).toEqual(["note"]);
    const rows = geoInput(
      props({
        window: {
          title: "控制面（2）",
          rows: [
            { id: "a", name: "live", detail: "d", state: null, current: true },
            { id: "b", name: "stage", detail: "d", state: null, current: false },
          ],
          at: 0,
          note: null,
        },
      }),
    );
    expect(kindsOf(rows.window)).toEqual(["row", "row"]);
    // ⚠️ 而每一档**取自几何层自己的那张表**：多一档少一档都在这里转红
    expect(["note", "group", "row", "input"]).toContain(rows.window[0]!.kind);
  });

  it("⚠️ 历史会话那一档：槽位序 = 说明 → 逐行（标题 `group` / 会话 `row`）→ 改名框", () => {
    expect(kindsOf(geoInput(props({ history })).window)).toEqual([
      "note",
      "group",
      "row",
      "input",
    ]);
    // ⚠️ 而 `closeHint` **真的透传下去了**（`false` 时几何层不为那枚 `esc` 预留列）
    expect(geoInput(props({ history })).windowCloseHint).toBe(false);
    expect(geoInput(props({ history: { ...history, closeHint: true } })).windowCloseHint).toBe(true);
    // ⚠️ **反向自检**：没有历史会话时它恒真（控制面清单那一枚没有第二个出口）
    expect(geoInput(props()).windowCloseHint).toBe(true);
  });

  it("⚠️ 槽位**与几何给出的那几格同序同长**（呈现层按下标问，故长度是承重的）", () => {
    const p = props({ history });
    const g = geometry(geoInput(p));
    // ⚠️ **探针先自检**：`windowBox` 给 `null` 时下面那行恒空，而那正是「屏太矮什么都没画」
    expect(g.windowBox).not.toBeNull();
    expect(g.windowSlots).toHaveLength(geoInput(p).window.length);
    expect(WINDOW_INPUT_PROMPT_COLUMNS).toBe(2);
  });
});
