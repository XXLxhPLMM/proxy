/**
 * 量出来的宽度对不对：成品行宽不超总宽 + 宽度按显示宽度算（中文 / emoji 不许歪）。
 *
 * 锁什么与「为什么拆掉哪一处会红」见本目录 `AGENTS.md`；裁剪策略与 `truncated` 在
 * `tests/columns/trim.test.ts`。
 *
 * @module tests/columns
 */

import { describe, expect, it } from "vitest";
import { COLUMN_GAP, planColumns, type ColumnSpec } from "@/lib/columns.js";
import { widthOf } from "@/lib/format.js";

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
