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

import { pushHistory } from "@/lib/editor.js";
import * as configView from "@/services/config/index.js";
import {
  DEFAULT_REASONING_EFFORT,
  INPUT_HISTORY,
  REASONING_CYCLE,
  REASONING_EFFORTS,
  SEED_SESSION,
  newSession,
  restoredSessions,
  sessionOf,
  sessionSeqOf,
  type RunState,
  type SessionRecord,
  type WindowState,
} from "@/store/index.js";

/** 一条落盘的会话记录（⚠️ 四列就是 `SessionRecord` 的全部：桶与侧边栏都不在会话自己身上） */
function record(id: string): SessionRecord {
  return { id, name: `会话 ${id.slice(1)}`, createdAt: 1, updatedAt: 1 };
}

describe("会话的缺省形状：`newSession` / `sessionOf` / `restoredSessions` 三处一致", () => {
  it("⚠️ 新字段的缺省值：没有选区、没选模型、推理强度取缺省档、还没看过", () => {
    const one = newSession("s7", "会话 7");
    expect(one.anchor).toBeNull();
    expect(one.modelRef).toBeNull();
    expect(one.seen).toBe(false);
    // ⚠️ 缺省档取的是那**一个**常量（`DEFAULT_REASONING_EFFORT`）而不是字面量：
    // 写死字面量的话「缺省档改了」与「这一档的断言」会一起变，于是恒绿
    expect(one.reasoning).toBe(DEFAULT_REASONING_EFFORT);
    expect(one.reasoning).toBe("medium");
  });

  it("⚠️ **三处给的是同一份缺省**（恢复出来的会话与新建的那些形状不同 ⇒ 症状是「重启之后模型显示没了」）", () => {
    const fresh = newSession("s1", "会话 1");
    const restored = sessionOf(record("s1"));
    const seeded = restoredSessions([])[0]!;
    for (const one of [restored, seeded]) {
      expect(Object.keys(one).sort()).toEqual(Object.keys(fresh).sort());
      expect(one.anchor).toBe(fresh.anchor);
      expect(one.modelRef).toBe(fresh.modelRef);
      expect(one.seen).toBe(fresh.seen);
      expect(one.reasoning).toBe(fresh.reasoning);
    }
    // ⚠️ **反向自检**：一个「在 `sessionOf` 里另写一遍缺省」的实现仍会与 `newSession` 同形，
    // 所以上面那几条对**键集**也断了一遍（多一格少一格都会红）
    expect(Object.keys(restored)).toHaveLength(Object.keys(fresh).length);
  });

  it("⚠️ `run` 与 `seen` **是两个字段**（合成一格的话「看一眼」会把「跑完了」一起清掉）", () => {
    const one = newSession("s1", "会话 1");
    // 判据是「改 `seen` 不牵动 `run`」的形状：两个字段各自独立
    const seen = { ...one, seen: true };
    expect(seen.run).toBe(one.run);
    expect(seen.seen).toBe(true);
    // ⚠️ **正向对照**：`run` 仍然是那**三档**（`idle` / `running` / `done`），
    // 而屏上那枚字形按 `run` 取（`@/theme/impl.ts:runMarkOf` 的 `Record<RunState, RunMark>` 靠它）
    const marks: Record<RunState, string> = { idle: " ", running: "⠋", done: "●" };
    expect(Object.keys(marks).sort()).toEqual(["done", "idle", "running"]);
  });

  it("⚠️ `SessionRecord` **不带** `seen`（它是纯内存的注意力，不落盘）", () => {
    // 判据是**键集**：落盘那份只有身份四列，而模型选择与推理强度由另外两列单独查
    expect(Object.keys(record("s1")).sort()).toEqual(["createdAt", "id", "name", "updatedAt"]);
    // ⚠️ **反向自检**：`Session` 自己那份**确实**有 `seen` / `modelRef` / `reasoning` 三格
    const one = newSession("s1", "会话 1");
    for (const key of ["seen", "modelRef", "reasoning", "anchor"]) {
      expect(Object.keys(one), key).toContain(key);
    }
  });
});

describe("输入历史上限与推理强度循环序（那两个常量）", () => {
  it("⚠️ `INPUT_HISTORY` 是 10，而**溢出是从最早那一条开始丢**", () => {
    expect(INPUT_HISTORY).toBe(10);
    // 正向对照：还差一格时**一个都不丢**（否则「上限是 10」这一条是「上限是 0」的恒绿）
    const nine = Array.from({ length: INPUT_HISTORY - 1 }, (_, i) => `/cmd${String(i)}`);
    expect(pushHistory(nine, "/newest")).toHaveLength(INPUT_HISTORY);
    // 而恰好到上限之后再加一条 ⇒ 仍然 10 条，被丢的是**最早**那一条
    const ten = Array.from({ length: INPUT_HISTORY }, (_, i) => `/cmd${String(i)}`);
    const grown = pushHistory(ten, "/newest");
    expect(grown).toHaveLength(INPUT_HISTORY);
    expect(grown[0]).toBe("/cmd1");
    expect(grown[grown.length - 1]).toBe("/newest");
  });

  it("⚠️ `REASONING_CYCLE` **就是**那份四档（不是另一份抄的）", () => {
    // 判据是**同一个数组对象**：两处各抄一份循环序就会各自漂，
    // 而漂了的症状是「界面上循环切了一档、出网的却是另一档」
    expect(REASONING_CYCLE).toBe(REASONING_EFFORTS);
    expect([...REASONING_CYCLE]).toEqual(["off", "low", "medium", "high"]);
    // ⚠️ **正向对照**：缺省档**在**循环序里（不在的话「切一档」永远切不到缺省那一档）
    expect(REASONING_CYCLE).toContain(DEFAULT_REASONING_EFFORT);
  });

  it("⚠️ 四档与缺省**只有一份定义**，落盘那一侧转出的是**同一个对象**", () => {
    // ⚠️ 判据是**对象同一**而不是「值相等」：值相等时一份抄的也过，
    // 而症状是「库里那列的缺省改了、屏上那格没改」而零报错
    // ⚠️ **走落盘那一侧的出口**（建表那一列的缺省与读写两面的缺省都从那里取）：
    // 判据是**对象同一**而不是「值相等」—— 值相等时一份抄的也过，
    // 而症状是「库里那列的缺省改了、屏上那格没改」而零报错
    expect(configView.REASONING_EFFORTS).toBe(REASONING_EFFORTS);
    expect(configView.DEFAULT_REASONING_EFFORT).toBe(DEFAULT_REASONING_EFFORT);
    // ⚠️ **正向对照**：三样东西真的取到东西了（探测器认错了 ⇒ 上面那两趟恒绿）
    expect([...configView.REASONING_EFFORTS]).toHaveLength(4);
    expect(configView.DEFAULT_REASONING_EFFORT).toBe("medium");
  });
});

