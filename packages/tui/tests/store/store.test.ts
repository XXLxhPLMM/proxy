/**
 * `@/store` 那一层的**纯函数**（发号与落盘↔内存的换算）
 *
 * @description 这一档是**纯算术**档：它不需要真 SQLite，也不需要渲染。⚠️ 而它存在的理由是
 * `tests/input/session-storage.test.ts` 那条端到端判据（重开后 `/new` 拿到 `s4`）的**下界**：
 * 端到端那条红时究竟是「抬号算错了」还是「恢复没接上」，这一档一句话就分得开 ——
 * 而**只有端到端一档**的话，症状是「库里少了一行」，看不出是哪一层错的。
 *
 * ⚠️ 「在不在侧边栏上」**不是**这一层的过滤器（那是 `sidebar_sessions` 表那一问），
 * 故这里一个 `visible` 字段都没有 —— 判据落在「恢复出来的清单有几行、都是哪些 `id`」。
 */

import { describe, expect, it } from "vitest";

import {
  SEED_SESSION,
  restoredSessions,
  sessionOf,
  sessionSeqOf,
  type SessionRecord,
} from "@/store/index.js";

/** 一条落盘的会话记录（⚠️ 四列就是 `SessionRecord` 的全部：桶与侧边栏都不在会话自己身上） */
function record(id: string): SessionRecord {
  return { id, name: `会话 ${id.slice(1)}`, createdAt: 1, updatedAt: 1 };
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
    // ⚠️ 字符串比较 `"s10" < "s9"` 为真 ⇒ 拿字典序取「最大」的实现会发号成 `s10`… 而那是对的，
    // 反过来才是 bug；故这一档钉的是**数出来**而不是**比出来**。
    expect(sessionSeqOf([record("s9"), record("s10")])).toBe(10);
  });
});

describe("落盘 → 内存：`sessionOf`", () => {
  it("桶与输入行一律从空开始（它们从来没有落盘）", () => {
    const one = sessionOf(record("s2"));
    expect(one.id).toBe("s2");
    expect(one.bucket).toEqual({ entries: [], top: 0, follow: true });
    expect(one.input).toBe("");
    expect(one.cursor).toBe(0);
    expect(one.run).toBe("idle");
  });

  it("⚠️ 每个会话一个**全新的桶对象**（共享同一个会让 `setState` 的引用判据失灵）", () => {
    const a = sessionOf(record("s1"));
    const b = sessionOf(record("s1"));
    expect(a.bucket).not.toBe(b.bucket);
  });

  it("⚠️ 恢复出来的会话**一个都没少、也没有多的**（库里三条就是三条）", () => {
    const sessions = [record("s1"), record("s2"), record("s3")].map(sessionOf);
    expect(sessions.map((one) => one.id)).toEqual(["s1", "s2", "s3"]);
  });
});

describe("启动恢复：`restoredSessions`", () => {
  it("正常档：逐条照搬，**一条不多一条不少**", () => {
    expect(restoredSessions([record("s1"), record("s2")]).map((one) => one.id)).toEqual(["s1", "s2"]);
  });

  it("⚠️ 库里一个会话都没有 ⇒ 补出**起步那一个**（零行清单配零解释的界面）", () => {
    // ⚠️ 症状不是「看不见」，是**输入行还在、键位全都活着，而没有任何东西说得清「我在跟谁说话」**
    const sessions = restoredSessions([]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(SEED_SESSION.id);
    expect(sessions[0]!.name).toBe(SEED_SESSION.name);
  });

  it("⚠️ **补的只是内存里那一份**：一个字节都不写回去（这一趟是纯读，故幂等）", () => {
    // ⚠️ 判据是「跑两遍得到同一份」：一个顺手把起步那一个写进库的实现在第二遍就会多一行
    const once = restoredSessions([]);
    const again = restoredSessions([]);
    expect(again).toEqual(once);
    expect(once).toHaveLength(1);
  });

  it("⚠️ 库里**已经有**会话时一个字都不改（幂等的反向：真的补行会多出第 N+1 行）", () => {
    const once = restoredSessions([record("s1"), record("s2")]);
    const again = restoredSessions(once.map((one) => record(one.id)));
    expect(again).toEqual(once);
  });

  it("⚠️ 起步那一个的 `id` 恰好是 `sessionSeqOf` 空清单**发回来的那个数**（否则 `/new` 会撞上它）", () => {
    // ⚠️ 这两条是**耦合**的：起手那一个物化成内存里那份之后，「库里用到的最大下标」就是 1，
    // 而发号器正是在那个数上再加一 ⇒ `/new` 拿到 `s2` 而不是 `s1`
    expect(sessionSeqOf([])).toBe(1);
    expect(SEED_SESSION.id).toBe(`s${String(sessionSeqOf([]))}`);
    expect(restoredSessions([])[0]!.id).toBe(SEED_SESSION.id);
  });
});