/**
 * `@/store` 那一层的**纯函数**（发号与落盘↔内存的换算）
 *
 * @description 这一档是**纯算术**档：它不需要真 SQLite，也不需要渲染。⚠️ 而它存在的理由是
 * `tests/input.test.ts` 那条端到端判据（重开后 `/new` 拿到 `s4`）的**下界**：
 * 端到端那条红时究竟是「抬号算错了」还是「恢复没接上」，这一档一句话就分得开 ——
 * 而**只有端到端一档**的话，症状是「库里少了一行」，看不出是哪一层错的。
 */

import { describe, expect, it } from "vitest";

import {
  restoredSessions,
  sessionOf,
  sessionSeqOf,
  visibleSessions,
  type SessionRecord,
} from "@/store/index.js";

/** 一条落盘的会话记录（⚠️ 只给这三个字段，其余按 `SessionRecord` 的缺省不写 —— 那张形状是 type-only 的） */
function record(id: string, visible = true): SessionRecord {
  return { id, name: `会话 ${id.slice(1)}`, createdAt: 1, updatedAt: 1, visible };
}

describe("会话发号：`sessionSeqOf`（恢复之后 `/new` 从哪儿接着数）", () => {
  it("取库里最大的那个下标（不抬号的后果是 `/new` 撞主键）", () => {
    expect(sessionSeqOf([record("s1"), record("s2"), record("s3")])).toBe(3);
  });

  it("⚠️ **不按数组末位而按最大值**：删掉中间那一个之后发号不许退回去", () => {
    // ⚠️ 数组的顺序是 `rowid`（插入序），而「关掉会话 1」之后第一行是 `s2`、末位是 `s3` ——
    // 拿末位当答案的实现在这个形状上恰好也对，故只有「末位比最大值小」的那一档才分得开。
    expect(sessionSeqOf([record("s2"), record("s3")])).toBe(3);
    expect(sessionSeqOf([record("s3"), record("s2")])).toBe(3);
  });

  it("⚠️ 空清单 ⇒ 1（而**不是** 0：那会让起步那个会话拿到 `s0`）", () => {
    expect(sessionSeqOf([])).toBe(1);
  });

  it("⚠️ 认不出来的 `id` 贡献 0 而不是 `NaN`（`Number(\"abc\")` 会把整条链弄成 `NaN`）", () => {
    expect(sessionSeqOf([record("legacy-1"), record("s4")])).toBe(4);
    // ⚠️ 全都认不出来 ⇒ 退回 1，故下一个发号是 `s2` 而不是「一个也发不出来」
    expect(sessionSeqOf([record("legacy-1")])).toBe(1);
  });

  it("下标不是一位数时照样取对（`s10` 排在 `s9` 之后，而字符串比会判反）", () => {
    // ⚠️ 字符串比较 `\"s10\" < \"s9\"` 为真 ⇒ 拿字典序取「最大」的实现会发号成 `s10`… 而那是对的，
    // 反过来才是 bug；故这一档钉的是**数出来**而不是**比出来**。
    expect(sessionSeqOf([record("s9"), record("s10")])).toBe(10);
  });
});

describe("落盘 → 内存：`sessionOf` 与 `visibleSessions`", () => {
  it("桶与输入行一律从空开始（它们从来没有落盘）", () => {
    const one = sessionOf(record("s2"));
    expect(one.id).toBe("s2");
    expect(one.bucket).toEqual({ entries: [], top: 0, follow: true });
    expect(one.input).toBe("");
    expect(one.cursor).toBe(0);
    expect(one.run).toBe("idle");
  });

  it("⚠️ `visible` 从记录落回来（恢复时铺成 `true` 会让用户藏掉的名字凭空冒出来）", () => {
    expect(sessionOf(record("s2")).visible).toBe(true);
    expect(sessionOf(record("s2", false)).visible).toBe(false);
  });

  it("⚠️ 恢复之后隐藏的那一个**不占侧边栏、但没有丢**", () => {
    // ⚠️ 判据是「两个不同的断言」而不是一个：只判 `visibleSessions` 的话，「一个都恢复不了」也是 0 项
    const sessions = [record("s1"), record("s2", false), record("s3")].map(sessionOf);
    expect(sessions).toHaveLength(3);
    expect(visibleSessions(sessions).map((one) => one.id)).toEqual(["s1", "s3"]);
  });

  it("⚠️ 每个会话一个**全新的桶对象**（共享同一个会让 `setState` 的引用判据失灵）", () => {
    const a = sessionOf(record("s1"));
    const b = sessionOf(record("s1"));
    expect(a.bucket).not.toBe(b.bucket);
  });
});

describe("启动恢复：`restoredSessions`（侧边栏**永远**有一行）", () => {
  it("正常档：逐条照搬，藏着的仍然藏着（**不许**顺手全显示出来）", () => {
    const sessions = restoredSessions([record("s1"), record("s2", false), record("s3")]);
    expect(visibleSessions(sessions).map((one) => one.id)).toEqual(["s1", "s3"]);
  });

  it("⚠️ **全隐藏的库 ⇒ 补出第一行**（照搬就恢复出一个空侧边栏）", () => {
    // ⚠️ 这就是 R4 落地之后才出现的那个洞：`visible` 落盘了，而恢复**照搬** `visible` ——
    // 于是一个「每一行都被藏起来」的库恢复出零行侧边栏。
    // 症状不是「看不见」，是**输入行还在、键位全都活着，而没有任何东西说得清「我现在打给谁」**。
    const sessions = restoredSessions([record("s1", false), record("s2", false)]);
    expect(sessions).toHaveLength(2);
    expect(visibleSessions(sessions).map((one) => one.id)).toEqual(["s1"]);
  });

  it("⚠️ 补的只是**内存里那一份**：返回的新对象不与记录共享桶（否则两处引用同一个对象）", () => {
    const one = restoredSessions([record("s1", false)])[0]!;
    expect(one.visible).toBe(true);
    // ⚠️ 反向自检：另外两个会话**仍然是藏着的**（补一行不是「全部放出来」）
    expect(restoredSessions([record("s1", false), record("s2", false)])[1]!.visible).toBe(false);
  });

  it("空清单 ⇒ 空清单（**不**凭空造一行：库里没有会话与「都藏着」是两件事）", () => {
    expect(restoredSessions([])).toEqual([]);
  });

  it("⚠️ 全可见的库一个字都不改（幂等：跑两遍得到同一份）", () => {
    const once = restoredSessions([record("s1"), record("s2")]);
    expect(restoredSessions(once.map((one) => ({ ...one, createdAt: 1, updatedAt: 1 })))).toEqual(once);
  });
});
