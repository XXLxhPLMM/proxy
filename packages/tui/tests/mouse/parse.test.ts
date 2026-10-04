/**
 * SGR 报文怎么读成事件：上报开关序列的对称性 / `parseSgr` / `isMouseReport`
 *
 * @description 分片到达、一个 chunk 里的多条序列、坐标与滚轮位域、非鼠标字节原样透传，以及
 * Ink 交到 `useInput` 面前那一串的认领。⚠️ 本目录锁住的不变量与「拆掉哪一处会红」见
 * `tests/mouse/AGENTS.md`；探活四档与事件源的接线在 `tests/mouse/source.test.ts`。
 *
 * @module tests/mouse
 */

import { describe, expect, it } from "vitest";
import {
  isMouseReport,
  MOUSE_REPORTING_OFF,
  MOUSE_REPORTING_ON,
  parseSgr,
} from "@/services/terminal/mouse.js";

/** 造一条 SGR 报告（`column`/`row` 是**终端的 1-based 坐标**，与真实终端发来的一致） */
function sgr(button: number, column: number, row: number, release = false): string {
  return `\u001B[<${button};${column};${row}${release ? "m" : "M"}`;
}

/** 同一个模式号、`h` ↔ `l` 互换（关闭序列不是开启序列的逐字倒序，而是**逐条取反**） */
function flipTerminalFlag(sequence: string): string {
  return sequence.replace(/[hl]$/, (flag) => (flag === "h" ? "l" : "h"));
}

describe("开关序列：开闭一一对应且顺序相反（漏一条的代价是终端一直吞选中与粘贴）", () => {
  it("开启与关闭逐条配对：同一个模式号、`h` ↔ `l`", () => {
    expect(MOUSE_REPORTING_OFF).toHaveLength(MOUSE_REPORTING_ON.length);
    expect(MOUSE_REPORTING_ON).toEqual(["\u001B[?1000h", "\u001B[?1003h", "\u001B[?1006h"]);
    expect(MOUSE_REPORTING_OFF).toEqual(["\u001B[?1006l", "\u001B[?1003l", "\u001B[?1000l"]);
  });

  it("关闭的顺序是开启的**逆序**，且逐条是同一个模式号取反", () => {
    // 期望值从 ON 推导：同序会红，顺序对而模式号写错（如 `?1000l` 写成 `?1003l`）也会红。
    expect(MOUSE_REPORTING_OFF).toEqual([...MOUSE_REPORTING_ON].reverse().map(flipTerminalFlag));
  });
});

describe("不变量 ①：分片到达（漏掉残留缓冲 = 半条序列被当成按键）", () => {
  it("一条序列被拆成两个 chunk：第一片不吐事件，第二片才吐（各一次调用）", () => {
    const whole = sgr(0, 10, 5);
    const first = parseSgr(whole.slice(0, 5), "");
    expect(first.events).toEqual([]);
    expect(first.pending).toBe(whole.slice(0, 5));

    const second = parseSgr(whole.slice(5), first.pending);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ action: "down", button: "left", x: 9, y: 4 });
    expect(second.pending).toBe("");
  });

  it("逐个字符切分（最坏的分片）：残留必须原样攒住，事件一条都不许早吐", () => {
    const whole = sgr(2, 80, 24);
    let pending = "";
    const seen: string[] = [];
    for (const character of whole) {
      const parsed = parseSgr(character, pending);
      // 关键：除最后一片以外不许有事件，而 `pending` 必须逐字等于已收到的那段前缀
      seen.push(...parsed.events.map((event) => event.action));
      pending = parsed.pending;
    }
    expect(seen).toEqual(["down"]);
    expect(pending).toBe("");
  });

  it("分片不得把非鼠标字节吞进残留（`rest` 与 `pending` 合起来必须等于原输入）", () => {
    const first = parseSgr("ab" + sgr(0, 1, 1).slice(0, 4), "");
    expect(first.rest).toBe("ab");
    expect(first.rest + first.pending).toBe("ab" + sgr(0, 1, 1).slice(0, 4));

    const second = parseSgr(sgr(0, 1, 1).slice(4), first.pending);
    expect(second.events).toHaveLength(1);
    expect(second.rest).toBe("");
  });
});

