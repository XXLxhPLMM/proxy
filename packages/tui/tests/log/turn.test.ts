/**
 * `Turn` 的六个变体：各摊出一行，判据按 `kind` 与**色档**而不是字形
 *
 * @description
 * 这一档钉的是**变体清单本身**（六个，且不多不少）：漏一个变体时 `@/lib/log/turn.js:rowsOfTurn`
 * 的 `default` 那一支形参是 `never` ⇒ `tsc` 就红，**不是**运行期静默少一行。
 *
 * ⚠️ 判据是 `kind` + `LogLine.tone`，**不靠字符串嗅探**：同形的两档（`user` 与 `tool-call` 都走
 * `echo`，`tool-result` 与 `notice` 都把内部行原样透出）由内容而不是色档分开，故「六档两两不同」
 * 是一条假事实，本目录只钉**真的会混淆的那一对**（模型的话 vs 本包的话）。
 *
 * 这一条不变量与「为什么拆掉哪一处会红」见本目录 `AGENTS.md`。
 *
 * @module tests/log
 */

import { describe, expect, it } from "vitest";
import { flatten, type LogRow, type Turn } from "@/lib/log/index.js";
import { toolTurn } from "./_shared.js";

describe("不变量 ⑦：`Turn` 的每个变体各摊出一行（判据按 `kind`，不靠字符串嗅探）", () => {
  /** 摊一段 `Turn` 之后的行文本 */
  function texts(turns: readonly Turn[]): string[] {
    return flatten([{ id: 1, at: 0, turns }], 40).lines.map((l) => l.text);
  }

  it("`user`：走 `echo` 那一档（呈现层给它加 `❯ `，于是「我敲的」与「回显的命令」同形）", () => {
    expect(texts([{ kind: "user", text: "看看 alice" }])).toEqual(["看看 alice"]);
  });

  it("`assistant`：走 `note` 那一档且色档是 `ok`（它不是本包的话，也不是错误）", () => {
    const flat = flatten([{ id: 1, at: 0, turns: [{ kind: "assistant", text: "她在用" }] }], 40);
    expect(flat.lines[0]!.kind).toBe("note");
    expect(flat.lines[0]!.tone).toBe("ok");
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
    const flat = flatten([{ id: 1, at: 0, turns: [{ kind: "notice", rows: [{ kind: "note", text: "x" }] }] }], 40);
    expect(flat.lines[0]!.kind).toBe("note");
    expect(flat.lines[0]!.tone).toBe("warn");
  });

  it("`error`：里面那些行原样摊开，而 `err` 那一档色档是 `danger`", () => {
    const flat = flatten([{ id: 1, at: 0, turns: [{ kind: "error", rows: [{ kind: "err", text: "boom" }] }] }], 40);
    expect(flat.lines[0]!.kind).toBe("err");
    expect(flat.lines[0]!.tone).toBe("danger");
  });

  it("⚠️ **「模型的话」与「本包的话」色档不同**（同色 = 分不出谁在说话）", () => {
    // ⚠️ 判据锚在**今天仍存在的形状**（摊出来的 `LogLine.tone`），不是点名某个符号。
    // ⚠️ 刻意**不**断言「六档两两不同」：那是假事实 —— `user` 与 `tool-call` 都走 `echo` 那一档
    //（两者都是「喂进去的东西」，由内容而不是色档分开），`tool-result` 与 `notice` 都把内部行原样透出
    //（色档由**行自己**决定，见 `rows.ts:DEFAULT_TONE`）。故这里只钉**真的会混淆的那一对**。
    const toneOf = (turn: Turn): string =>
      flatten([{ id: 1, at: 0, turns: [turn] }], 40).lines[0]!.tone ?? "none";
    const model = toneOf({ kind: "assistant", text: "M" });
    const mine = toneOf({ kind: "notice", rows: [{ kind: "note", text: "M" }] });
    expect(model).not.toBe(mine);
    // ⚠️ **反向自检**：两者都**不是**缺省（少了那一档就分不出来），而失败恒在 `danger` 上
    expect(model).not.toBe("none");
    expect(mine).not.toBe("none");
    expect(toneOf({ kind: "error", rows: [{ kind: "err", text: "M" }] })).toBe("danger");
  });

  it("⚠️ 摊平的层**不认** `Turn`（漏一个变体必须**编译期**红，不是运行期静默少一行）", () => {
    // ⚠️ 这一档钉的是「变体清单只有六档」这个事实本身：`@/lib/log/turn.js:rowsOfTurn` 的
    // `default` 那一支形参是 `never`，漏一档时 `tsc` 就红（判据见本目录 AGENTS.md 的「编译期锁」）。
    // 锚点是**今天活着的形状**（`rowsOfTurn` 对六档都给出结果），不是点名某个内部函数。
    for (const turn of [
      { kind: "user", text: "x" },
      { kind: "assistant", text: "x" },
      { kind: "tool-call", echo: { kind: "echo", text: "x" } },
      toolTurn([{ kind: "note", text: "x" }]),
      { kind: "notice", rows: [{ kind: "note", text: "x" }] },
      { kind: "error", rows: [{ kind: "err", text: "x" }] },
    ] satisfies readonly Turn[]) {
      expect(flatten([{ id: 1, at: 0, turns: [turn] }], 40).height).toBe(1);
    }
  });
});
