/**
 * @fileoverview 一格对话 ⇄ 一段 JSON：落盘那个 `messages.turns` 格的**唯一**编解码；⚠️ 两层判别各归一层（`Turn` 与 `LogRow` 都叫 `kind`，不许混成一层）
 */

// ⚠️ **走 `./rows.js` / `./turn.js` 而不是 `./index.js`**：那个 barrel 同时转发本文件，
// 于是经它取兄弟文件就是自我引用 barrel（与 `rows.ts` 引 `../format.js` 同一条理由）
import type { LogRow, LogTone } from "./rows.js";
import type { Turn } from "./turn.js";

/** ⚠️ **文案只说形状，绝不引用载荷**：解码失败的输入可能是一句用户聊天消息，而它会进错误文案 */
function shapeIsWrong(what: string, detail: string): never {
  throw new Error(`对话落盘形状不对：${what}（${detail}）`);
}

/** 一个 JSON 值；⚠️ 逐层收窄而不是到处 `as` —— 落盘的字节**不是**本包校验过的形态时必须当场拒 */
type Raw = unknown;

function asArray(value: Raw, what: string): readonly unknown[] {
  if (!Array.isArray(value)) shapeIsWrong(what, `实际是 ${typeof value}`);
  return value;
}

function asObject(value: Raw, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    shapeIsWrong(what, `实际是 ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

function asText(value: Raw, what: string): string {
  if (typeof value !== "string") shapeIsWrong(what, `实际是 ${typeof value}`);
  return value;
}

/** 色档（⚠️ **不许**「认不出来就当 `note`」：那会让一次坏数据渲染成一句本包自己说的话） */
const TONES: readonly LogTone[] = ["accent", "ok", "warn", "danger", "muted", "idle"];

/** 逐条对齐 `LogRow["kind"]`（⚠️ 表**穷尽**联合，故「加了变体忘了编解码」是编译期红而不是运行期静默少一档） */
const ROW_DECODERS: Readonly<Record<LogRow["kind"], (row: Record<string, unknown>, where: string) => LogRow>> = {
  echo: (row, where) => ({ kind: "echo", text: asText(row["text"], `${where}.text`), ...toneOf(row, where) }),
  user: (row, where) => ({ kind: "user", text: asText(row["text"], `${where}.text`), ...toneOf(row, where) }),
  head: (row, where) => ({ kind: "head", text: asText(row["text"], `${where}.text`), ...toneOf(row, where) }),
  kv: (row, where) => ({
    kind: "kv",
    key: asText(row["key"], `${where}.key`),
    value: asText(row["value"], `${where}.value`),
    ...toneOf(row, where),
  }),
  table: (row, where) => ({
    kind: "table",
    head: stringsOf(row["head"], `${where}.head`),
    rows: rowsOfTable(row["rows"], `${where}.rows`),
    ...(row["right"] === undefined ? {} : { right: numbersOf(row["right"], `${where}.right`) }),
    ...toneOf(row, where),
  }),
  note: (row, where) => ({ kind: "note", text: asText(row["text"], `${where}.text`), ...toneOf(row, where) }),
  err: (row, where) => ({ kind: "err", text: asText(row["text"], `${where}.text`), ...toneOf(row, where) }),
};

function stringsOf(value: Raw, where: string): readonly string[] {
  return asArray(value, where).map((one, at) => asText(one, `${where}[${String(at)}]`));
}

function rowsOfTable(value: Raw, where: string): readonly (readonly string[])[] {
  return asArray(value, where).map((one, at) => stringsOf(one, `${where}[${String(at)}]`));
}

function numbersOf(value: Raw, where: string): readonly number[] {
  return asArray(value, where).map((one, at) => {
    if (typeof one !== "number" || !Number.isFinite(one)) shapeIsWrong(`${where}[${String(at)}]`, "不是有限数字");
    return one;
  });
}

/** `tone` **不在**落盘字节里时返回空对象（⚠️ 不许给 `undefined`：那会让 `JSON.stringify` 与键清单对不上） */
function toneOf(row: Record<string, unknown>, where: string): { readonly tone?: LogTone } {
  const raw = row["tone"];
  if (raw === undefined) return {};
  if (typeof raw !== "string" || !TONES.includes(raw as LogTone)) {
    shapeIsWrong(`${where}.tone`, "不是那六个色档之一");
  }
  return { tone: raw as LogTone };
}

function rowOf(value: Raw, where: string): LogRow {
  const obj = asObject(value, where);
  const kind = obj["kind"];
  // ⚠️ **靠 `kind` 判别而不是字符串嗅探**，而 **`Object.hasOwn` 而不是 `in`**：
  // `in` 会答 `true` 给 `constructor` / `toString`（它们在 `Object.prototype` 上），
  // 于是 `{"kind":"constructor"}` 会被当成一个真类别而**不抛**
  if (typeof kind !== "string" || !Object.hasOwn(ROW_DECODERS, kind)) {
    shapeIsWrong(`${where}.kind`, `不认识的行类别 ${String(kind)}`);
  }
  return ROW_DECODERS[kind as LogRow["kind"]](obj, where);
}

const TURN_DECODERS: Readonly<Record<Turn["kind"], (turn: Record<string, unknown>, where: string) => Turn>> = {
  user: (turn, where) => ({ kind: "user", text: asText(turn["text"], `${where}.text`) }),
  assistant: (turn, where) => ({ kind: "assistant", text: asText(turn["text"], `${where}.text`) }),
  "tool-call": (turn, where) => ({ kind: "tool-call", echo: rowOf(turn["echo"], `${where}.echo`) }),
  "tool-result": (turn, where) => ({ kind: "tool-result", rows: rowListOf(turn["rows"], `${where}.rows`) }),
  notice: (turn, where) => ({ kind: "notice", rows: rowListOf(turn["rows"], `${where}.rows`) }),
  error: (turn, where) => ({ kind: "error", rows: rowListOf(turn["rows"], `${where}.rows`) }),
};

/** ⚠️ 刻意**不叫** `rowsOfTurn`：那个名字已经是 `@/lib/log/turn.js` 里「`Turn` → `LogRow[]`」的既有出口 */
function rowListOf(value: Raw, where: string): readonly LogRow[] {
  return asArray(value, where).map((one, at) => rowOf(one, `${where}[${String(at)}]`));
}

function turnOf(value: Raw, where: string): Turn {
  const obj = asObject(value, where);
  const kind = obj["kind"];
  if (typeof kind !== "string" || !Object.hasOwn(TURN_DECODERS, kind)) {
    shapeIsWrong(`${where}.kind`, `不认识的对话类别 ${String(kind)}`);
  }
  return TURN_DECODERS[kind as Turn["kind"]](obj, where);
}

/** 一格对话 → 落盘的那段 JSON（⚠️ **逐字交给 `JSON.stringify`**：键序与选填键的有无归 `Turn` 自己，重排过就未必是同一段字节了） */
export function encodeTurns(turns: readonly Turn[]): string {
  return JSON.stringify(turns);
}

/** 落盘的那段 JSON → 一格对话（@throws {Error} 字节**不是**本包校验过的形态时；⚠️ **绝不降级成空对话** —— 那会让一次坏数据看起来像「这个会话还没说过话」） */
export function decodeTurns(text: string): readonly Turn[] {
  let parsed: Raw;
  try {
    parsed = JSON.parse(text) as Raw;
  } catch {
    shapeIsWrong("turns", "不是一段 JSON");
  }
  return asArray(parsed, "turns").map((one, at) => turnOf(one, `turns[${String(at)}]`));
}