describe("不变量 ②：一个 chunk 里多条序列（顺序与条数都要对）", () => {
  it("同 chunk 内的 down/up/wheel 按到达顺序全部吐出", () => {
    const parsed = parseSgr(sgr(0, 10, 5) + sgr(0, 10, 5, true) + sgr(64, 3, 3), "");
    expect(parsed.events).toHaveLength(3);
    expect(parsed.events.map((event) => event.action)).toEqual(["down", "up", "wheelUp"]);
    expect(parsed.events.map((event) => [event.x, event.y])).toEqual([
      [9, 4],
      [9, 4],
      [2, 2],
    ]);
  });

  it("**只取第一条**的实现会红（防「多 chunk 顺序」那条恒红）", () => {
    const parsed = parseSgr(sgr(0, 1, 1) + sgr(32, 2, 2) + sgr(2, 3, 3), "");
    expect(parsed.events.map((event) => event.action)).toEqual(["down", "drag", "down"]);
    expect(parsed.events.map((event) => event.button)).toEqual(["left", "left", "right"]);
  });

  it("**顺序反了**的实现会红（第一条断言是条数，这一条才是顺序）", () => {
    const parsed = parseSgr(sgr(0, 1, 1) + sgr(2, 2, 2, true), "");
    expect(parsed.events.map((event) => event.button)).toEqual(["left", "right"]);
    expect(parsed.events.map((event) => event.action)).toEqual(["down", "up"]);
  });
});

describe("坐标：终端报的是 1-based 格子，事件坐标已减一", () => {
  it("三键 + 拖动 + 修饰键的真值表", () => {
    const parsed = parseSgr(
      sgr(0, 1, 1) +
        sgr(1, 1, 1) +
        sgr(2, 1, 1) +
        sgr(32, 1, 1) +
        sgr(4 | 32, 1, 1) +
        sgr(16, 1, 1),
      "",
    );
    expect(parsed.events.map((event) => [event.action, event.button])).toEqual([
      ["down", "left"],
      ["down", "middle"],
      ["down", "right"],
      ["drag", "left"],
      ["drag", "left"],
      ["down", "left"],
    ]);
    expect(parsed.events[4]?.shift).toBe(true);
    expect(parsed.events[5]?.ctrl).toBe(true);
    expect(parsed.events[0]).toMatchObject({ x: 0, y: 0 });
  });

  it("宽终端上 223 列以上不 wrap（1006 的坐标是无界的）", () => {
    expect(parseSgr(sgr(0, 240, 60), "").events[0]).toMatchObject({ x: 239, y: 59 });
  });

  it("坐标非正整数（终端报 0）时消费字节但**不产出事件**（不拿假位置去喂命中测试）", () => {
    const parsed = parseSgr(sgr(0, 0, 0) + sgr(0, 0, 5), "");
    expect(parsed.events).toEqual([]);
    expect(parsed.rest).toBe("");
  });
});

describe("滚轮：按下形态上报，且没有按键（低 2 位是 0 却不许说成左键）", () => {
  it("滚轮四档", () => {
    const parsed = parseSgr(sgr(64, 1, 1) + sgr(65, 1, 1) + sgr(66, 1, 1) + sgr(67, 1, 1), "");
    expect(parsed.events.map((event) => event.action)).toEqual([
      "wheelUp",
      "wheelDown",
      "wheelLeft",
      "wheelRight",
    ]);
    expect(parsed.events.every((event) => event.button === null)).toBe(true);
  });

  it("滚轮是 `M`（按下形态），不许被 release 判据吃成 `up`", () => {
    const parsed = parseSgr("\u001B[<64;7;7M", "");
    expect(parsed.events[0]?.action).toBe("wheelUp");
  });
});

