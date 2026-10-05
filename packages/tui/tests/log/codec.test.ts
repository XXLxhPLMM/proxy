/**
 * 一格对话 ⇄ 一段 JSON：`encodeTurns` / `decodeTurns` 的**穷举**与拒收
 *
 * @description
 * 判据的对象是**那段字节**与解出来的 `Turn[]`：`messages.turns` 那一格是本包与磁盘之间唯一的
 * 对话形状，故「读回来再写回去必须是同一段字节」是一条不变式（编解码一旦不幂等，重启一次就变形一次）。
 *
 * ⚠️ 落盘那一半（`seq` / `at` 哪来的、收口、坏内容即拒的档位）在 `tests/sqlite/messages.test.ts`；
 * 掩码为什么早就打过了在那一档。这一档只管**编解码**。
 *
 * @module tests/log
 */

import { describe, expect, it } from "vitest";
import { decodeTurns, encodeTurns, type LogRow, type Turn } from "@/lib/log/index.js";

/** 六个 `Turn` 变体各一例（⚠️ `satisfies` 逐字核那六个字面量，故「变体数是六」这件事由编译器钉住） */
const TURNS = [
  { kind: "user", text: "查一下账号" },
  { kind: "assistant", text: "我去查" },
  { kind: "tool-call", echo: { kind: "echo", text: "/users" } },
  { kind: "tool-result", rows: [{ kind: "note", text: "结果" }] },
  { kind: "notice", rows: [{ kind: "kv", key: "模式", value: "master" }] },
  { kind: "error", rows: [{ kind: "err", text: "连不上" }] },
] as const satisfies readonly Turn[];

/** 六个 `LogRow` 变体各一例（⚠️ 同上：六个字面量由编译器逐字核） */
const ROWS = [
  { kind: "echo", text: "/users" },
  { kind: "head", text: "账号" },
  { kind: "kv", key: "模式", value: "master", tone: "ok" },
  { kind: "table", head: ["用户名", "字节"], rows: [["bob", "1024"]], right: [1] },
  { kind: "note", text: "账本可能滞后" },
  { kind: "err", text: "读不出来", tone: "danger" },
] as const satisfies readonly LogRow[];

/** ⚠️ `table` 的 `right` 与每一档的 `tone` 都在用例里，而 `tone` 缺席的那几档也各有一例 */
/**
 * 把一对 `(Turn 变体, LogRow 变体)` 装进**同一格**
 * @description ⚠️ `user` / `assistant` 那一档带的是 `text` 而不是行，故那一对的行挂在同一格里**另一**档上：
 * 那样 6 × 6 那一对是**真的**被一起编解码过，而不是「那一对不成立就跳过了」
 */
function cellOf(turn: Turn, row: LogRow): readonly Turn[] {
  if (turn.kind === "tool-call") return [turn, { kind: "tool-call", echo: row }];
  if (turn.kind === "user" || turn.kind === "assistant") return [turn, { kind: "tool-result", rows: [row] }];
  return [turn, { kind: turn.kind, rows: [row] }];
}

