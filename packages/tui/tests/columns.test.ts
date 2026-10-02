/**
 * `@/ui/columns` 的纯函数断言
 *
 * **锁什么**：排版的**三条不变量** —— ①成品行宽不超总宽；②中文按显示宽度算（不是 `String.length`）；
 * ③切了必须**说一声**（`truncated`）。这三条都会以「看起来正常、其实错了」的方式失败，所以必须
 * 逐字钉住。
 *
 * **为什么拆掉哪一处会红**：
 * - `stringWidth` 换成 `String.length` → 「`auto` 列取内容最大值」那组在含中文的行上立刻给出 2
 *   而不是 4，表格在真终端里右边错开一格。**纯 ASCII 的用例对两种度量都成立**，所以那一组必须
 *   带中文行，否则这条护栏是恒绿的。
 * - 「从右往左砍」改成从左往右 → 「左边的身份列先保住」那组红。
 * - `min` 生效那组 → 有人把下限去掉（或者改成 `min - 1`）时红。
 * - 静默截断 → 有人删掉 `truncated` 的置位点时红（本组三条断言都在这一点上交汇）。
 */

import { describe, expect, it } from "vitest";
import { COLUMN_GAP, DEFAULT_MIN, planColumns, type ColumnSpec } from "@/ui/columns.js";
import { widthOf } from "@/ui/format.js";

/** 一行成品（`rows[i].join(gap)` 就是终端上那一行的全文） */
function lineOf(plan: ReturnType<typeof planColumns>, index: number): string {
  return plan.rows[index]?.join(plan.gap) ?? "";
}

describe("不变量 ①：成品行宽不超总宽（Ink 折行是静默的，必须在排版层就掐掉）", () => {
  it("宽度富余时每一行都恰好等于算出的行宽", () => {
    const specs: ColumnSpec[] = [
      { header: "账号", width: 12 },
      { header: "状态", width: 8 },
    ];
    const plan = planColumns(
      specs,
      [
        ["alice", "开"],
        ["bob", "关"],
      ],
      80,
    );
    expect(plan.width).toBe(12 + COLUMN_GAP + 8);
    for (const row of plan.rows) {
      expect(widthOf(row.join(plan.gap))).toBeLessThanOrEqual(80);
    }
    expect(widthOf(lineOf(plan, 0))).toBe(plan.width);
  });

  it("多列挤在窄终端里：从右往左砍，落后的每一行都不超总宽", () => {
    const specs: ColumnSpec[] = [
      { header: "账号" },
      { header: "配额" },
      { header: "已用" },
      { header: "过期" },
    ];
    const plan = planColumns(
      specs,
      [
        ["alice", "1073741824 B", "1.5 GiB", "2026-01-02T03:04:05.000Z"],
        ["一个很长的中文账号名字", "1073741824 B", "1.5 GiB", "永不过期"],
      ],
      46,
    );
    for (const row of plan.rows) {
      expect(widthOf(row.join(plan.gap))).toBeLessThanOrEqual(46);
    }
  });

  it("切到只剩一列时**保留那一列**（一张没有列的表连「有数据」都说不出来）", () => {
    const plan = planColumns(
      [
        { header: "账号", min: 4 },
        { header: "状态", min: 4 },
      ],
      [
        ["alice", "开"],
        ["bob", "关"],
      ],
      3,
    );
    expect(plan.columns).toHaveLength(1);
    expect(plan.rowCount).toBe(2);
    expect(plan.truncated).toBe(true);
  });

  it("单列时 `gap` 是空串（不然行会凭空宽两格）", () => {
    const plan = planColumns([{ header: "账号" }], [["alice"]], 40);
    expect(plan.gap).toBe("");
    expect(plan.width).toBe(widthOf("alice"));
  });

  it("多列时 `gap` 的长度就是 `COLUMN_GAP`（宽度算的那份与拼行的那份不可能是两个值）", () => {
    const plan = planColumns([{ header: "a" }, { header: "b" }], [["x", "y"]], 40);
    expect(plan.gap.length).toBe(COLUMN_GAP);
  });
});

