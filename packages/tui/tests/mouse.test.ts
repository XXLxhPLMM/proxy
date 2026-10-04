/**
 * `@/services/terminal/mouse` 的**纯函数那一半**断言（解析 + 命中测试 + 探活换算）
 *
 * **锁什么**：
 * ① 分片到达 —— 半条序列**不许**在第一次调用里吐事件（漏掉残留缓冲的后果不是「少一个事件」，
 *    而是半条序列被当成普通按键：界面毫无征兆地跳页）；
 * ② 一个 chunk 里多条序列**全部**按到达顺序吐出，且非鼠标字节原样透传（`usePaste` 与 Ink 要用同一个流）；
 * ③ 命中测试用**半开区间** —— 边界那一列/行归下一个元素，**最后一行**含 `y + height - 1`、不含 `y + height`；
 * ④ 坐标是 1-based 且已减一；滚轮是**按下形态**上报的（`b = 64/65`）且**没有按键**；
 * ⑤ 探活四档换算，且「似乎不支持鼠标」这一档**只**是提示，键位表不受影响；
 * ⑥ `isMouseReport` —— Ink 交给 `useInput` 的那一串**是不是**鼠标报告。
 *    ⚠️ 这一条不是「多一个工具函数」的覆盖率：它挡的是**协议报文被当成用户输入**，症状是
 *    输入行里逐字长出 `[<35;64;32M`（`?1003h` 开着时移动一次鼠标就是几十行那种）。
 *    它的判据**必须**与 `parseSgr` 同源（同一个 `scanSgr`），故有一条断言直接比对两者。
 *
 * **为什么拆掉哪一处会红**（每条都做过变异实测；harness 见交接说明，9 条全部按预期转红）：
 * - 残留缓冲那行改成 `pending = parsed.pending` → 反了 → ① 转红（**不是**恒红：单 chunk 那组仍绿，
 *   故「多 chunk 顺序」与「分片」必须是**两个**独立断言）。
 * - `events` 只取第一条 / 顺序反了 → ② 转红。
 * - 坐标不减一 / 滚轮按 release 判 → ④ 转红。
 * - `mouseSupportOf` 把 `silent` 与 `idle` 合并 → ⑤ 转红。
 * - `isMouseReport` 恒 `false` → ⑥ 里 8 条一起转红（含 `input.test.ts` 那四档真渲染）。
 * - 只认**带 ESC** 的原串（漏掉 Ink 砍掉 ESC 之后的那一半）→ ⑥ 的「两种形态」那条转红，
 *   而 `parseSgr` 那一半仍绿 —— 故**两种形态必须是两条断言**，不是同一条里的一个循环。
 * - 「必须以 `ESC[<` 开头」那道闸删掉 → ⑥ 的「像但不是」那条转红，**且** `input.test.ts` 的
 *   「反向自检」「`[` 打得进去」「移动不引起重绘」三条一起转红（那时连 `a` 都成半条报告了）。
 *   ⚠️ 后者才是「判据不许过宽」的真证据 —— 纯函数那条只判了返回值。
 * - 「长度必须超过前缀本身」那道闸删掉 → 只有 ⑥ 的「只有前缀」那条转红（`[<` 被当成报告，
 *   而 `[` 仍不是 —— 故**那一个形状要单独钉**，它与上一条不是同一道闸）。
 * - 「整段消费完」那道闸删掉 → ⑥ 的「带尾巴的不认」转红。
 * - 「分片未到齐」那道闸删掉 → ⑥ 的「半条」那条转红。
 * - `foreign` 那一档不再放过 → ⑥ 的「像但不是」那条转红。
 * - 判据换成 `startsWith("[<")`（**第二份**形状，不再走 `scanSgr`）→ 同样转红，而
 *   `parseSgr` 那一侧全绿 —— 这条量的是「同源」这条要求本身。
 * - ⚠️ 另有一条变异**实测是绿的**，故它**不是**变异：把闸门挪到 `printableOnly` 之后仍然对，
 *   因为报文里唯一的 C0 字节（ESC）早就被 Ink 拿走，`printableOnly` 原样放过。
 *   「闸门放在 `useInput` 最前面」是**可读性**要求（它必须在任何判据之前），不是正确性要求 ——
 *   别把它当正确性断言写进注释里。
 *
 * ⚠️ 「薄壳」那一半（`createMouseSource` 的挂监听 / 开闭上报 / 探活）也在这里，但**只用内存里的
 * fake stdin / fake stdout**：它们不发一个真字节。故「真终端退出后干不干净」与「真终端真的会回
 * 鼠标序列」仍需一次手动验证，不在单测射程内；序列的对称性另由 `tests/screen.test.ts` 钉。
 */

