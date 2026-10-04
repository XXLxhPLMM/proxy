/**
 * 一个数量的人读形态：`bytes`（1024 进制 + 边界）与 `percent`（占比）。
 *
 * @description
 * ⚠️ 两条共用的纪律是**边界必须诚实**：`0` 是一个合法值（不限流也得有个能显示的形态，而 `percent` 把
 * 分母 0 解成「无限」而不是 `NaN`），而非法输入**抛**而不是原样回显 —— 显示成 `NaN` 或负字节就是拿
 * 假事实换掉了界面。进位点一并钉住：不写假精度（`1 GiB` 就显示 `1 GiB`）。
 *
 * 锁什么与「为什么拆掉哪一处会红」见本目录 `AGENTS.md`。
 *
 * @module tests/format
 */

import { describe, expect, it } from "vitest";
import { bytes, percent, UNLIMITED } from "@/lib/format.js";

describe("字节数：1024 进制 + 边界", () => {
  it("0 是合法值（「不限流」也要有个能显示的字节形态）", () => {
    expect(bytes(0)).toBe("0 B");
  });

  it("1023 仍是字节（不到 1024 不许进位）", () => {
    expect(bytes(1023)).toBe("1023 B");
  });

  it("1024 恰好进位到 KiB", () => {
    expect(bytes(1024)).toBe("1 KiB");
  });

  it("1536 → 一位小数", () => {
    expect(bytes(1536)).toBe("1.5 KiB");
  });

  it("不写假精度（1.0 GiB 会让一列多两位，而 1 GiB 就是 1 GiB）", () => {
    expect(bytes(1024 ** 3)).toBe("1 GiB");
  });

  it("每档的进位点都对（字节 → KiB → MiB → GiB）", () => {
    expect(bytes(1024 ** 2)).toBe("1 MiB");
    expect(bytes(1024 ** 4)).toBe("1 TiB");
    expect(bytes(1536 * 1024)).toBe("1.5 MiB");
  });

  it("非法输入抛而不是原样回显（NaN 显示成数字就是用假事实换掉了界面）", () => {
    expect(() => bytes(-1)).toThrow(RangeError);
    expect(() => bytes(Number.NaN)).toThrow(RangeError);
    expect(() => bytes(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("百分比：0 配额是不限流", () => {
  it("total === 0 → ∞，不是 NaN%（那是把唯一确定的事实变成未知）", () => {
    expect(percent(1, 0)).toBe(UNLIMITED);
    expect(percent(0, 0)).toBe(UNLIMITED);
  });

  it("正常档一位小数", () => {
    expect(percent(512, 1024)).toBe("50.0%");
  });

  it("不夹逼：超额是必须看得见的事实", () => {
    expect(percent(3, 2)).toBe("150.0%");
  });

  it("非法输入抛", () => {
    expect(() => percent(-1, 10)).toThrow(RangeError);
    expect(() => percent(1, -10)).toThrow(RangeError);
  });
});
