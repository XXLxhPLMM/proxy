/**
 * 时长的人读形态：`duration`（只给两位）与 `uptime`（`null` 与 `0` 不是一回事）。
 *
 * @description
 * ⚠️ 位数**一一对应**（天/小时、小时/分、分/秒）不是审美：看到 `2m` 就要知道秒是 0，而不是「没显示」，
 * 而「3 个月」那种估算比实际精确得多。而 `uptime(null)` → `—` 与 `uptime(0)` → `0s` 必须给两个形状 ——
 * 合并之后「这个进程不持有数据面」与「进程刚起来」在屏上长得一样。
 *
 * 锁什么与「为什么拆掉哪一处会红」见本目录 `AGENTS.md`。
 *
 * @module tests/format
 */

import { describe, expect, it } from "vitest";
import { duration, uptime, EM_DASH } from "@/lib/format.js";

describe("时长：只给两位，位数一一对应", () => {
  it("0 是 0s（不是 0.0s，也不是空）", () => {
    expect(duration(0)).toBe("0s");
  });

  it("秒内给一位小数", () => {
    expect(duration(1500)).toBe("1.5s");
  });

  it("不到一分钟不带分位", () => {
    expect(duration(59_400)).toBe("59.4s");
  });

  it("整分不带秒位（看到 2m 就知道秒是 0，而不是「没显示」）", () => {
    expect(duration(120_000)).toBe("2m");
  });

  it("分秒", () => {
    expect(duration(90_000)).toBe("1m30s");
  });

  it("整小时不带分位", () => {
    expect(duration(3_600_000)).toBe("1h");
  });

  it("时分", () => {
    expect(duration(3_661_000)).toBe("1h1m");
  });

  it("整天不带小时位", () => {
    expect(duration(86_400_000)).toBe("1d");
  });

  it("天时（≥ 1 天不再往下写，否则「3 个月」这种估算会显得比实际精确）", () => {
    expect(duration(90_000_000)).toBe("1d1h");
  });

  it("非法输入抛", () => {
    expect(() => duration(-1)).toThrow(RangeError);
    expect(() => duration(Number.NaN)).toThrow(RangeError);
  });
});

describe("已运行时长：null 与 0 不是一回事", () => {
  it("null → —（这个进程不持有数据面，没有「已运行时长」这个数）", () => {
    expect(uptime(null)).toBe(EM_DASH);
  });

  it("0 → 0s（进程起来了但秒数是零，这是另一件事）", () => {
    expect(uptime(0)).toBe("0s");
  });

  it("非 null 走同一套时长形态", () => {
    expect(uptime(90_000)).toBe("1m30s");
  });
});
