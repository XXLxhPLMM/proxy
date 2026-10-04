/**
 * 宽度不够时砍谁、砍到哪、砍了说不说：裁剪顺序（先右后左、砍不到 `min`、定值列是承诺）+ `truncated`。
 *
 * 锁什么与「为什么拆掉哪一处会红」见本目录 `AGENTS.md`；行宽与显示宽度那一半在
 * `tests/columns/width.test.ts`。
 *
 * @module tests/columns
 */

import { describe, expect, it } from "vitest";
import { COLUMN_GAP, DEFAULT_MIN, planColumns } from "@/lib/columns.js";
import { widthOf } from "@/lib/format.js";

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
