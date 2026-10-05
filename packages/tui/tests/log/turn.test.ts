/**
 * `Turn` 的六个变体：各摊出一行，判据按 `kind` 与**色档**而不是字形
 *
 * @description
 * 这一档钉的是**`Turn` 变体清单本身**（六个，且不多不少）：漏一个变体时 `@/lib/log/turn.js:rowsOfTurn`
 * 的 `default` 那一支形参是 `never` ⇒ `tsc` 就红，**不是**运行期静默少一行。
 *
 * ⚠️ 判据是 `kind` + `LogLine.tone`，**不靠字符串嗅探**：`user`（操作者敲的那句话）与 `tool-call`
 * （模型挑的**要执行**的那条命令）曾被摊成同一种行，于是呈现层只能靠文本长相分派 ——
 * 而 `/providers` 那条命令恰好是要执行的那一条。⚠️ 故这一档钉的是「**`user` 独占 `kind:"user"` 那一档**」
 * 加「它与命令回显的文字色不同档」，而**不是**「六档两两不同」（那条是假事实，见下面那一组）。
 *
 * ⚠️ **摊平之后那一档的清单是 `LogRow` 的七档**（`user` 是其中一档），而它的折行形状归 `rows.test.ts`、
 * 它的编解码归 `codec.test.ts`。
 *
 * 这一条不变量与「为什么拆掉哪一处会红」见本目录 `AGENTS.md`。
 *
 * @module tests/log
 */

import { describe, expect, it } from "vitest";
import { flatten, type LogLine, type LogRow, type LogTone, type Turn } from "@/lib/log/index.js";
import { toolTurn } from "./_shared.js";

/** `Turn` 的六个变体各一例（⚠️ `satisfies` 逐字核那六个字面量，故「变体数是六」这件事由编译器钉住） */
const ALL_TURNS = [
  { kind: "user", text: "看看 alice" },
  { kind: "assistant", text: "她在用" },
  { kind: "tool-call", echo: { kind: "echo", text: "/users" } },
  toolTurn([{ kind: "note", text: "答" }]),
  { kind: "notice", rows: [{ kind: "note", text: "存好了" }] },
  { kind: "error", rows: [{ kind: "err", text: "boom" }] },
] as const satisfies readonly Turn[];

/** 摊一格 `Turn` 之后的行 */
function linesOf(turn: Turn): readonly LogLine[] {
  return flatten([{ id: 1, at: 0, turns: [turn] }], 40).lines;
}