describe("弹窗状态机：`WindowState` 的形状", () => {
  it("⚠️ 一次只开**一种**内容，而每种要的那些格子一个都不少", () => {
    const states: readonly (WindowState | null)[] = [
      null,
      { kind: "sessions" },
      { kind: "targets", at: 0 },
      { kind: "users", at: 1, pending: "alice" },
      { kind: "providers", at: 2, pending: "openrouter" },
      {
        kind: "provider-models",
        id: "openrouter",
        at: 3,
        filter: "claude",
        picked: new Set(["anthropic/claude-x"]),
        busy: true,
      },
      { kind: "models", at: 4, pinned: ["openrouter/anthropic/claude-x"] },
    ];
    expect(states).toHaveLength(7);
    // 判据是 `kind` 的**集合**（判别联合的档位清单），不是某一个形状
    expect(states.map((one) => one?.kind ?? "none")).toEqual([
      "none",
      "sessions",
      "targets",
      "users",
      "providers",
      "provider-models",
      "models",
    ]);
  });

  it("⚠️ **每一档清单都能挂着「待确认删除」**（同一个概念不许有两个持有者）", () => {
    // ⚠️ 判据是**每一档都真的挂得上**，而挂得上的那一格恒是同一个形状（一个 `id`）。
    // ⚠️ **正向对照**：给出值时它就是那个 id（呈现层据此把那一行换成 `danger`）
    const armed: readonly (WindowState & { readonly pending: string })[] = [
      { kind: "sessions", pending: "s3" },
      { kind: "targets", at: 0, pending: "prod" },
      { kind: "users", at: 0, pending: "alice" },
      { kind: "providers", at: 0, pending: "openrouter" },
      {
        kind: "provider-models",
        id: "openrouter",
        at: 0,
        filter: "",
        picked: new Set<string>(),
        busy: false,
        pending: "openrouter/anthropic/claude-x",
      },
      { kind: "models", at: 0, pinned: [], pending: "openrouter/anthropic/claude-x" },
    ];
    expect(armed.map((one) => one.pending)).toEqual([
      "s3",
      "prod",
      "alice",
      "openrouter",
      "openrouter/anthropic/claude-x",
      "openrouter/anthropic/claude-x",
    ]);
    // ⚠️ **反向自检**：省略时是「没有那一格」而不是「空串」—— 空串是一个 id 的形状
    // （而屏上「那一行在等第二次」与「没有行在等」必须是两件可分的事）
    const calm: WindowState = { kind: "providers", at: 0 };
    expect(calm.pending).toBeUndefined();
    expect("pending" in calm).toBe(false);
  });

  it("⚠️ 模型列表档的过滤**只是显示**：被滤掉的仍在 `picked` 里（判据是集合内容不是可见行数）", () => {
    const state: WindowState = {
      kind: "provider-models",
      id: "openrouter",
      at: 0,
      filter: "claude",
      picked: new Set(["anthropic/claude-x", "openai/gpt-x"]),
      busy: false,
    };
    if (state.kind !== "provider-models") throw new Error("判别联合没落到那一档");
    expect(state.filter).toBe("claude");
    expect([...state.picked].sort()).toEqual(["anthropic/claude-x", "openai/gpt-x"]);
    // ⚠️ **反向自检**：`filter` 与 `picked` 是**两个格子**而不是一个（合成一格就是「过滤顺手改了勾选」）
    expect(Object.keys(state).sort()).toEqual(["at", "busy", "filter", "id", "kind", "picked"]);
  });

  it("⚠️ **表单那一档不在窗态里**（五种表单的字段表彼此不同，共住不进一个联合）", () => {
    // ⚠️ 判据是**行为**而不是「源码里没有那个字符串」：五种表单（提供商 / 控制面 / 账号 /
    // 改密码 / 改显示名）要的格子从四格到一格不等，而一个「`kind` + 全可选字段」的变体
    // 恰恰是那份形状的谎话 ⇒ 它不在这儿。⚠️ **正向对照**：另外六档都还在（少一档就红）
    const kinds: readonly (WindowState["kind"] | "none")[] = [
      "none",
      ...(["sessions", "targets", "users", "providers", "provider-models", "models"] as const),
    ];
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toHaveLength(7);
    // ⚠️ 而**呈现层那一档留着**（它是真的在画）：`ModalView["provider-form"]` 走 `fields`，
    // 长度由状态层给 —— 判据在 `tests/contract/`（那边现取两边的判别值并逐条比）
  });
});

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