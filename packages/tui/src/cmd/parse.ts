/**
 * @fileoverview 一行文本 → 一条命令（**纯逻辑**：零 IO、零终端、零网络、零 React）
 * @module cmd/parse
 * @description
 * 本文件只回答两个问题：「用户敲的这些字是**哪条命令**」与「**参数齐不齐**」。怎么执行是别人的事：执行层
 * 只拿到 {@link Command} 那个判别联合，于是「命令表里的一行」与「执行层的一个分支」在**类型上**不可能
 * 各说各话。命令表在 `./specs.js`、形参值的读法在 `./values.js`、建议在 `./suggest.js`。
 *
 * ⚠️ **每一行命令都以 {@link COMMAND_PREFIX} 开头，而它是整行的形状**（`/status` 是一条命令，`status`
 * 不是）：这条判据住在**本层**（{@link parseLine}），而命令名出现在解析、`help` 的呈现、错误文案与补全
 * 四处，故呈现侧只许读 `CommandSpec.path`（**算出来的**）。⚠️ **不许「宽容地」接受不带 `/` 的写法** ——
 * 那会让这条不变量变成一句没有牙齿的话（两套写法都能跑，而其中一套会在下一版消失），故 {@link ParseResult}
 * 另有**专门的** `missing-prefix` 档。
 *
 * ⚠️ 结果是**判别联合**而不是「一个对象加一个可选的 error」：`if (result.error)` 会让「忘了判错误」编译
 * 通过、运行时把一条 `ok` 当成空操作，故每个分支**只带自己用得到的字段**。⚠️ 任何失败文案都**不回显用户
 * 输入** —— 纪律与理由在 `./values.js` 文件头。
 */

import { COMMAND_PREFIX, findSpec, type ArgSpec, type Command, type CommandSpec } from "./specs.js";
import { ValueError } from "./values.js";
import { suggestCommands, withPrefix } from "./suggest.js";

// 本文件是这一层的默认入口：下面三段 `export ... from` 是表格、值的读法与建议对外承诺的**唯一**转发点。
export {
  COMMAND_NAMES,
  COMMAND_PREFIX,
  COMMAND_SPECS,
  TOP_LEVEL_NAMES,
  findSpec,
  type Command,
  type CommandSpec,
  type CompletionNames,
  type UserSetCommand,
} from "./specs.js";
export {
  QUOTA_WINDOWS,
  UNLIMITED_BYTES,
  USER_FIELDS,
  type QuotaWindow,
  type UserField,
  type UserFieldsAreComplete,
  type UserValueOf,
} from "./values.js";
export { suggestCommands } from "./suggest.js";

/** 词的边界：任何空白。⚠️ 用**字符类**而不是 `" "` —— 制表符也是词边界 */
const WHITESPACE = /\s/;

/** 分词失败的两档：`unterminated-quote`（引号只开不闭）/ `unterminated-escape`（行尾裸反斜杠） */
export type TokenizeReason = "unterminated-quote" | "unterminated-escape";

/** {@link tokenize} 的结果（判别联合，不是「数组 + 可选 error」） */
export type TokenizeResult =
  | { readonly ok: true; readonly tokens: readonly string[] }
  | { readonly ok: false; readonly reason: TokenizeReason };

/**
 * 把一行文本切成词
 * @description 空白分隔；`"` 与 `'` 都成对，**引号内的空白是词的一部分**（一个词的唯一判据是「用户怎么读
 * 它」而不是「有没有空格」）；反斜杠在引号内外一致地转义下一个字符。⚠️ **空的引号是一个空词**：
 * `user pass alice ""` 意为「把密码设成空串」，而它与「没给这个参数」在服务端是两件不同的事（前者 200、
 * 一个空密码账号；后者 400）。⚠️ **未闭合的引号是失败，不是「把后半行都吞掉」**：吞掉的后果是
 * `user add alice "1g` 变成一次 `user add alice`（建出一个**不限量**的账号）。
 *
 * @param line - 整行输入（**不** trim：由分词器自己把首尾空白当分隔）
 * @returns 成功时给词数组（可能为空数组 = 全是空白）；失败时给一档原因
 */
export function tokenize(line: string): TokenizeResult {
  const tokens: string[] = [];
  /** 当前正在攒的那个词（可能已攒了内容，也可能只有一个开引号） */
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
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote !== null) return { ok: false, reason: "unterminated-quote" };
  if (started) tokens.push(current);
  return { ok: true, tokens };
}

/** 一次解析的结果（判别联合，见文件头；每个分支**只带自己用得到的字段**） */
export type ParseResult =
  /** 语法正确、字段齐了，带**规范化后**的参数（流量上限是字节数、字段名是规范拼写） */
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
  /** 参数个数不对（含「组少一个子命令」「引号没闭合」） */
  | {
      readonly kind: "bad-args";
      readonly name: string | null;
      readonly usage: string | null;
      readonly message: string;
    }
  /** 某个值解析不出来（`1.5x` / `1e30g` / 字段名非法）；`argIndex` 从 1 起 */
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

