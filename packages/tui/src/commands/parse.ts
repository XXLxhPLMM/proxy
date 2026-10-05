/** @fileoverview 一行文本 → 一条命令：只回答「是哪条命令」与「参数齐不齐」，出参是判别联合（纯逻辑，零 IO、零终端、零 React） */

import {
  COMMAND_PREFIX,
  findSpec,
  type ArgSpec,
  type BatchDraft,
  type Command,
  type CommandSpec,
} from "./specs.js";
import { ValueError } from "./values.js";
import { suggestCommands, withPrefix } from "./suggest.js";

// 本文件是这一层的默认入口：下面三段 `export ... from` 是表格、值的读法与建议对外承诺的**唯一**转发点。
export {
  COMMAND_NAMES,
  COMMAND_PREFIX,
  COMMAND_SPECS,
  findSpec,
  type BatchDraft,
  type Command,
  type CommandSpec,
  type CompletionNames,
} from "./specs.js";
export { ALL_TARGETS, UNLIMITED_BYTES, readTraffic } from "./values.js";
export { suggestCommands } from "./suggest.js";

/** 词的边界：任何空白。⚠️ 用**字符类**而不是 `" "` —— 制表符也是词边界 */
const WHITESPACE = /\s/;

/** 一个词 + 它在**原文**里的结束下标（⚠️ 下标是 UTF-16 code unit，与插入符同一套） */
interface Word {
  readonly text: string;
  /** 这个词（含它内部的引号与转义）之后的位置 */
  readonly end: number;
}

/** 分词失败的两档：`unterminated-quote`（引号只开不闭）/ `unterminated-escape`（行尾裸反斜杠） */
export type TokenizeReason = "unterminated-quote" | "unterminated-escape";

/** {@link tokenize} 的结果（判别联合，不是「数组 + 可选 error」） */
export type TokenizeResult =
  | { readonly ok: true; readonly tokens: readonly string[] }
  | { readonly ok: false; readonly reason: TokenizeReason };

/**
 * 把一行文本切成词：空白分隔，`"` 与 `'` 都成对（引号内的空白是词的一部分）；⚠️ **空的引号是一个空词**（`user pass alice ""` = 把密码设成空串，200；而「没给」是 400）
 */
/** ⚠️ **未闭合的引号是失败，不是「把后半行都吞掉」**：吞掉的后果是 `user add alice "1g` 变成建出一个**不限量**的账号 */
export function tokenize(line: string): TokenizeResult {
  const spanned = tokenSpans(line);
  if (spanned.ok === false) return spanned;
  return { ok: true, tokens: spanned.words.map((one) => one.text) };
}

