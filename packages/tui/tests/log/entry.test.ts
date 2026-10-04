/**
 * 桶里那批 `LogEntry` 本身：环形缓冲丢掉的最早一条报得出来、凭据掩码定长
 *
 * @description
 * 这一档**不碰摊平**：判据的对象是 `entries` 那个数组与它每条上的字段，故零 `flatten` 调用 ——
 * 「丢掉的最早一条能不能报出来」与「掩码会不会泄密」都与显示宽度无关。
 *
 * ⚠️ `maskEcho` 按**凭据类别**而不是真实长度给掩码，故「1 个字符与 64 个字符给出同一个掩码」
 * 才是判据；而 `append` 的 id 从 1 起，于是 `dropped()` 的 `0` 哨兵与「丢掉过」不歧义。
 *
 * 两条不变量与「为什么拆掉哪一处会红」见本目录 `AGENTS.md`。
 *
 * @module tests/log
 */

import { describe, expect, it } from "vitest";
import { append, dropped, maskEcho, trim, type LogEntry, type LogRow } from "@/lib/log/index.js";
import { entry, toolTurn } from "./_shared.js";

describe("不变量 ⑤：环形缓冲丢掉的最早一条必须报得出来", () => {
  it("没丢过时 dropped 为 0", () => {
    const entries = [entry(1, []), entry(2, [])];
    expect(dropped(entries, 5)).toBe(0);
  });

  it("丢过时 dropped 是留下来的最早那条的 id（不是条数）", () => {
    const entries = [entry(1, []), entry(2, []), entry(3, []), entry(4, [])];
    const kept = trim(entries, 2);
    expect(kept.map((e) => e.id)).toEqual([3, 4]);
    expect(dropped(entries, 2)).toBe(1);
  });

  it("trim 返回新数组（就地改会让 React 的 setState 看不到变化）", () => {
    const entries = [entry(1, []), entry(2, [])];
    const kept = trim(entries, 5);
    expect(kept).not.toBe(entries);
    expect(entries).toHaveLength(2);
  });

  it("append 的 id 从 1 起且单调递增（0 留给「一条都没丢」那个含义，见实现注释）", () => {
    const a: LogEntry[] = [];
    const b = append(a, [toolTurn([{ kind: "note", text: "x" }])], 1000);
    const c = append(b, [toolTurn([{ kind: "note", text: "y" }])], 2000);
    expect(b.map((e) => e.id)).toEqual([1]);
    expect(c.map((e) => e.id)).toEqual([1, 2]);
    expect(c[1]!.at).toBe(2000);
    expect(a).toHaveLength(0);
  });

  it("丢了历史之后最早那条的 id 不会撞上 0（否则「丢过」与「没丢过」不可区分）", () => {
    let entries: LogEntry[] = [];
    for (let i = 0; i < 4; i += 1) {
      entries = append(entries, [toolTurn([{ kind: "note", text: `n${i}` }])], 0);
    }
    const kept = trim(entries, 2);
    expect(kept.map((e) => e.id)).toEqual([3, 4]);
    // 关键：丢掉过 → 报出来的数**必须**与「没丢过」的 0 区分得开
    expect(dropped(entries, 2)).not.toBe(dropped(kept, 5));
    expect(dropped(kept, 5)).toBe(0);
  });

  it("两条一模一样的结果各占一个 id（拿文本当锚点会让第二条在第一次重绘就消失）", () => {
    const same: LogRow[] = [{ kind: "note", text: "完全一样" }];
    const once = append(append([], [toolTurn(same)], 0), [toolTurn(same)], 1);
    expect(once[0]!.id).not.toBe(once[1]!.id);
  });
});

describe("不变量 ⑥：凭据掩码是定长的（长度本身也是信息）", () => {
  it("1 个字符与 64 个字符给出同一个掩码", () => {
    expect(maskEcho("user-pass", "a")).toBe(maskEcho("user-pass", "x".repeat(64)));
  });

  it("空凭据返回空串（不能因为「反正要打码」就凭空显示 6 个点）", () => {
    expect(maskEcho("target-add", "")).toBe("");
  });
});
