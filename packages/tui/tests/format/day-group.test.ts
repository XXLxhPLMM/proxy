/**
 * 按天数分组的人读形态：`dayGroupLabel`（`今天` / `昨天` / `N 天前` / 一个具体日期）
 *
 * @description
 * ⚠️ **判据是「本地日历日」而不是「24 小时当天数」**：拿 24 小时算的话，跨月那几档与跨夏令时那几档
 * 会整整差一天 —— 而症状是「昨天那个会话出现在『今天』那一组里」，操作者分不出「我记错了日期」
 * 与「界面算错了日期」。
 * ⚠️ **时刻一律按本地日历构造**（`new Date(y, m, d, …)`）：本层的判据本来就是本地日历日，
 * 拿 `Date.UTC` 构造就等于换了一个时区去测它。
 *
 * 锁什么与「为什么拆掉哪一处会红」见本目录 `AGENTS.md`。
 *
 * @module tests/format
 */

import { describe, expect, it } from "vitest";

import { dayGroupLabel } from "@/lib/format.js";

/** 本地日历日的一个正午（⚠️ 正午避开了「跨过午夜」与「夏令时切换」那两个钟点） */
function noon(year: number, month: number, day: number): number {
  return new Date(year, month, day, 12, 0, 0, 0).getTime();
}

/** `YYYY-MM-DD`（期望值手算，不抄被测对象那份换算） */
function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

describe("按天数分组：四档，判据是**本地日历日**", () => {
  const now = noon(2026, 2, 2);   // 2026-03-02

  it("今天 / 昨天 / N 天前 / 一个具体日期，四档各一条", () => {
    expect(dayGroupLabel(noon(2026, 2, 2), now)).toBe("今天");
    expect(dayGroupLabel(noon(2026, 2, 1), now)).toBe("昨天");
    // 2026-02-28 → 2026-03-02 是 **2** 个日历日（28 → 1 → 2）
    expect(dayGroupLabel(noon(2026, 1, 28), now)).toBe("2 天前");
    // ⚠️ ≥ 30 天 ⇒ **一个具体日期**，而那个日期必须与那个时刻的日历日逐字相等
    expect(dayGroupLabel(noon(2026, 0, 5), now)).toBe(iso(2026, 0, 5));
  });

  it("⚠️ **跨月那一档**：上个月的那个时刻按日历日算，而不是掉进「具体日期」那一档", () => {
    // 2026-02-27 → 2026-03-02 是 **3** 个日历日（27 → 28 → 1 → 2），故标题是「3 天前」。
    // ⚠️ 月长不齐（2 月 28 天、3 月 31 天）⇒ 「上个月」**不等于**「30 天前」，
    // 那正是这一档单独存在的理由：按 24 小时算它在 2 月会差出一天。
    expect(dayGroupLabel(noon(2026, 1, 27), now)).toBe("3 天前");
    expect(dayGroupLabel(noon(2026, 1, 27), now)).not.toBe(iso(2026, 1, 27));
    // ⚠️ **反向自检**：同一个时刻在两个 `now` 上给**两个不同的档**（27 天 / 30 天）——
    // 否则「跨月那一档」恒成立，而那一档正是本档存在的理由
    const earlier = noon(2026, 1, 3);   // 2026-02-03
    expect(dayGroupLabel(earlier, now)).toBe("27 天前");
    expect(dayGroupLabel(earlier, noon(2026, 2, 5))).toBe(iso(2026, 1, 3));
  });

  it("⚠️ 30 天那道分界**落在跨月那一档上**（同一个时刻，`now` 差一天就换档）", () => {
    const at = noon(2026, 2, 3);   // 2026-03-03
    // 2026-03-03 → 2026-04-01 是 29 天 ⇒ 还在「N 天前」那一档
    expect(dayGroupLabel(at, noon(2026, 3, 1))).toBe("29 天前");
    // ⚠️ 而 `now` 再晚一天就是 **30** 天 ⇒ 越过那道分界，给一个具体日期（跨了 3 月 → 4 月）
    expect(dayGroupLabel(at, noon(2026, 3, 2))).toBe(iso(2026, 2, 3));
  });

  it("⚠️ **只差一个钟点而跨了午夜** ⇒ 「昨天」而不是「今天」（这一条就是「不许拿 24 小时当天数」）", () => {
    // 2026-02-28 23:30 → 2026-03-01 00:30 只差 **1 小时**，而日历日是**跨了一天**
    const late = new Date(2026, 1, 28, 23, 30, 0, 0).getTime();
    const early = new Date(2026, 2, 1, 0, 30, 0, 0).getTime();
    // ⚠️ **正向对照**：两个时刻**同一分钟**时标题相同（否则下面那条会被「差一小时」蒙过去）
    expect(dayGroupLabel(new Date(2026, 2, 1, 12, 0, 0).getTime(), early)).toBe("今天");
    expect(dayGroupLabel(late, early)).toBe("昨天");
    expect(early - late).toBe(60 * 60 * 1000);
  });

  it("时刻在 `now` 之后归「今天」（负的天数不许变成「-1 天前」）", () => {
    expect(dayGroupLabel(noon(2026, 2, 5), now)).toBe("今天");
    expect(dayGroupLabel(now, now)).toBe("今天");
  });

  it("非法输入抛（与本层其余换算同一条纪律）", () => {
    expect(() => dayGroupLabel(-1, now)).toThrow(RangeError);
    expect(() => dayGroupLabel(now, -1)).toThrow(RangeError);
  });
});