/** {@link resolveFrom} 的三种结果（`missing-sub` 与 `bad-sub` 都是「参数不对」，分档是为了给不同的话） */
type Resolution =
  | { readonly type: "command"; readonly spec: CommandSpec; readonly consumed: number }
  /** 给了组而没给子命令 */
  | { readonly type: "missing-sub"; readonly spec: CommandSpec }
  /** 给了子命令而它不在闭合集里 */
  | { readonly type: "bad-sub"; readonly spec: CommandSpec };

/**
 * 从 `words[0]` 起逐级下潜
 * @description ⚠️ 只走**两级**（`user add` / `target switch`）：命令表里最深就是两级，而一个能走
 * 任意层的循环会在「表里多了一级」那天静默地放过一层没人定义过的命令。
 */
function resolveFrom(words: readonly string[]): Resolution | null {
  const head = findSpec(words[0] as string);
  if (head === undefined) return null;
  if (head.subs.length === 0) return { type: "command", spec: head, consumed: 1 };
  const sub = words[1];
  if (sub === undefined) return { type: "missing-sub", spec: head };
  const child = findSpec(`${head.name} ${sub}`);
  if (child === undefined) return { type: "bad-sub", spec: head };
  return { type: "command", spec: child, consumed: 2 };
}

/**
 * 一行文本 → 一条命令
 * @description 本函数**不抛**（输入侧的每一种坏法都收敛成 {@link ParseResult} 的某一档），也不碰执行。
 * 首尾空白先 trim（于是「回车」按两次是一样的话），然后：全空 → `empty`（**不是错误**）；开头不是 `/`
 * → `missing-prefix`；否则把**去掉 `/` 之后**的那一段交给分词器 —— `/` 不进词，于是 `/user add` 就是
 * 两个词。
 *
 * @param line - 整行输入（未分词）
 * @returns {@link ParseResult} 的某一档
 */
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
  const tokenized = tokenize(text.slice(COMMAND_PREFIX.length));
  if (tokenized.ok === false) {
    return {
      kind: "bad-args",
      name: null,
      usage: null,
      message: TOKEN_FAILURES[tokenized.reason],
    };
  }
  const words = tokenized.tokens;
  if (words.length === 0) return { kind: "empty" };

  const resolved = resolveFrom(words);
  if (resolved === null) {
    return {
      kind: "unknown-command",
      suggestions: withPrefix(suggestCommands(words[0] as string)),
      message: `不认识的命令（${COMMAND_PREFIX}help 可以看全部命令）`,
    };
  }
  if (resolved.type !== "command") {
    const { spec } = resolved;
    return {
      kind: "bad-args",
      name: spec.name,
      usage: spec.usage,
      message:
        (resolved.type === "missing-sub" ? "少一个子命令；" : "子命令不在闭合集里；") +
        `${spec.path} 的子命令是 ${withPrefix(spec.subs.map((one) => `${spec.name} ${one}`)).join(" / ")}`,
    };
  }
  const { spec, consumed } = resolved;

  const rest = words.slice(consumed);
  const required = spec.args.filter((one) => one.required).length;
  if (rest.length < required) {
    return {
      kind: "bad-args",
      name: spec.name,
      usage: spec.usage,
      message: `参数不够；用法是 ${spec.usage}`,
    };
  }
  if (rest.length > spec.args.length) {
    return {
      kind: "bad-args",
      name: spec.name,
      usage: spec.usage,
      message: `多给了 ${rest.length - spec.args.length} 个参数；用法是 ${spec.usage}`,
    };
  }

  const values: unknown[] = [];
  for (let i = 0; i < spec.args.length; i += 1) {
    const raw = rest[i];
    // ⚠️ 选填形参在末尾（见 `./specs.js` 的 `opt`），故 `undefined` 只能是「没给」，不会是「给了但读不出」
    if (raw === undefined) {
      values.push(undefined);
      continue;
    }
    try {
      values.push((spec.args[i] as ArgSpec<unknown>).read(raw));
    } catch (err) {
      // 读单个形参的 `read` 不知道自己在第几位（它只拿到那一个字符串），由这一层补上
      if (err instanceof ValueError) return badValue(spec, err.argIndex ?? i + 1, err.message);
      throw err;
    }
  }
  try {
    // 擦除：形参表是异构元组（`Values<A>` 那侧有类型），这里对外只承诺一组值
    return { kind: "ok", command: spec.build(values as readonly any[]) };
  } catch (err) {
    if (err instanceof ValueError) {
      // ⚠️ 兜底是「最后一个形参」：值的读法由 `build` 按字段决定（见 `user set` 那个声明），
      // 故它出错的位置永远是值那一格。
      return badValue(spec, err.argIndex ?? spec.args.length, err.message);
    }
    throw err;
  }
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