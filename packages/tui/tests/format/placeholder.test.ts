/**
 * 「空 / 未知 / 凭据 / 开关」各自的固定形态：`isoOrNull`、`maskToken`、`dash`、`onOff`。
 *
 * @description
 * ⚠️ 这一档是模块那三条纪律里「**两种事实不许同形**」的那一条：`null` / `""` / `0` / 没监听的进程各给各的
 * 形状，合并任何两个操作者就分不出发生了什么（「没配」与「配错了」也是两个形状）。打码那一档刻意
 * **不透露长度** —— 长度是一个可二分的信号。
 *
 * 锁什么与「为什么拆掉哪一处会红」见本目录 `AGENTS.md`。
 *
 * @module tests/format
 */

import { describe, expect, it } from "vitest";
import { dash, isoOrNull, maskToken, onOff, widthOf, EM_DASH, MASKED } from "@/lib/format.js";

describe("时刻：原样透传，不做时区换算", () => {
  it("null → —", () => {
    expect(isoOrNull(null)).toBe(EM_DASH);
  });

  it("空串也 → —（空串不是时刻，它是没有时刻的另一种写法）", () => {
    expect(isoOrNull("")).toBe(EM_DASH);
  });

  it("带偏移的 ISO 串逐字保留（换算一次就等于给同一时刻两种说法）", () => {
    const iso = "2026-01-02T03:04:05.000Z";
    expect(isoOrNull(iso)).toBe(iso);
  });
});

describe("凭据打码：固定长度，不透露长度", () => {
  it("空串 → —（「没配」与「配错了」必须能分开）", () => {
    expect(maskToken("")).toBe(EM_DASH);
  });

  it("非空一律同一个固定长度串", () => {
    expect(maskToken("s")).toBe(MASKED);
    expect(maskToken("hunter2")).toBe(MASKED);
    expect(maskToken("a-very-long-token-value")).toBe(MASKED);
  });

  it("⚠️ 两个长度不同的 token 渲染结果**逐字相同**（长度是可二分的信号）", () => {
    // 这条是本档的核心：改成按长度打码就红，而「打码了没有」那种断言在任何实现下都绿
    expect(maskToken("x")).toBe(maskToken("x".repeat(64)));
  });

  it("打码串本身的长度固定（界面列宽按它算，不按原串算）", () => {
    expect(widthOf(MASKED)).toBe(widthOf(MASKED));
    expect(MASKED.length).toBe(6);
  });
});

describe("dash：一个空形态，空串保持空串", () => {
  it("null / undefined → —", () => {
    expect(dash(null)).toBe(EM_DASH);
    expect(dash(undefined)).toBe(EM_DASH);
  });

  it("空串保持空串（「配了个空」与「没配」是两件事）", () => {
    expect(dash("")).toBe("");
  });

  it("0 不是空", () => {
    expect(dash(0)).toBe("0");
  });
});

describe("onOff：开关不是是/否", () => {
  it("true / false → 开 / 关（表头已经写着 disabled，补不出宾语）", () => {
    expect(onOff(true)).toBe("开");
    expect(onOff(false)).toBe("关");
  });
});