describe("不变量 ②：宽度按显示宽度算，中文 / emoji 不许歪", () => {
  it("⚠️ `auto` 列取内容最大值 —— 含中文的行（这一组就是「不许用 String.length」的全部牙齿）", () => {
    const plan = planColumns(
      [
        { header: "名字", width: "auto" },
        { header: "值", width: "auto" },
      ],
      [
        ["账号", "ab"],
        ["abcd", "中"],
      ],
      60,
    );
    // 「账号」宽 4（length 2），「abcd」宽 4 —— 两种度量下这列都是 4，所以再放一行只有中文的
    expect(plan.columns[0]?.width).toBe(4);
    expect("账号".length).toBe(2);

    const wide = planColumns([{ header: "名字", width: "auto" }], [["账号"]], 60);
    expect(wide.columns[0]?.width).toBe(4);
    // 这一条才是判据：按 length 算的实现会给出 2
    expect(wide.columns[0]?.width).not.toBe("账号".length);
  });

  it("表头比内容宽时 `auto` 取表头（表头被切掉比内容被切掉更糟）", () => {
    const plan = planColumns([{ header: "过期时间", width: "auto" }], [["x"]], 60);
    expect(plan.columns[0]?.width).toBe(8);
  });

  it("emoji 列按显示宽度补齐（😀 宽 2，不是 2 个 length）", () => {
    const plan = planColumns([{ header: "状态", width: 6 }], [["😀"], ["ab"]], 60);
    expect(plan.rows[0]?.[0]).toBe("😀    ");
    expect(widthOf(plan.rows[0]?.[0] ?? "")).toBe(6);
  });

  it("⚠️ 右对齐按显示宽度补**空格**（中文右对齐补错整列就歪）", () => {
    const plan = planColumns([{ header: "用量", width: 10, align: "right" }], [["账号"]], 60);
    expect(plan.rows[0]?.[0]).toBe("      账号");
    expect(widthOf(plan.rows[0]?.[0] ?? "")).toBe(10);
  });
});

describe("不变量 ③：切了必须说一声（`truncated`）", () => {
  it("宽度富余时不置位（一个恒真的标志就是没有标志）", () => {
    const plan = planColumns([{ header: "账号" }], [["alice"]], 80);
    expect(plan.truncated).toBe(false);
  });

  it("内容被切 → 置位，且切出来的那一格自带 `…`（`…` 就是「没显示全」的声明）", () => {
    const plan = planColumns(
      [
        { header: "值", width: 4 },
        { header: "备注", width: 5, max: 5 },
      ],
      [["a", "abcdefghijklmnopqrstuvwxyz"]],
      80,
    );
    expect(plan.truncated).toBe(true);
    expect(plan.rows[0]?.[1]).toBe("abcd…");
    expect(widthOf(plan.rows[0]?.[1] ?? "")).toBe(5);
  });

  it("⚠️ 列被丢掉 → 置位，且 `columnCount` 仍记着原本有几列（界面要能说「另有 N 列未显示」）", () => {
    const plan = planColumns(
      [
        { header: "账号", min: 4 },
        { header: "值", min: 4 },
        { header: "备注", min: 4 },
      ],
      [["a", "b", "c"]],
      11,
    );
    expect(plan.columns.length).toBeLessThan(plan.columnCount);
    expect(plan.truncated).toBe(true);
  });

  it("空行集：零行也报得出行数与列数（空态由界面渲染，这里只保证形状）", () => {
    const plan = planColumns([{ header: "账号" }], [], 60);
    expect(plan.rowCount).toBe(0);
    expect(plan.rows).toEqual([]);
    expect(plan.truncated).toBe(false);
  });

  it("`null` 与**缺格**都渲染成 `—`（一屏只准有一个空形态）", () => {
    const plan = planColumns(
      [
        { header: "账号", width: 6 },
        { header: "到期", width: 6 },
      ],
      [["alice", null], [undefined], ["bob"]],
      60,
    );
    expect(plan.rows[0]?.[1]).toBe("—     ");
    // 短行与显式 undefined 是同一件事：调用方在这一格上没有给出值
    expect(plan.rows[1]?.[1]).toBe("—     ");
    expect(plan.rows[2]?.[1]).toBe("—     ");
    expect(widthOf(plan.rows[2]?.[1] ?? "")).toBe(6);
  });
});

