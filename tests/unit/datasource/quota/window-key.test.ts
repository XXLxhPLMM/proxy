/**
 * `windowKey`：这条用量属于哪个窗口（注入 `now`，确定性断言，不依赖「今天大概是几号」）
 *
 * @description
 * 主题级不变量与变异表归同目录 `AGENTS.md`（本目录只放「这一档管哪一段 + 指向 `AGENTS.md`」）。
 * 本档只答**键怎么算**：day / month 两档的边界、本地时区语义与 DST 的近似取舍、`shiftHours` 的
 * 定义域夹取，以及消费侧的缺省归一。
 * 「跨窗口时账本怎么办」（惰性滚动清账、旧用量不继承、槽位规模）在 `window-rollover.test.ts`。
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUOTA_WINDOW,
  quotaWindow,
  windowKey,
} from "@/datasource/quota/index.js";

const HOUR = 3_600_000;

describe("@/datasource/quota windowKey：day 窗口的边界（注入 now，不依赖真实时钟）", () => {
  // 本地构造（`new Date(y, m, d, …)`）保证「几点」与时区无关地落在那天/那刻
  const day = (y: number, m: number, d: number, h: number, mi = 0, s = 0, ms = 0): number =>
    new Date(y, m - 1, d, h, mi, s, ms).getTime();

  it("resetHour=0：当日 00:00:00 属当日窗口，23:59:59.999 仍属当日", () => {
    expect(windowKey(day(2026, 3, 15, 0, 0, 0, 0), "day", 0)).toBe("2026-03-15");
    expect(windowKey(day(2026, 3, 15, 23, 59, 59, 999), "day", 0)).toBe("2026-03-15");
    // 切换点是紧接其后的那一毫秒
    expect(windowKey(day(2026, 3, 16, 0, 0, 0, 0), "day", 0)).toBe("2026-03-16");
  });

  it("resetHour=3：01:00 属前一日窗口，03:00 属当日（'先减 shiftHours 再取本地字段'）", () => {
    // 减 3 小时落到前一天 22:00 → 还是昨天的账
    expect(windowKey(day(2026, 3, 15, 1), "day", 3)).toBe("2026-03-14");
    expect(windowKey(day(2026, 3, 15, 2, 59, 59, 999), "day", 3)).toBe("2026-03-14");
    // 减 3 小时恰好落在当天 00:00 → 翻页
    expect(windowKey(day(2026, 3, 15, 3), "day", 3)).toBe("2026-03-15");
    expect(windowKey(day(2026, 3, 15, 23, 59, 59, 999), "day", 3)).toBe("2026-03-15");
    expect(windowKey(day(2026, 3, 16, 2, 59, 59, 999), "day", 3)).toBe("2026-03-15");
  });

  it("跨月边界：resetHour=3 时 4/1 凌晨 02:59 仍属 3 月，03:00 才进 4 月", () => {
    expect(windowKey(day(2026, 3, 31, 23, 59, 59, 999), "day", 3)).toBe("2026-03-31");
    expect(windowKey(day(2026, 4, 1, 0), "day", 3)).toBe("2026-03-31");
    expect(windowKey(day(2026, 4, 1, 2, 59, 59, 999), "day", 3)).toBe("2026-03-31");
    expect(windowKey(day(2026, 4, 1, 3), "day", 3)).toBe("2026-04-01");
  });

  it("跨年边界：resetHour=0 时 12/31 末属去年，1/1 零晨进新年", () => {
    expect(windowKey(day(2025, 12, 31, 23, 59, 59, 999), "day", 0)).toBe("2025-12-31");
    expect(windowKey(day(2026, 1, 1, 0, 0, 0, 0), "day", 0)).toBe("2026-01-01");
    // resetHour=3 的跨年形态：1/1 凌晨 1 点还挂在 2025-12-31 那本账上
    expect(windowKey(day(2026, 1, 1, 1), "day", 3)).toBe("2025-12-31");
    expect(windowKey(day(2026, 1, 1, 3), "day", 3)).toBe("2026-01-01");
  });

  it("闰年 2/29：resetHour=0 下 2/28→2/29→3/01 三个键都不同（手工进位最容易在这里错）", () => {
    expect(windowKey(day(2028, 2, 28, 12), "day", 0)).toBe("2028-02-28");
    expect(windowKey(day(2028, 2, 29, 12), "day", 0)).toBe("2028-02-29");
    expect(windowKey(day(2028, 3, 1, 0, 0, 0, 0), "day", 0)).toBe("2028-03-01");
  });

  it("resetHour=23：22:00 属前一日，次日 00:00 仍属前一日（反向形态）", () => {
    expect(windowKey(day(2026, 3, 15, 22), "day", 23)).toBe("2026-03-14");
    expect(windowKey(day(2026, 3, 15, 23), "day", 23)).toBe("2026-03-15");
    // 次日 00:00 减 23 小时仍落在 15 日 → 翻页要到 15 日 23:00 之后
    expect(windowKey(day(2026, 3, 16, 0, 0, 0, 0), "day", 23)).toBe("2026-03-15");
    expect(windowKey(day(2026, 3, 16, 22, 59, 59, 999), "day", 23)).toBe("2026-03-15");
    expect(windowKey(day(2026, 3, 16, 23), "day", 23)).toBe("2026-03-16");
  });

  it("键是零补零的定长形态（否则 '2026-3-5' 与 '2026-03-05' 会是两个键）", () => {
    expect(windowKey(day(2026, 3, 5, 12), "day", 0)).toBe("2026-03-05");
    expect(windowKey(day(2026, 11, 9, 12), "day", 0)).toBe("2026-11-09");
    expect(windowKey(day(2026, 3, 5, 12), "month", 0)).toBe("2026-03");
  });
});

describe("@/datasource/quota windowKey：month 窗口的边界", () => {
  const day = (y: number, m: number, d: number, h: number, mi = 0, s = 0, ms = 0): number =>
    new Date(y, m - 1, d, h, mi, s, ms).getTime();

  it("resetHour=0：整月同一键，跨月那一刻换键", () => {
    expect(windowKey(day(2026, 3, 1, 0, 0, 0, 0), "month", 0)).toBe("2026-03");
    expect(windowKey(day(2026, 3, 31, 23, 59, 59, 999), "month", 0)).toBe("2026-03");
    expect(windowKey(day(2026, 4, 1, 0, 0, 0, 0), "month", 0)).toBe("2026-04");
  });

  it("resetHour=3：月内 03:00 之前仍属上个月，跨年同理", () => {
    expect(windowKey(day(2026, 4, 1, 2, 59, 59, 999), "month", 3)).toBe("2026-03");
    expect(windowKey(day(2026, 4, 1, 3), "month", 3)).toBe("2026-04");
    expect(windowKey(day(2026, 1, 1, 2, 59, 59, 999), "month", 3)).toBe("2025-12");
    expect(windowKey(day(2026, 1, 1, 3), "month", 3)).toBe("2026-01");
  });

  it("resetHour=0 的跨年：12 月与 1 月是两个键，且不会退回上一年的 12 月", () => {
    expect(windowKey(day(2025, 12, 5, 12), "month", 0)).toBe("2025-12");
    expect(windowKey(day(2026, 1, 5, 12), "month", 0)).toBe("2026-01");
  });
});

describe("@/datasource/quota windowKey：本地时区语义与 DST 取舍", () => {
  it("键取**本地**日历字段而不是 toISOString（判别只在时区偏移够大的机器上成立）", () => {
    // 先找一个「本地日期 ≠ UTC 日期」的时刻：只有这种时刻才**能**判别两种写法。
    // 本机偏移小到 UTC±11 以内时，任何本地时刻换算到 UTC 都还是同一天（例如 UTC+8 的
    // 本地正午换过去仍是 15 日），此时这条只锁住「键 = 本地日历日」这一半语义 ——
    // 判别不了的就**不假装**判别。
    let discriminated: number | undefined;
    for (let minutes = 0; minutes < 24 * 60; minutes += 5) {
      const t = new Date(2026, 2, 15, 0, minutes, 0).getTime();
      if (new Date(t).toISOString().slice(0, 10) !== "2026-03-15") {
        discriminated = t;
        break;
      }
    }
    if (discriminated !== undefined) {
      expect(windowKey(discriminated, "day", 0)).toBe("2026-03-15");
      expect(windowKey(discriminated, "day", 0)).not.toBe(
        new Date(discriminated).toISOString().slice(0, 10),
      );
    } else {
      expect(windowKey(new Date(2026, 2, 15, 0, 30).getTime(), "day", 0)).toBe("2026-03-15");
    }
  });

  it("DST 边界是**近似**：窗口切换点必落在本地午夜 ±1 小时（跨夏令时的机器也成立）", () => {
    // 逐小时走 48 小时，必定覆盖任何一次夏令时切换（哪怕本机 TZ 根本没有夏令时）。
    // 契约：切换那一刻的「减 shiftHours 后的本地时刻」必须贴近午夜 —— 不贴到 00:00 就是
    // 夏令时把午夜本身挪了 ±1 小时，正是文件头声明的近似（手工做日历进位同样躲不掉）。
    let previous = "";
    for (let i = 0; i <= 48; i++) {
      const t = new Date(2026, 5, 10, 0, 0, 0).getTime() + i * HOUR;
      const key = windowKey(t, "day", 3);
      if (previous !== "" && key !== previous) {
        const localHour = new Date(t - 3 * HOUR).getHours();
        expect([0, 1, 23], `切换点的本地小时应贴近午夜，实际 ${String(localHour)}`).toContain(
          localHour,
        );
      }
      // 键随时间单调不减（窗口只会向前走）
      expect(key >= previous).toBe(true);
      previous = key;
    }
  });

  it("resetHour=0 时切换点精确落在本地午夜（无 shift 时不存在 DST 偏移）", () => {
    let previous = windowKey(new Date(2026, 5, 10, 0, 0, 0).getTime(), "day", 0);
    for (let i = 1; i <= 48; i++) {
      const t = new Date(2026, 5, 10, 0, 0, 0).getTime() + i * HOUR;
      const key = windowKey(t, "day", 0);
      if (key !== previous) {
        // 逐小时步进，切换点前一小时必然仍是旧键 → 切换发生在本地 00:00 整
        expect(new Date(t - HOUR).getHours()).toBe(23);
        expect(new Date(t).getHours()).toBe(0);
      }
      previous = key;
    }
  });
});

describe("@/datasource/quota quotaWindow：缺省 month（消费侧归一，不污染配置产物）", () => {
  it("未配置 → month；显式 day/month 原样", () => {
    expect(DEFAULT_QUOTA_WINDOW).toBe("month");
    expect(quotaWindow(undefined)).toBe("month");
    expect(quotaWindow("day")).toBe("day");
    expect(quotaWindow("month")).toBe("month");
  });
});

describe("@/datasource/quota windowKey：shiftHours 夹取到 [0,23]（5b-2）", () => {
  const day = (y: number, m: number, d: number, h: number): number =>
    new Date(y, m - 1, d, h, 0, 0, 0).getTime();

  it("非有限值夹成 0（等价 FIELDS 缺省），绝不产出 NaN-NaN-NaN 畸形键", () => {
    // 库调用方可以绕过 `loadConfig`：`createProxyRuntime({ config })` 走 `ConfigStore`，
    // 而 `ConfigStore` **零校验**（不跑 FIELDS 的范围校验）。所以「配置层保证 0..23」
    // 这条前置条件对库路径**不成立**，窗口键必须自己守住定义域。
    // 畸形键的代价是具体的：它会进恢复结果的 `windowKey` 并参与判定。
    const t = day(2026, 3, 15, 12);
    const midnight = windowKey(t, "day", 0);
    for (const hostile of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(windowKey(t, "day", hostile)).toBe(midnight);
      expect(windowKey(t, "day", hostile)).not.toContain("NaN");
      expect(windowKey(t, "month", hostile)).toBe(windowKey(t, "month", 0));
    }
  });

  it("越界值夹到定义域两端：小数截断、负数夹 0、>23 夹 23", () => {
    const t = day(2026, 3, 15, 12);
    // 小数截断（3.7 → 3，-0.5 → 0）
    expect(windowKey(t, "day", 3.7)).toBe(windowKey(t, "day", 3));
    expect(windowKey(t, "day", -0.5)).toBe(windowKey(t, "day", 0));
    // 负数夹 0
    expect(windowKey(t, "day", -1)).toBe(windowKey(t, "day", 0));
    expect(windowKey(t, "day", -999)).toBe(windowKey(t, "day", 0));
    // >23 夹 23（与 resetHour=23 逐字一致）
    expect(windowKey(t, "day", 24)).toBe(windowKey(t, "day", 23));
    expect(windowKey(t, "day", 1e9)).toBe(windowKey(t, "day", 23));
    expect(windowKey(t, "month", 24)).toBe(windowKey(t, "month", 23));
  });

  it("夹取之后键仍是合法的定长日历形状（不留残缺形态）", () => {
    const t = day(2026, 3, 15, 12);
    for (const hostile of [Number.NaN, 24, 99, -1, 3.7, 1e9]) {
      expect(windowKey(t, "day", hostile)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(windowKey(t, "month", hostile)).toMatch(/^\d{4}-\d{2}$/);
    }
  });
});
