/**
 * 配额窗口（Phase 5b-1）：窗口键计算 + 窗口化的内存账本
 *
 * @description
 * 5a 的 `unit/traffic-account.test.ts` 答的是「**判定本身**对不对」；本文件答的是
 * 「**这条用量属于哪个窗口**」以及「**跨窗口时账本怎么办**」：
 *
 * 1. **`windowKey` 的边界**（注入的 `now`，确定性断言，不依赖「今天大概是几号」）：
 *    `resetHour=0` 的日首/日末、`resetHour=3` 的「01:00 仍属前一日」「03:00 属当日」、
 *    跨月、跨年、`resetHour=23` 的反向形态、`month` 窗口的同类边界。
 * 2. **本地时区语义**（不是 `toISOString`）+ **DST 边界是近似**（切换点必在本地午夜 ±1h 内）。
 * 3. **窗口滚动清账**：`now` 推过边界后同一用户 `usage` 归零、`consume` 重新计数，
 *    **旧用量绝不继承**。
 * 4. **窗口类型来自 `quota.window`**：按用户独立生效，缺省 `month`。
 * 5. **账本规模有界**（同一用户重复读不产生新槽位）+ **不删槽位**（不许加猜测性淘汰）。
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUOTA_WINDOW,
  MemoryTrafficAccount,
  createMemoryTrafficAccount,
  quotaWindow,
  windowKey,
  type TrafficAccount,
  type UserQuota,
} from "@/core/traffic/index.js";
import { codeOf, sourceOf } from "../helpers/source-scan.js";

const HOUR = 3_600_000;

/** 造一个「时刻可推进」的账本：`at(t)` 把时钟拨到 t，返回该账本。 */
function accountAt(
  start: number,
  quotas: Record<string, UserQuota> = {},
  resetHour = 0,
): { account: MemoryTrafficAccount; at: (t: number) => MemoryTrafficAccount } {
  let now = start;
  const account = createMemoryTrafficAccount(
    (user: string) => quotas[user],
    { resetHour: () => resetHour, now: () => now },
  ) as MemoryTrafficAccount;
  return { account, at: (t: number) => ((now = t), account) };
}