describe("往返：`encodeTurns(decodeTurns(x)) === x`（⚠️ x 是**落盘的字节**）", () => {
  it.each(ROWS.map((row) => [row.kind, row] as const))("%s 这一档", (kind, row) => {
    const x = encodeTurns([{ kind: "tool-result", rows: [row] }] as readonly Turn[]);
    expect(decodeTurns(x)).toEqual([{ kind: "tool-result", rows: [row] }] as readonly Turn[]);
    // ⚠️ 判据是**字节逐字相等**，不是「解出来看着一样」：键序或选填键的有无变了都会红
    expect(encodeTurns(decodeTurns(x))).toBe(x);
  });

  it.each(TURNS.map((turn) => [turn.kind, turn] as const))("%s 这一档", (kind, turn) => {
    const x = encodeTurns([turn] as readonly Turn[]);
    expect(decodeTurns(x)).toEqual([turn] as readonly Turn[]);
    expect(encodeTurns(decodeTurns(x))).toBe(x);
  });

  it("⚠️ **全部十二个组合**（`Turn` 六档 × `LogRow` 六档）各一例，逐字往返", () => {
    for (const turn of TURNS) {
      for (const row of ROWS) {
        const cell = cellOf(turn, row);
        const x = encodeTurns(cell);
        expect(decodeTurns(x), `${turn.kind} × ${row.kind}`).toEqual(cell);
        expect(encodeTurns(decodeTurns(x)), `${turn.kind} × ${row.kind}`).toBe(x);
      }
    }
  });

  it("一格里好几格对话按数组序往返（⚠️ 顺序也是落盘的一部分）", () => {
    const x = encodeTurns([...TURNS] as readonly Turn[]);
    expect(decodeTurns(x)).toEqual([...TURNS] as readonly Turn[]);
    expect(encodeTurns(decodeTurns(x))).toBe(x);
  });

  it("空数组往返（一个还没说过话的会话在盘上就是 `[]`）", () => {
    const x = encodeTurns([]);
    expect(x).toBe("[]");
    expect(decodeTurns(x)).toEqual([]);
  });

  it("⚠️ **选填的 `tone` / `right` 不在字节里时，解回来也不许有那个键**", () => {
    // ⚠️ 判据是键清单：`tone: undefined` 也能让 `toEqual` 绿，而它会让下一次写出的字节与上一次不同
    const x = encodeTurns([{ kind: "tool-result", rows: [{ kind: "note", text: "x" }] }]);
    expect(x).not.toContain("tone");
    expect(Object.keys(decodeTurns(x)[0] as Turn)).toEqual(["kind", "rows"]);
    expect(Object.keys((decodeTurns(x)[0] as { readonly rows: readonly LogRow[] }).rows[0]!)).toEqual([
      "kind",
      "text",
    ]);
  });
});

describe("拒收：不像一个 `Turn` 就抛（⚠️ 「不认识就当 `note`」是本层要防的那句假事实）", () => {
  const bad: ReadonlyArray<readonly [string, string]> = [
    ["对话类别不认识", '[{"kind":"没听说过的变体","text":"x"}]'],
    ["行类别不认识", '[{"kind":"notice","rows":[{"kind":"没听说过的行"}]}]'],
    ["不是数组", '{"kind":"user","text":"x"}'],
    ["不是 JSON", "这不是 JSON"],
    ["元素不是对象", "[1]"],
    ["整个是 null", "null"],
  ];

  it.each(bad)("%s", (label, text) => {
    expect(() => decodeTurns(text), label).toThrow();
  });

  it("⚠️ `tool-call` 的 `echo` 不是一个 `LogRow` ⇒ 抛", () => {
    expect(() => decodeTurns('[{"kind":"tool-call","echo":{"kind":"user","text":"x"}}]')).toThrow();
  });

  it("⚠️ `table` 的表头不是字符串数组 ⇒ 抛（`head` 与每行长度相等那条判据归摊平那一层）", () => {
    expect(() => decodeTurns('[{"kind":"notice","rows":[{"kind":"table","head":[1],"rows":[]}]}]')).toThrow();
    expect(() => decodeTurns('[{"kind":"notice","rows":[{"kind":"table","head":[],"rows":"x"}]}]')).toThrow();
  });

  it("⚠️ `tone` 不是那六个色档之一 ⇒ 抛", () => {
    expect(() => decodeTurns('[{"kind":"notice","rows":[{"kind":"note","text":"x","tone":"chartreuse"}]}]')).toThrow();
  });

  it("⚠️ **文案只说形状，绝不引用载荷**（`turns` 里可能是一句用户聊天消息，而它会进错误文案）", () => {
    const secret = "这句话不该出现在错误文案里";
    let thrown: unknown;
    try {
      decodeTurns(JSON.stringify([{ kind: "note", text: secret }]));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(secret);
    expect((thrown as Error).message).toContain("turns");
  });

  it("⚠️ 判据自检：判据看得见「一个合法字节不被拒」（否则上面那组全是恒绿）", () => {
    const x = encodeTurns([{ kind: "user", text: "查一下" }]);
    expect(() => decodeTurns(x)).not.toThrow();
    expect(decodeTurns(x)).toEqual([{ kind: "user", text: "查一下" }]);
  });

  it("⚠️ 判据自检：`Object.prototype` 上的字段名撞不出一个 `Turn`", () => {
    // ⚠️ 用 `in` 判类别时这是唯一的洞：`constructor` / `toString` 都能撞上一个存在着的键
    expect(() => decodeTurns('[{"kind":"constructor"}]')).toThrow();
    expect(() => decodeTurns('[{"kind":"toString","text":"x"}]')).toThrow();
  });
});