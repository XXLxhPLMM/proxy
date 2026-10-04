/**
 * 排版算术：折行按**显示宽度**、截断必须留标记、滚动位置恒以行为单位、摊平后的行数与高度自洽
 *
 * @description
 * 七条不变量里这四条是同一件事的两面 —— **行是怎么被算出来的**（①折行 ②截断 ③滚动 ④自洽），
 * 而 `entry` 那一档管桶、`turn` 那一档管变体。⚠️ ① 与 ② 的判据对象是 `LogRow`（`Turn` 先被
 * `toolTurn` 摊成行），故这一档只经 `./_shared.js` 造数据。
 *
 * ⚠️ **纯 ASCII 的用例对两种度量都成立**：每条折行判据都必须带 CJK 行，否则那条护栏恒绿
 * （`stringWidth` 换成 `ch.length` 照样绿）。
 *
 * 七条不变量与「为什么拆掉哪一处会红」见本目录 `AGENTS.md`。
 *
 * @module tests/log
 */

import { describe, expect, it } from "vitest";
import { clampTop, flatten, visibleLines } from "@/lib/log/index.js";
import { entry, textsOf } from "./_shared.js";

describe("不变量 ①：换行按显示宽度算，不是字符数", () => {
  it("「a中b」宽 2 → 拆成 3 行（按字符数拆只会给 2 行，这一组是判别式）", () => {
    // 逐字符推：'a'(1) 进第一行；'中'(2) 放不进第一行(1+2>2) → 另起；'b'(1) 放不进第二行(2+1>2) → 另起
    expect(textsOf([entry(1, [{ kind: "note", text: "a中b" }])], 2)).toEqual(["a", "中", "b"]);
  });

  it("「中文」宽 3 → 拆成 2 行（字符数度量会说「2 个字放得下」而给 1 行）", () => {
    expect(textsOf([entry(1, [{ kind: "note", text: "中文" }])], 3)).toEqual(["中", "文"]);
  });

  it("「中文」宽 4 → 1 行（对照组：宽度够时两种度量一致，证明上一组不是碰巧）", () => {
    expect(textsOf([entry(1, [{ kind: "note", text: "中文" }])], 4)).toEqual(["中文"]);
  });

  it("散文类（echo / head / note / err）换行，表与键值对不换行", () => {
    const long = "一二三四五六七八九十";
    const wrapped = textsOf([entry(1, [{ kind: "note", text: long }])], 4);
    expect(wrapped.length).toBeGreaterThan(1);

    // 表：表头一行 + 每个数据行一行，**永不换行**（超宽就截断）
    const table = flatten([entry(1, [{ kind: "table", head: ["a"], rows: [[long]] }])], 4);
    expect(table.lines).toHaveLength(2); // 表头 1 行 + 数据 1 行
    // 表头「a」只有 1 列、装得下 → 不标截断；数据行超宽 → 标截断。
    // ⚠️ 断言必须**逐行**分开：写 `every(clipped)` 会因为表头没截断而红，而那不是缺陷。
    expect(table.lines[0]!.clipped).toBe(false);
    expect(table.lines[1]!.clipped).toBe(true);

    // 键值对：恰好一行
    const kv = flatten([entry(1, [{ kind: "kv", key: "k", value: long }])], 4);
    expect(kv.lines).toHaveLength(1);
    expect(kv.lines[0]!.clipped).toBe(true);
  });
});