describe("裁剪顺序：先右后左，砍不到 min，固定列是承诺", () => {
  it("⚠️ 空间不足时先砍**右边**（左边的身份列先保住）", () => {
    const plan = planColumns(
      [
        { header: "账号", width: 10, min: 8 },
        { header: "备注", width: "auto", min: 4 },
      ],
      [["alice", "01234567890123456789"]],
      20,
    );
    // gap 2 ⇒ 可用 18：定值的左列原样保住（10），`auto` 的右列从 20 砍到 8（还没到它 4 的下限）
    expect(plan.columns[0]?.width).toBe(10);
    expect(plan.columns[1]?.width).toBe(8);
    expect(plan.truncated).toBe(true);
  });

  it("⚠️ 定值列**不参与收窄**（`width: number` 是一句承诺）", () => {
    const plan = planColumns(
      [
        { header: "状", width: 1 },
        { header: "备注", width: "auto", min: 4 },
      ],
      [["x", "0123456789012345"]],
      10,
    );
    // 缺口 7 全部由右列承担：若定值列也参与收窄，它会先被砍（`min` 缺省 4，本会砍到 4）
    expect(plan.columns[0]?.width).toBe(1);
    expect(plan.columns[1]?.width).toBe(7);
    expect(plan.truncated).toBe(true);
  });

  it("⚠️ 定值列的 `min` 缺省值是 0 而不是 `DEFAULT_MIN`（否则一格宽的字形列会被抬到四格）", () => {
    const plan = planColumns([{ header: "态", width: 1 }], [["●"]], 40);
    expect(plan.columns[0]?.width).toBe(1);
  });

  it("⚠️ `min` 生效：砍到下限就停（每一列都不低于自己的下限）", () => {
    const plan = planColumns(
      [
        { header: "账号", width: "auto", min: 8 },
        { header: "值", width: "auto" },
      ],
      [["一个很长的中文名字", "abcdefghijklmnop"]],
      16,
    );
    // 可用 14：自然宽度 16 + 16 ⇒ 砍 18。右列先让 12（撞上它 4 的下限），左列再让 6
    expect(plan.columns[1]?.width).toBe(DEFAULT_MIN);
    expect(plan.columns[0]?.width).toBe(10);
    expect(plan.truncated).toBe(true);
  });

  it("⚠️ 下限比可用宽度还宽时**丢列**，而不是把列砍到下限以下", () => {
    const plan = planColumns(
      [
        { header: "a", width: "auto", min: 8 },
        { header: "b", width: "auto", min: 6 },
      ],
      [["0123456789", "0123456789"]],
      5,
    );
    expect(plan.columns).toHaveLength(1);
    expect(plan.columns[0]?.width).toBe(8);
    expect(plan.columns[0]?.width).toBeGreaterThanOrEqual(8);
    expect(plan.truncated).toBe(true);
  });

  it("`flex` 列吃掉剩余宽度，且撞上 `max` 的那部分留成右边空白", () => {
    const grown = planColumns(
      [
        { header: "账号", width: 8 },
        { header: "备注", width: "flex", min: 4, max: 12 },
      ],
      [["alice", "x"]],
      60,
    );
    expect(grown.columns[1]?.width).toBe(12);
    expect(grown.width).toBe(8 + COLUMN_GAP + 12);

    const multiple = planColumns(
      [
        { header: "a", width: "flex", min: 1 },
        { header: "b", width: "flex", min: 1 },
      ],
      [["x", "y"]],
      11,
    );
    // gap 2 ⇒ 可用 9，余数给最左边那一列（分配必须是确定的）
    expect(multiple.columns[0]?.width).toBe(5);
    expect(multiple.columns[1]?.width).toBe(4);
  });

  it("`max` 对 `auto` 也生效（不受 max 约束的列会把整表撑爆）", () => {
    const plan = planColumns(
      [
        { header: "账号", width: "auto", max: 6 },
        { header: "值", width: 4 },
      ],
      [["一个非常长的中文账号名字", "abcd"]],
      60,
    );
    expect(plan.columns[0]?.width).toBe(6);
    expect(plan.truncated).toBe(true);
  });
});