describe("非鼠标字节原样透传（`usePaste` 与 Ink 要用同一个流）", () => {
  it("方向键（`ESC[A`）不是鼠标报告：一个字节都不许被吞", () => {
    const parsed = parseSgr("\u001B[A\u001B[Bx", "");
    expect(parsed.events).toEqual([]);
    expect(parsed.rest).toBe("\u001B[A\u001B[Bx");
  });

  it("普通输入（含 Ctrl 字节与退格）与鼠标报告混在一个 chunk 时各自归位", () => {
    const parsed = parseSgr("a\u0003" + sgr(0, 1, 1) + "\u007F", "");
    expect(parsed.events).toHaveLength(1);
    expect(parsed.rest).toBe("a\u0003\u007F");
  });

  it("**不是**我们的 SGR 形态（`ESC[>…` 私有模式查询）原样透传", () => {
    const parsed = parseSgr("\u001B[>0;276;0c" + sgr(0, 2, 2), "");
    expect(parsed.events).toHaveLength(1);
    expect(parsed.rest).toBe("\u001B[>0;276;0c");
  });

  it("段数不是 3 的 SGR 形态原样透传（判据宁可放过，不可吞掉别人的序列）", () => {
    const parsed = parseSgr("\u001B[<0;1;2;3M", "");
    expect(parsed.events).toEqual([]);
    expect(parsed.rest).toBe("\u001B[<0;1;2;3M");
  });
});

describe("不变量 ⑥：Ink 交出来的鼠标报告原样可辨（输入行据此认领掉）", () => {
  /** 造一条**已经被 Ink 砍掉 ESC** 的报告 —— 那正是 `useInput` 回调看到的东西 */
  const bare = (button: number, column: number, row: number, release = false): string =>
    sgr(button, column, row, release).slice(1);

  it("两种形态都认：带 ESC 的原串，以及 Ink 砍掉 ESC 之后的那一串", () => {
    expect(isMouseReport(sgr(0, 64, 32))).toBe(true);
    expect(isMouseReport(bare(0, 64, 32))).toBe(true);
  });

  it("移动 / 拖动 / 释放 / 滚轮各种位域都认（`?1003h` 开着时全是它们）", () => {
    for (const button of [0, 2, 32, 34, 35, 64, 65, 66, 67]) {
      expect(isMouseReport(bare(button, 10, 10))).toBe(true);
    }
    expect(isMouseReport(bare(0, 10, 10, true))).toBe(true);
  });

  it("分片未到齐的**半条**也认（Ink 的 `flushPendingEscape` 会把它当一次输入交出来）", () => {
    expect(isMouseReport(bare(0, 6, 3).slice(0, 6))).toBe(true);
    expect(isMouseReport(sgr(0, 6, 3).slice(0, 6))).toBe(true);
  });

  it("**只有前缀**不算报告（否则输入行里再也打不出 `[` 与 `[<`）", () => {
    expect(isMouseReport("[")).toBe(false);
    expect(isMouseReport("[<")).toBe(false);
    expect(isMouseReport("\u001B")).toBe(false);
    expect(isMouseReport("\u001B[")).toBe(false);
  });

  it("用户敲的文本、粘贴、以及「像但不是」的那些，一律不认", () => {
    const notReports = [
      "",
      "a",
      "user add charlie 512mb",
      "[abc",
      "[<x",
      "[<35;64;32X", // 终止字母不对
      "[<0;1;2;3M", // 段数不是 3（与 parseSgr 同一判据：宁可放过）
      "[>0;276;0c", // 私有模式查询
      "[35;64;32M", // 少那个 `<`
      bare(0, 10, 10) + "x", // 报告后面还跟着别的字节 ⇒ 那是内容，不是报文
    ];
    for (const text of notReports) {
      expect(isMouseReport(text)).toBe(false);
    }
  });

  it("与 `parseSgr` **同一个判据**：凡是 `parseSgr` 认领的整段，`isMouseReport` 也必须认", () => {
    const reports = [
      sgr(0, 1, 1),
      sgr(2, 240, 60),
      sgr(32, 4, 4),
      sgr(65, 7, 7),
      sgr(0, 1, 1, true),
      sgr(0, 0, 0), // 坐标非法：消费字节但不产出事件
    ];
    for (const report of reports) {
      expect(parseSgr(report, "").rest).toBe("");
      expect(isMouseReport(report)).toBe(true);
      expect(isMouseReport(report.slice(1))).toBe(true);
    }
  });

  it("「整段」这条要求是可观测的：带尾巴的不认，半条的认（拆掉任一道闸这里就红）", () => {
    expect(isMouseReport(bare(0, 10, 10) + "x")).toBe(false);
    expect(isMouseReport(bare(0, 6, 3).slice(0, 6))).toBe(true);
  });
});