describe("不变量 ⑦：`Turn` 的每个变体各摊出一行（判据按 `kind`，不靠字符串嗅探）", () => {
  /** 摊一段 `Turn` 之后的行文本 */
  function texts(turns: readonly Turn[]): string[] {
    return flatten([{ id: 1, at: 0, turns }], 40).lines.map((l) => l.text);
  }

  /** 摊一格 `Turn` 之后的色档（`none` = 这一格一个色档都没带，而那正是「认不出来」的形状） */
  function toneOf(turn: Turn): LogTone | "none" {
    return linesOf(turn)[0]?.tone ?? "none";
  }

  it("`user`：**独占** `kind:\"user\"` 那一档（呈现层按 `kind` 分派「气泡」与「一色一行」两个出口）", () => {
    // ⚠️ 判据是**行上那个判别字段**，不是字形：`❯ ` 两处都有，故拿它分派的话 `/providers`
    // 那条**要执行**的命令也会被涂成一个气泡。
    expect(linesOf({ kind: "user", text: "看看 alice" })).toHaveLength(1);
    expect(linesOf({ kind: "user", text: "看看 alice" })[0]!.kind).toBe("user");
    expect(linesOf({ kind: "user", text: "看看 alice" })[0]!.text).toBe("看看 alice");
  });

  it("`assistant`：走 `note` 那一档且色档是 `ok`（它不是本包的话，也不是错误）", () => {
    const line = linesOf({ kind: "assistant", text: "她在用" })[0]!;
    expect(line.kind).toBe("note");
    expect(line.tone).toBe("ok");
  });

  it("`tool-call`：**逐字**给那一行（它已由回显边界掩码过，本层不许再动它）", () => {
    const echo: LogRow = { kind: "echo", text: "/user pass alice ••••••" };
    expect(texts([{ kind: "tool-call", echo }])).toEqual(["/user pass alice ••••••"]);
  });

  it("`tool-result`：里面那些行**原样**摊开（`kv` 的补齐宽度由排版层算，故这一档只钉「行还在」）", () => {
    // ⚠️ 补齐到 12 显示列是 `@/lib/log/rows.ts:kvLine` 的算术，与本档无关；
    // 「`kv` 永不折行」那条判据在 `layout.test.ts` 的不变量 ① 里逐字保留着
    const lines = texts([toolTurn([{ kind: "kv", key: "k", value: "v" }])]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith("v")).toBe(true);
  });

  it("`notice`：本包自己说的话 —— 色档是 `note` 的缺省（`warn`），**不是** `err`", () => {
    // ⚠️ 判据是**色档**：硬把本包的话塞进 `error` 的话「至少留一个会话」会染上危险色，
    // 而那是一句**假事实**（拒绝不是故障）。
    const line = linesOf({ kind: "notice", rows: [{ kind: "note", text: "x" }] })[0]!;
    expect(line.kind).toBe("note");
    expect(line.tone).toBe("warn");
  });

  it("`error`：里面那些行原样摊开，而 `err` 那一档色档是 `danger`", () => {
    const line = linesOf({ kind: "error", rows: [{ kind: "err", text: "boom" }] })[0]!;
    expect(line.kind).toBe("err");
    expect(line.tone).toBe("danger");
  });

  it("⚠️ **六档里只有 `user` 摊出 `kind:\"user\"`**（气泡那个出口的判据必须**唯一**）", () => {
    // ⚠️ 锚的是**今天活着的形状**（那一档今天真的被摊出来），不是点名某个内部函数：
    // 后者在函数改名后会恒绿。正向对照就在同一行里 —— `user` 那一档取得到，其余五档取不到。
    const yieldsUser = ALL_TURNS.filter((turn) => linesOf(turn).some((l) => l.kind === "user"));
    expect(yieldsUser).toHaveLength(1);
    expect(yieldsUser[0]!.kind).toBe("user");
    expect(linesOf({ kind: "user", text: "x" })[0]!.kind).toBe("user");
  });

  it("⚠️ **用户那句话的文字色与命令回显不同档**（同色 = 只剩底色那一个通道在分派）", () => {
    // ⚠️ `DEFAULT_TONE` 是**文字色**：气泡的底色归呈现层，而文字色归这一层。
    // ⚠️ 刻意**不**取 `echo` 那一档的 `accent` —— 那会让「我说的」与「要执行的那条」在颜色上同形。
    expect(toneOf({ kind: "user", text: "看看 alice" })).toBe("muted");
    expect(toneOf({ kind: "tool-call", echo: { kind: "echo", text: "/users" } })).toBe("accent");
  });

  it("⚠️ **「模型的话」与「本包的话」色档不同**（同色 = 分不出谁在说话）", () => {
    // ⚠️ 判据锚在**今天仍存在的形状**（摊出来的 `LogLine.tone`），不是点名某个符号。
    // ⚠️ 刻意**不**断言「六档两两不同」：那是假事实 —— `tool-result` 与 `notice` 都把内部行**原样透出**
    //（色档由**行自己**决定，见 `rows.ts:DEFAULT_TONE`），两者装着同一档行时必是同一个色档。
    // 故这里钉**真的会混淆的那几对**。
    expect(toneOf({ kind: "assistant", text: "M" })).not.toBe(toneOf({ kind: "notice", rows: [{ kind: "note", text: "M" }] }));
    // ⚠️ **反向自检**：两者都**不是**缺省（少了那一档就分不出来），而失败恒在 `danger` 上
    expect(toneOf({ kind: "assistant", text: "M" })).not.toBe("none");
    expect(toneOf({ kind: "notice", rows: [{ kind: "note", text: "M" }] })).not.toBe("none");
    expect(toneOf({ kind: "error", rows: [{ kind: "err", text: "M" }] })).toBe("danger");
  });

  it("⚠️ 摊平的层**不认** `Turn`（漏一个变体必须**编译期**红，不是运行期静默少一行）", () => {
    // ⚠️ 这一档钉的是「变体清单只有六档」这个事实本身：`@/lib/log/turn.js:rowsOfTurn` 的
    // `default` 那一支形参是 `never`，漏一档时 `tsc` 就红（判据见本目录 AGENTS.md 的「编译期锁」）。
    // 锚点是**今天活着的形状**（`rowsOfTurn` 对六档都给出结果），不是点名某个内部函数。
    for (const turn of ALL_TURNS) {
      expect(flatten([{ id: 1, at: 0, turns: [turn] }], 40).height, turn.kind).toBe(1);
    }
  });
});