/** 同 {@link tokenize}，而每个词**多带一个它在原文里的结束下标**（⚠️ 给 `rest` 那一格用） */
function tokenSpans(line: string): { ok: true; words: readonly Word[] } | { ok: false; reason: TokenizeReason } {
  const words: Word[] = [];
  let current = "";
  /** 这个词**已开始**了吗 —— 与「内容为空」区分开，正是空引号那条规则的实现处 */
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (ch === "\\") {
      const next = line[i + 1];
      if (next === undefined) return { ok: false, reason: "unterminated-escape" };
      current += next;
      started = true;
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (WHITESPACE.test(ch)) {
      if (started) {
        words.push({ text: current, end: i });
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote !== null) return { ok: false, reason: "unterminated-quote" };
  if (started) words.push({ text: current, end: line.length });
  return { ok: true, words };
}

/** 一次解析的结果（判别联合而不是「数组 + 可选 error」：`if (result.error)` 会让忘了判错误编译通过） */
export type ParseResult =
  /** 语法正确、字段齐了，带**规范化后**的参数（用量上限是字节数、键名与用户名逐字保留） */
  | { readonly kind: "ok"; readonly command: Command }
  /** 只有空白 —— ⚠️ **不是错误**，是「什么都不做」（回车不该在结果区留下一条消息） */
  | { readonly kind: "empty" }
  /** 这一行**不以 {@link COMMAND_PREFIX} 开头**（带最接近的那几个） */
  | {
      readonly kind: "missing-prefix";
      readonly suggestions: readonly string[];
      readonly message: string;
    }
  /** 命令名不认识（带最接近的那几个；**不回显**敲了什么） */
  | {
      readonly kind: "unknown-command";
      readonly suggestions: readonly string[];
      readonly message: string;
    }
  /** 参数个数不对（含「引号没闭合」） */
  | {
      readonly kind: "bad-args";
      readonly name: string | null;
      readonly usage: string | null;
      readonly message: string;
    }
  /** 某个值解析不出来（`1.5x` / `a,,b` / 空名字）；`argIndex` 从 1 起 */
  | {
      readonly kind: "bad-value";
      readonly name: string | null;
      readonly argIndex: number;
      readonly usage: string | null;
      readonly message: string;
    };

/** 一行分词失败时的文案（不给 `name` / `usage`：词流已经不可信，说不出是哪条命令） */
const TOKEN_FAILURES: Readonly<Record<TokenizeReason, string>> = {
  "unterminated-quote": "这一行里有没闭合的引号（引号内的空格算一个词的一部分）",
  "unterminated-escape": "这一行末尾有一个没有后继字符的反斜杠",
};

// ⚠️ **命令名就是一个词**（表里没有组）：词流里第一个词查不到就是 `unknown-command`，而「多敲一段」
// 落到「多给了 N 个参数」那一档 —— 那是对的处理，不许把它悄悄当成子命令

/** 一行文本 → 一条命令；首尾空白先 trim（于是「回车」按两次是一样的话），`/` **不进词**，故 `/batch all /status` 就是三个词 */
export function parseLine(line: string): ParseResult {
  const text = line.trim();
  if (text === "") return { kind: "empty" };
  if (!text.startsWith(COMMAND_PREFIX)) {
    return {
      kind: "missing-prefix",
      suggestions: withPrefix(suggestCommands(text)),
      message: `每一条命令都要以 ${COMMAND_PREFIX} 开头`,
    };
  }
  const spanned = tokenSpans(text.slice(COMMAND_PREFIX.length));
  if (spanned.ok === false) {
    return {
      kind: "bad-args",
      name: null,
      usage: null,
      message: TOKEN_FAILURES[spanned.reason],
    };
  }
  const words = spanned.words.map((one) => one.text);
  if (words.length === 0) return { kind: "empty" };

  const spec = findSpec(words[0] as string);
  if (spec === undefined) {
    return {
      kind: "unknown-command",
      suggestions: withPrefix(suggestCommands(words[0] as string)),
      message: `不认识的命令（${COMMAND_PREFIX}help 可以看全部命令）`,
    };
  }

  const rest = words.slice(1);
  const required = spec.args.filter((one) => one.required).length;
  if (rest.length < required) {
    return {
      kind: "bad-args",
      name: spec.name,
      usage: spec.usage,
      message: `参数不够；用法是 ${spec.usage}`,
    };
  }
  // ⚠️ **`rest` 那一格吃下剩下的全部词**，于是「多给了几个参数」对它不成立
  // —— 而个数判据必须**在它之前**分岔，否则 `/batch all /help "user add"` 会被判成「多给了 3 个」
  if (rest.length > spec.args.length && !spec.args.some((one) => one.rest === true)) {
    return {
      kind: "bad-args",
      name: spec.name,
      usage: spec.usage,
      message: `多给了 ${rest.length - spec.args.length} 个参数；用法是 ${spec.usage}`,
    };
  }

  const values: unknown[] = [];
  // ⚠️ **`rest` 那一格吃下原文**：从「命令名结束」那一处切到行尾，逐字保留引号 ——
  // 分词再拼回去会把内层那一行里的引号拆了，于是它读回来已经不是同一句话
  const restAt = spec.args.findIndex((one) => one.rest === true);
  const tailStart = restAt < 0 ? 0 : (spanned.words[restAt]?.end ?? 0);
  const tail = text.slice(COMMAND_PREFIX.length + tailStart).trim();
  for (let i = 0; i < spec.args.length; i += 1) {
    const declared = spec.args[i] as ArgSpec<unknown>;
    if (declared.rest === true) {
      values.push(tail);
      continue;
    }
    const raw = rest[i];
    // ⚠️ 选填形参在末尾（见 `./specs.js` 的 `opt`），故 `undefined` 只能是「没给」，不会是「给了但读不出」
    if (raw === undefined) {
      values.push(undefined);
      continue;
    }
    try {
      values.push(declared.read(raw));
    } catch (err) {
      // 读单个形参的 `read` 不知道自己在第几位（它只拿到那一个字符串），由这一层补上
      if (err instanceof ValueError) return badValue(spec, err.argIndex ?? i + 1, err.message);
      throw err;
    }
  }
  try {
    // 擦除：形参表是异构元组（`Values<A>` 那侧有类型），这里对外只承诺一组值
    return { kind: "ok", command: resolveDraft(spec.build(values as readonly any[])) };
  } catch (err) {
    if (err instanceof ValueError) {
      // ⚠️ 兜底是「最后一个形参」：`build` 抛的那一档不知道自己在第几位（`parseLine` 是唯一知道的人）
      return badValue(spec, err.argIndex ?? spec.args.length, err.message);
    }
    throw err;
  }
}

/** 这个产物**还欠一次递归解析**吗（⚠️ 按 `line` 在不在判，而不是按 `kind` —— 两档的 `kind` 相同） */
function isDraft(draft: Command | BatchDraft): draft is BatchDraft {
  return "line" in draft;
}

/** `build` 的产物 → 真命令（⚠️ **只有 `/batch` 一条**要收尾：递归解一次，而不是留原文给上层再解） */
function resolveDraft(draft: Command | BatchDraft): Command {
  if (!isDraft(draft)) return draft;
  // ⚠️ 内层那一行**必须自带前缀**（`/batch all /status`）：`readTargets` 那一格之后剩下的就是它，
  // 而用户敲的就是带前缀的样子 —— 补一个前缀的话 `/batch all users` 也会通，那条契约就没了
  const inner = parseLine(draft.line);
  if (inner.kind !== "ok") {
    throw new ValueError(null, `内层命令不对（${inner.kind}）：${describeFailure(inner)}`);
  }
  return { kind: "batch", targets: draft.targets, command: inner.command, line: draft.line };
}

/** 一次内层解析失败的一句话（⚠️ **不转述用户输入**：`bad-value` 的 message 只说形状，理由见 `./values.ts`） */
function describeFailure(failed: Exclude<ParseResult, { kind: "ok" }>): string {
  return "message" in failed ? failed.message : "那一行什么也不是";
}

/** 一次「某个值不合法」的失败（`name` / `usage` 来自命令表，文案里没有用户输入） */
function badValue(
  spec: CommandSpec,
  argIndex: number,
  message: string,
): {
  readonly kind: "bad-value";
  readonly name: string;
  readonly argIndex: number;
  readonly usage: string;
  readonly message: string;
} {
  return { kind: "bad-value", name: spec.name, argIndex, usage: spec.usage, message };
}