describe("不变量 ②：截断必须留省略标记（静默截断是本仓点名的失败形状）", () => {
  it("超宽的表行以「…」结尾，且成品宽度不超过给定宽度", () => {
    const flat = flatten(
      [entry(1, [{ kind: "table", head: ["名称", "状态"], rows: [["一二三四五六", "启用"]] }])],
      8,
    );
    // 表头一行 + 数据一行
    expect(flat.lines).toHaveLength(2);
    const data = flat.lines[1]!;
    expect(data.text.endsWith("…")).toBe(true);
    // 宽度上界：截断后不许超（超了就是 Ink 静默软换行，而摊平层以为它只占 1 行 → 滚动全错位）
    expect(displayWidthOf(data.text)).toBeLessThanOrEqual(8);
  });

  it("宽度为 1 时也留标记（不是留空）", () => {
    const flat = flatten([entry(1, [{ kind: "note", text: "abcdef" }])], 1);
    // 散文走换行路径：每段宽 1
    expect(flat.lines.map((l) => l.text)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("宽度为 0 时不炸，且摊出空串（终端被压到 0 列的那一帧）", () => {
    const flat = flatten([entry(1, [{ kind: "table", head: ["x"], rows: [["y"]] }])], 0);
    // 表头 + 数据各一行，都塌成空串（**不是 0 行**：行数由条目结构决定，与宽度无关）
    expect(flat.lines).toHaveLength(2);
    expect(flat.lines.every((l) => l.text === "")).toBe(true);
  });
});

describe("不变量 ③：滚动位置永远以行为单位，且夹在合法范围里", () => {
  it("超过底部 → 停在「最后一行贴住视口底」", () => {
    expect(clampTop(100, 20, 999)).toBe(80);
  });

  it("负数 → 停在 0（能滚到顶）", () => {
    expect(clampTop(100, 20, -5)).toBe(0);
  });

  it("内容装得下 → 归 0（死滚动条：往上滚不出东西、往下也已经到底）", () => {
    expect(clampTop(10, 20, 5)).toBe(0);
  });

  it("NaN → 归到底（一次坏输入不该把滚动位置变成 NaN 并在屏上什么都不显示）", () => {
    expect(clampTop(100, 20, Number.NaN)).toBe(80);
  });

  it("取屏 = 按行切，且行数不足时只给剩下的那些", () => {
    // 宽 4 = 每行 2 个中文字，10 个字 → 5 行
    const flat = flatten([entry(1, [{ kind: "note", text: "一二三四五六七八九十" }])], 4);
    expect(flat.height).toBe(5);
    expect(visibleLines(flat, 0, 2).map((l) => l.text)).toEqual(["一二", "三四"]);
    expect(visibleLines(flat, 1, 2).map((l) => l.text)).toEqual(["三四", "五六"]);
    expect(visibleLines(flat, 4, 2).map((l) => l.text)).toEqual(["九十"]);
    expect(visibleLines(flat, 0, 0)).toHaveLength(0);
  });
});

describe("不变量 ④：摊平的行数与高度永远自洽（不自洽就会滚动错位）", () => {
  it("空日志：没有内容，且与「有内容但全是空行」可区分", () => {
    const empty = flatten([], 40);
    expect(empty.any).toBe(false);
    expect(empty.height).toBe(0);
  });

  it("多条目摊平后 lines.length === height，且每行都带得出它的 entryId", () => {
    const entries = [
      entry(1, [{ kind: "note", text: "第一句" }]),
      entry(2, [
        {
          kind: "table",
          head: ["a", "b"],
          rows: [
            ["1", "2"],
            ["3", "4"],
          ],
        },
      ]),
    ];
    const flat = flatten(entries, 40);
    expect(flat.lines).toHaveLength(flat.height);
    expect(flat.lines.map((l) => l.entryId)).toEqual([1, 2, 2, 2]);
  });

  it("最后一条的每一行都被标成最新（呈现层用它画「↓ 有新内容」）", () => {
    const flat = flatten(
      [entry(1, [{ kind: "note", text: "旧" }]), entry(2, [{ kind: "note", text: "新一二" }])],
      2,
    );
    const newest = flat.lines.filter((l) => l.isNewestEntry);
    expect(newest.length).toBeGreaterThan(0);
    expect(newest.every((l) => l.entryId === 2)).toBe(true);
    expect(flat.lines.filter((l) => l.entryId === 1).every((l) => !l.isNewestEntry)).toBe(true);
  });
});

/** 局部量宽：只在本测试里用来断言「成品宽度不超上界」 */
function displayWidthOf(text: string): number {
  let n = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    n +=
      code >= 0x1100 &&
      (code <= 0x115f ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6))
        ? 2
        : 1;
  }
  return n;
}