import { describe, expect, it } from "vitest";
import {
  createMouseSource,
  isMouseReport,
  MOUSE_QUIET_MS,
  MOUSE_REPORTING_OFF,
  MOUSE_REPORTING_ON,
  MOUSE_UNSUPPORTED_HINT,
  mouseSupportOf,
  mouseUnsupportedHintOf,
  parseSgr,
  type MouseEvent,
  type MouseLiveness,
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

describe("探活四档：唯一诚实的判据是「终端有没有回我们的上报请求」", () => {
  const liveness = (over: Partial<MouseLiveness> = {}): MouseLiveness => ({
    reporting: true,
    seenAny: false,
    lastEventAt: null,
    ...over,
  });

  it("没开上报 → `unknown`（没资格下结论）", () => {
    expect(mouseSupportOf(liveness({ reporting: false }), 1000)).toBe("unknown");
  });

  it("开着且从未收到过 → `silent`（唯一能说「似乎不支持」的档）", () => {
    expect(mouseSupportOf(liveness(), 1000)).toBe("silent");
  });

  it("最近收到过 → `reported`；超过窗口 → `idle`（**不知道**，不许提示）", () => {
    const seen = liveness({ seenAny: true, lastEventAt: 1000 });
    expect(mouseSupportOf(seen, 1000)).toBe("reported");
    expect(mouseSupportOf(seen, 1000 + MOUSE_QUIET_MS - 1)).toBe("reported");
    expect(mouseSupportOf(seen, 1000 + MOUSE_QUIET_MS)).toBe("idle");
  });

  it("只有 `silent` 档给提示，其余三档一律 `null`（不提示 ≠ 禁键位）", () => {
    expect(mouseUnsupportedHintOf(liveness(), 1000)).toBe(MOUSE_UNSUPPORTED_HINT);
    expect(mouseUnsupportedHintOf(liveness({ reporting: false }), 1000)).toBeNull();
    expect(mouseUnsupportedHintOf(liveness({ seenAny: true, lastEventAt: 1000 }), 1000)).toBeNull();
    expect(
      mouseUnsupportedHintOf(liveness({ seenAny: true, lastEventAt: 1000 }), 1000 + MOUSE_QUIET_MS),
    ).toBeNull();
  });

  it("提示文案必须说清「键位仍全部可用」（这一句与前半句同等重要）", () => {
    expect(MOUSE_UNSUPPORTED_HINT).toBe("本终端似乎不支持鼠标；全部键位仍可用");
  });
});

describe("事件源的接线：分片跨 `data` 事件攒住，`start`/`stop` 各自幂等", () => {
  /** 一个只在内存里的 stdin（**不发真字节**：它只是把 `data` 回调存下来供本档手动触发） */
  function fakeStdin(): {
    stdin: {
      on(event: "data", listener: (chunk: string) => void): void;
      off(event: "data", listener: (chunk: string) => void): void;
    };
    feed: (chunk: string) => void;
    attached: () => number;
  } {
    const listeners = new Set<(chunk: string) => void>();
    return {
      stdin: {
        on(event: "data", listener: (chunk: string) => void): void {
          listeners.add(listener);
        },
        off(event: "data", listener: (chunk: string) => void): void {
          listeners.delete(listener);
        },
      },
      feed: (chunk: string): void => {
        for (const listener of [...listeners]) listener(chunk);
      },
      attached: (): number => listeners.size,
    };
  }

  function fakeOut(): { out: { write(chunk: string): boolean }; writes: string[] } {
    const writes: string[] = [];
    return { out: { write: (chunk: string): boolean => writes.push(chunk) === 1 }, writes };
  }

  it("一次 `data` 只带半条序列时事件**延后**到下一片（跨调用的残留缓冲在接线里真的接上了）", () => {
    const { stdin, feed } = fakeStdin();
    const { out, writes } = fakeOut();
    const source = createMouseSource({ stdin, out, now: () => 1000 });
    const seen: MouseEvent[] = [];
    source.onMouse((event) => seen.push(event));
    source.start();

    const whole = "\u001B[<0;10;5M";
    feed(whole.slice(0, 6));
    expect(seen).toEqual([]);
    feed(whole.slice(6));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ action: "down", button: "left", x: 9, y: 4 });
    expect(writes).toEqual([MOUSE_REPORTING_ON.join("")]);
    source.stop();
  });

  it("探活随实测变化，且只在「收到过」上翻（`start` 之后立即是 `silent`）", () => {
    const { stdin, feed } = fakeStdin();
    const { out } = fakeOut();
    let clock = 500;
    const source = createMouseSource({ stdin, out, now: () => clock });
    expect(mouseSupportOf(source.liveness(), 500)).toBe("unknown");

    source.start();
    expect(mouseUnsupportedHintOf(source.liveness(), 500)).toBe(MOUSE_UNSUPPORTED_HINT);

    clock = 900;
    feed("\u001B[<0;1;1M");
    expect(source.liveness().seenAny).toBe(true);
    expect(source.liveness().lastEventAt).toBe(900);
    expect(mouseSupportOf(source.liveness(), 900)).toBe("reported");

    clock = 900 + MOUSE_QUIET_MS;
    expect(mouseSupportOf(source.liveness(), clock)).toBe("idle");
    source.stop();
  });

  it("`stop` 写关闭序列、摘监听，再调一次**不写不摘**（幂等）", () => {
    const { stdin, feed, attached } = fakeStdin();
    const { out, writes } = fakeOut();
    const source = createMouseSource({ stdin, out });
    let count = 0;
    source.onMouse(() => {
      count += 1;
    });
    source.start();
    expect(attached()).toBe(1);

    source.stop();
    expect(writes).toEqual([MOUSE_REPORTING_ON.join(""), MOUSE_REPORTING_OFF.join("")]);
    expect(attached()).toBe(0);
    feed("\u001B[<0;1;1M");
    expect(count).toBe(0);

    source.stop();
    source.stop();
    expect(writes).toHaveLength(2);
  });

  it("`stop` 之后喂字节收不到任何事件（监听器真的摘了，不只是不再解析）", () => {
    const { stdin, feed } = fakeStdin();
    const { out } = fakeOut();
    const source = createMouseSource({ stdin, out });
    let count = 0;
    source.onMouse(() => {
      count += 1;
    });
    source.start();
    source.stop();
    feed("\u001B[<0;1;1M");
    expect(count).toBe(0);
    expect(source.liveness().seenAny).toBe(false);
  });

  it("`start` 两次只挂一个监听、只写一遍开启序列", () => {
    const { stdin, feed, attached } = fakeStdin();
    const { out, writes } = fakeOut();
    const source = createMouseSource({ stdin, out });
    let count = 0;
    source.onMouse(() => {
      count += 1;
    });
    source.start();
    source.start();
    expect(attached()).toBe(1);
    expect(writes).toHaveLength(1);

    feed("\u001B[<0;1;1M\u001B[<0;2;2M");
    expect(count).toBe(2);
    source.stop();
  });

  it("开启序列写失败时，`stop` 仍摘监听、**并且仍写关闭序列**（关闭必须无条件执行）", () => {
    const { stdin, feed, attached } = fakeStdin();
    const writes: string[] = [];
    const out = {
      write(chunk: string): boolean {
        writes.push(chunk);
        if (writes.length === 1) throw new Error("EPIPE");
        return true;
      },
    };
    const source = createMouseSource({ stdin, out });

    expect(() => {
      source.start();
    }).toThrow("EPIPE");
    expect(attached()).toBe(1);

    source.stop();
    expect(writes).toEqual([MOUSE_REPORTING_ON.join(""), MOUSE_REPORTING_OFF.join("")]);
    expect(attached()).toBe(0);
    feed("\u001B[<0;1;1M");
    expect(source.liveness().seenAny).toBe(false);
  });

  it("退订后不再收到事件", () => {
    const { stdin, feed } = fakeStdin();
    const { out } = fakeOut();
    const source = createMouseSource({ stdin, out });
    let count = 0;
    const off = source.onMouse(() => {
      count += 1;
    });
    source.start();
    feed("\u001B[<0;1;1M");
    off();
    feed("\u001B[<0;2;2M");
    expect(count).toBe(1);
    source.stop();
  });

  it("非鼠标字节**不回灌**（`rest` 一次都不许被写回流里，否则按键会被收两遍）", () => {
    const { stdin, feed } = fakeStdin();
    const { out, writes } = fakeOut();
    const source = createMouseSource({ stdin, out });
    source.start();
    feed("a\u001B[A");
    // 只应有开启那一次写入：没有「把 rest 写回去」的第二条
    expect(writes).toEqual([MOUSE_REPORTING_ON.join("")]);
    source.stop();
  });
});
