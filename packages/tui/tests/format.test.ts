/**
 * `@/ui/format` 的纯函数断言
 *
 * **锁什么**：人读形态的**边界值**与**它们的理由**。这一层的数字一旦漂了，界面不会崩、不会报错，
 * 只会**说错话**：把 `0` 字节配额显示成 `NaN%`、把没监听的进程显示成「已运行 0 秒」、把 token
 * 的长度印在屏幕上。所以它是本目录最需要被逐字钉住的一块。
 *
 * **为什么拆掉哪一处会红**：
 * - `bytes` 的 `RangeError` → 有人改成原样回显坏数据，「非法输入必须炸」这条不变量就没牙齿了。
 * - `percent(_, 0)` → 有人把 `0` 当分母算，**唯一确定的事实**（不限流）在界面上变成 `NaN`。
 * - `maskToken` 那条「两个不同长度的 token 渲染结果逐字相同」 → 有人改成按长度打码，
 *   长度就重新变成一个可二分的信号（与 `src/manager/http/auth.ts` 同源纪律）。
 * - `ellipsis` 的中文 / emoji 用例 → 有人把 `widthOf` 换成 `String.length`，表格在真终端里歪掉，
 *   而**任何单测都还在绿**（ASCII 用例对两种度量都成立）。
 */

import { describe, expect, it } from "vitest";
import {
  dash,
  bytes,
  duration,
  ellipsis,
  isoOrNull,
  maskToken,
  onOff,
  padToWidth,
  percent,
  uptime,
  widthOf,
  EM_DASH,
  MASKED,
  UNLIMITED,
} from "@/ui/format.js";

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

describe("ellipsis：按显示宽度切，不是按 String.length", () => {
  it("装得下就原样返回", () => {
    expect(ellipsis("abcd", 4)).toBe("abcd");
    expect(ellipsis("ab", 4)).toBe("ab");
  });

  it("ASCII：留一格给 `…`", () => {
    expect(ellipsis("abcdef", 4)).toBe("abc…");
  });

  it("中文按显示宽度算（`账号` 宽 4，length 只有 2）", () => {
    expect(widthOf("账号")).toBe(4);
    expect("账号".length).toBe(2);
    // 5 格：放得下「账号」（4）再放不下「列」（要 6）⇒ 切成一个字的 `…`
    expect(ellipsis("账号列表", 5)).toBe("账号…");
    expect(widthOf(ellipsis("账号列表", 5))).toBe(5);
  });

  it("⚠️ 中文的切点在宽字符上不切开（宁可少一个字形，也不让这一列越出位置）", () => {
    // 宽 2 的字 + `…`（宽 1）：剩 2 格刚好放一个「账」；再多一格也放不下第二个字
    expect(ellipsis("账号列表", 3)).toBe("账…");
    expect(widthOf(ellipsis("账号列表", 3))).toBe(3);
  });

  it("emoji 按显示宽度算（😀 宽 2）", () => {
    expect(widthOf("😀")).toBe(2);
    expect(ellipsis("😀😀", 3)).toBe("😀…");
    expect(widthOf(ellipsis("😀😀", 3))).toBe(3);
  });

  it("⚠️ 任何宽度下都不产生半个代理对（半个 emoji 在终端上是豆腐块）", () => {
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const width of [1, 2, 3, 4, 5, 6]) {
      expect(ellipsis("😀😀", width), `宽度 ${width} 切出了半个代理对`).not.toMatch(loneSurrogate);
    }
  });

  it("宽度 1 只剩 `…`；宽度 <= 0 是空串（Ink 在 0 宽盒子里排版会抛）", () => {
    expect(ellipsis("abc", 1)).toBe("…");
    expect(ellipsis("abc", 0)).toBe("");
    expect(ellipsis("abc", -3)).toBe("");
  });
});

describe("padToWidth：右对齐按显示宽度补空格", () => {
  it("左对齐补在右边", () => {
    expect(padToWidth("ab", 5, "left")).toBe("ab   ");
  });

  it("⚠️ 右对齐中文补的是**空格**、按显示宽度数（补错就整列歪）", () => {
    const padded = padToWidth("账号", 8, "right");
    expect(widthOf(padded)).toBe(8);
    // 「账号」显示宽度 4 ⇒ 补 4 格；按 length 补会补成 6 格（整列右移两格）
    expect(padded).toBe("    账号");
    expect("账号".length).toBe(2);
  });

  it("已经等宽时**不**动它（切只有 ellipsis 一个出口）", () => {
    expect(padToWidth("abcd", 4, "left")).toBe("abcd");
  });

  it("超宽时原样返回（调用方必须先 ellipsis）", () => {
    expect(padToWidth("abcdef", 3, "right")).toBe("abcdef");
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
