/**
 * 上报有没有生效：探活四档的换算 + 事件源的挂摘、开闭与幂等（只用内存里的 fake stdin / stdout）
 *
 * @description `mouseSupportOf` 四档 + `createMouseSource` 的接线。⚠️ 本目录锁住的不变量与
 * 「拆掉哪一处会红」见 `tests/mouse/AGENTS.md`；报文怎么读成事件在 `tests/mouse/parse.test.ts`。
 *
 * @module tests/mouse
 */

import { describe, expect, it } from "vitest";
import {
  createMouseSource,
  MOUSE_QUIET_MS,
  MOUSE_REPORTING_OFF,
  MOUSE_REPORTING_ON,
  MOUSE_UNSUPPORTED_HINT,
  mouseSupportOf,
  mouseUnsupportedHintOf,
  type MouseEvent,
  type MouseLiveness,
} from "@/services/terminal/mouse.js";

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