describe("core/traffic windowKey：day 窗口的边界（注入 now，不依赖真实时钟）", () => {
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

describe("core/traffic windowKey：month 窗口的边界", () => {
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

describe("core/traffic windowKey：本地时区语义与 DST 取舍", () => {
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

describe("core/traffic quotaWindow：缺省 month（消费侧归一，不污染配置产物）", () => {
  it("未配置 → month；显式 day/month 原样", () => {
    expect(DEFAULT_QUOTA_WINDOW).toBe("month");
    expect(quotaWindow(undefined)).toBe("month");
    expect(quotaWindow("day")).toBe("day");
    expect(quotaWindow("month")).toBe("month");
  });
});

describe("core/traffic windowKey：shiftHours 夹取到 [0,23]（5b-2）", () => {
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

describe("core/traffic 窗口滚动清账（惰性，不继承旧用量）", () => {
  const day = (y: number, m: number, d: number, h: number, mi = 0): number =>
    new Date(y, m - 1, d, h, mi, 0, 0).getTime();

  /** 显式写死 window 的配额替身（默认 month，所以要滚 day 窗口的用例必须显式写 day） */
  const withWindow = (
    window: "day" | "month",
    rest: Partial<UserQuota> = {},
  ): UserQuota => ({ bytesUp: 0, bytesDown: 0, bytesTotal: 0, window, ...rest });

  it("day 窗口：把 now 推过边界 → usage 归零、consume 重新从 0 计数，旧用量不继承", () => {
    const { account, at } = accountAt(
      day(2026, 3, 15, 1),
      { alice: withWindow("day", { bytesTotal: 10 }) },
      3,
    );
    at(day(2026, 3, 15, 1));
    account.consume("alice", "up", 7);
    account.consume("alice", "down", 3);
    expect(account.usage("alice")).toEqual({ up: 7, down: 3 });
    // 撞顶：10 字节上限已用满（累计值照实不截断，故此刻 up 已是 8）
    expect(account.consume("alice", "up", 1).allow).toBe(false);
    expect(account.usage("alice")).toEqual({ up: 8, down: 3 });

    // 推过 03:00 → 新窗口。**旧用量绝不继承**：归零而不是把 8+3 搬到新账上
    at(day(2026, 3, 15, 3));
    expect(account.usage("alice")).toEqual({ up: 0, down: 0 });
    // 上一窗口的耗尽状态也一并解除（新窗口给了完整额度）
    expect(account.consume("alice", "up", 10).allow).toBe(true);
    expect(account.usage("alice")).toEqual({ up: 10, down: 0 });
    expect(account.consume("alice", "up", 1).allow).toBe(false);
  });

  it("usage 自身也会滚动：不调 consume、只读一次用量就已归零", () => {
    // 「滚动即清账」的实现点是**每次访问槽位**（consume 与 usage 共用 slotFor），
    // 所以只读不写也必须清 —— 否则「只查不用」的调用方会读到上一窗口的旧账。
    const { account, at } = accountAt(day(2026, 3, 15, 10), { alice: withWindow("day") }, 0);
    at(day(2026, 3, 15, 10));
    account.consume("alice", "down", 500);
    expect(account.usage("alice")).toEqual({ up: 0, down: 500 });
    at(day(2026, 3, 16, 0, 1));
    expect(account.usage("alice")).toEqual({ up: 0, down: 0 });
    // 槽位仍在（清账 ≠ 除名）：用户还是「计量过」的
    expect(account.size).toBe(1);
  });

  it("month 窗口：跨月才归零，resetHour=3 时 4/1 凌晨 03:00 之前仍属 3 月", () => {
    const quotas: Record<string, UserQuota> = { alice: withWindow("month") };
    const { account, at } = accountAt(day(2026, 3, 20, 12), quotas, 3);
    at(day(2026, 3, 20, 12));
    account.consume("alice", "up", 111);
    at(day(2026, 3, 31, 23, 59));
    expect(account.usage("alice")).toEqual({ up: 111, down: 0 });
    at(day(2026, 4, 1, 2, 59));
    expect(account.usage("alice")).toEqual({ up: 111, down: 0 });
    at(day(2026, 4, 1, 3));
    expect(account.usage("alice")).toEqual({ up: 0, down: 0 });
  });

  it("窗口类型按用户独立生效：同一时刻 alice(day) 翻页而 bob(month) 不翻", () => {
    const quotas: Record<string, UserQuota> = {
      alice: withWindow("day"),
      bob: withWindow("month"),
    };
    const { account, at } = accountAt(day(2026, 3, 15, 23), quotas, 0);
    at(day(2026, 3, 15, 23));
    account.consume("alice", "up", 10);
    account.consume("bob", "up", 10);
    at(day(2026, 3, 16, 0, 1));
    expect(account.usage("alice")).toEqual({ up: 0, down: 0 });
    expect(account.usage("bob")).toEqual({ up: 10, down: 0 });
    // 时钟回拨也不「复活」旧账：窗口键是「时刻 → 窗口」的纯映射，键一变就是新账
    at(day(2026, 3, 15, 23));
    expect(account.usage("alice")).toEqual({ up: 0, down: 0 });
    expect(account.usage("bob")).toEqual({ up: 10, down: 0 });
  });

  it("未配 quota 的用户同样按缺省 month 记窗口（没有上限 ≠ 不计量）", () => {
    const { account, at } = accountAt(day(2026, 3, 31, 23), {}, 0);
    at(day(2026, 3, 31, 23));
    account.consume("ghost", "down", 42);
    at(day(2026, 3, 31, 23, 30));
    expect(account.usage("ghost")).toEqual({ up: 0, down: 42 });
    at(day(2026, 4, 1, 0, 1));
    expect(account.usage("ghost")).toEqual({ up: 0, down: 0 });
  });

  it("热改 resetHour 即时改变窗口边界（现读，不必重建账本）", () => {
    let resetHour = 0;
    let now = day(2026, 3, 15, 1);
    const account = new MemoryTrafficAccount(
      (user: string) => (user === "alice" ? withWindow("day") : undefined),
      { resetHour: () => resetHour, now: () => now },
    );
    account.consume("alice", "up", 5);
    expect(account.usage("alice")).toEqual({ up: 5, down: 0 });
    // 把重置点从 0 点挪到 3 点：此刻（15 日 01:00）已属于 14 日那本账 → 归零
    resetHour = 3;
    now = day(2026, 3, 15, 1);
    expect(account.usage("alice")).toEqual({ up: 0, down: 0 });
    // 再挪回去 → 回到 15 日那本账（仍是 0，因为上一次滚动已清零）
    resetHour = 0;
    expect(account.usage("alice")).toEqual({ up: 0, down: 0 });
  });
});

describe("core/traffic 账本规模有界，且不靠猜测性淘汰", () => {
  const day = (y: number, m: number, d: number, h: number, mi = 0): number =>
    new Date(y, m - 1, d, h, mi, 0, 0).getTime();
  const withWindow = (window: "day" | "month"): UserQuota => ({
    bytesUp: 0,
    bytesDown: 0,
    bytesTotal: 0,
    window,
  });

  it("同一用户在窗口内重复读/写不产生新槽位（滚动不新增、只替换）", () => {
    const { account, at } = accountAt(
      day(2026, 3, 15, 0),
      { alice: withWindow("day") },
      0,
    );
    at(day(2026, 3, 15, 0));
    account.consume("alice", "up", 1);
    expect(account.size).toBe(1);
    for (let i = 0; i < 500; i++) {
      account.consume("alice", "down", 1);
      account.usage("alice");
    }
    expect(account.size).toBe(1);
    // 跨窗：槽位被**替换**而不是新增
    at(day(2026, 3, 16, 0, 1));
    account.consume("alice", "up", 1);
    expect(account.size).toBe(1);
    expect(account.usage("alice")).toEqual({ up: 1, down: 0 });
  });

  it("查询一个从未计量过的用户不建槽（读一次不该凭空长出槽位）", () => {
    const { account } = accountAt(day(2026, 3, 15, 0), {}, 0);
    expect(account.usage("nobody")).toEqual({ up: 0, down: 0 });
    expect(account.usage("")).toEqual({ up: 0, down: 0 });
    expect(account.size).toBe(0);
  });

  it("本文件不删槽位、不引入 LRU/容量上限（淘汰必须与配额窗口一起设计）", () => {
    // 源码级：窗口滚动只**替换**槽位（滚动即清账），从不删除。
    // 谁想加 LRU，必须先改这条护栏并说明淘汰语义 —— 因为被淘汰的用户会拿到一份清零的账，
    // 那等于凭空多出一份额度，比不淘汰更糟。
    const code = codeOf("core", "traffic", "memory.ts");
    expect(code).not.toMatch(/\.delete\(/);
    expect(code).not.toMatch(/\bLRU\b|\blru\b|maxEntries|evict/i);
  });

  it("已知限制如实记录在文件头：jwt 的 sub 可无限增长，压缩留给 5b-2 落盘", () => {
    // 限制**没有被解决**（5b-1 只做窗口语义），但必须留在文件头免得被当成「没想过」。
    // 注意这条断言读的是**原文**（含注释）：文档本身也是契约的一部分。
    const header = sourceOf("core", "traffic", "memory.ts");
    expect(header).toContain("jwt");
    expect(header).toContain("5b-2");
    // 行为侧对应：槽位数只随「计量过的用户数」增长，不随窗口数增长
    const { account, at } = accountAt(day(2026, 3, 1, 0), {}, 0);
    for (let d = 1; d <= 28; d++) {
      at(day(2026, 3, d, 0, 1));
      account.consume(`sub-${d}`, "up", 1);
    }
    expect(account.size).toBe(28);
  });
});

describe("core/traffic 计量口径在窗口下依然逐字节精确", () => {
  it("窗口内 usage 逐块累加精确（滚动不引入误差）", () => {
    let now = new Date(2026, 2, 15, 0, 0, 0).getTime();
    const account: TrafficAccount = createMemoryTrafficAccount(
      () => ({ bytesUp: 0, bytesDown: 0, bytesTotal: 0, window: "day" }),
      { resetHour: () => 0, now: () => now },
    );
    for (let i = 1; i <= 100; i++) {
      account.consume("alice", "up", 16 * 1024);
      expect(account.usage("alice").up).toBe(i * 16 * 1024);
    }
    // 跳到下一天：清零后重新精确计数
    now = new Date(2026, 2, 16, 0, 0, 1).getTime();
    account.consume("alice", "up", 7);
    expect(account.usage("alice")).toEqual({ up: 7, down: 0 });
  });
});
