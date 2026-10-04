/** @fileoverview 打字的建议：输入「这一行 + 光标在哪」→ 候选与补全后那一行（纯函数，零 IO、零终端、零 React）；⚠️ 它**不执行**命令，也不决定「按 Tab 就接受」 */

import {
  COMMAND_PREFIX,
  findSpec,
  type CommandSpec,
  type CompletionNames,
} from "./parse.js";

/** 词的边界：任何空白（⚠️ 与 {@link ./parse.ts} 的分词器同一套判据；切词**不认引号**，引号只在插入时由 `render` 补） */
const WHITESPACE = /\s/;

/** 分词器当 special 的四个字符（空白 + 两种引号 + 反斜杠）—— 候选含其中任何一个就要加引号 */
const NEEDS_QUOTING = /[\s"'\\]/;

/** 补全的入参 */
export interface CompletionRequest {
  /** 整行输入（**光标之后的文本也在里面**，且必须原样保留） */
  readonly line: string;
  /** 光标位置；越界由本函数夹住（夹到 `[0, line.length]`） */
  readonly cursor: number;
  /** 台账里的 target 显示名；缺省 = 没有名字可补（⚠️ 本层**不许自己读台账**：读文件那一层手里有内存副本，自己去读会拿到**另一个**时刻的台账） */
  readonly targetNames?: readonly string[];
}

/** 补全的出参 */
export interface Completion {
  /** 候选（已去重、已按候选自身字典序排好） */
  readonly candidates: readonly string[];
  /** 补全后那一行的全文；⚠️ **只**换掉光标所在那个词（按「整行重建」来做，用户敲好的后半行会在一次 Tab 之后消失） */
  readonly line: string;
  /** 补全后光标该在哪儿（= 光标词的末尾；没有候选时是入参那个位置） */
  readonly cursor: number;
}

/** 去重 + 字典序；⚠️ **不许**按「哪个更常用」排（那会随实现细节漂移，调用方只要**稳定**） */
function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 一个候选该**怎么写进那一行**：含分词器 specials（空白 / `"` / `'` / `\`）就必须加引号 —— 不加的话补全就造出了一行「读回来意思变了」的话 */
function render(candidate: string): string {
  if (candidate !== "" && !NEEDS_QUOTING.test(candidate)) return candidate;
  return `"${candidate.replace(/(["\\])/g, "\\$1")}"`;
}

/** 光标夹进 `[0, line.length]`：非有限值也要判（`NaN` 落进 `slice` 会静默变成 0 那一侧） */
function clampCursor(value: number, max: number): number {
  if (Number.isNaN(value)) return 0;
  if (value === Number.POSITIVE_INFINITY) return max;
  if (value === Number.NEGATIVE_INFINITY) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), max);
}

/** 从 `done` 走命令表，算出「光标所在那个位置」的候选 */
function candidatesFor(done: readonly string[], names: CompletionNames): readonly string[] {
  // ⚠️ **命令名不归这一层**（归 `@/commands/palette.js`）：两层都答「命令名的第一个候选」的话，
  // 「Tab 填进去的」（字典序）与「面板高亮的」（表的顺序）会在 `/c` 上给出两个不同的命令
  const head = done[0] === undefined ? undefined : findSpec(done[0] as string);
  if (head === undefined) return [];
  let spec: CommandSpec = head;
  let consumed = 1;
  // 组：`user` / `target` 之后吃下一段
  while (spec.subs.length > 0 && consumed < done.length) {
    const child = findSpec(`${spec.name} ${done[consumed] as string}`);
    if (child === undefined) return [];
    spec = child;
    consumed += 1;
  }
  // 光标正落在组的那一段上
  if (spec.subs.length > 0) return spec.subs;
  // ⚠️ 判据是**查那一格有没有形参**，不是「`done` 是不是比命令名长」：按长度判的话
  // `user set bob ` 那一格永远拿不到候选（字段名也就永远出不来）
  const arg = spec.args[done.length - consumed];
  return arg === undefined ? [] : (arg.choices?.(names) ?? []);
}

/**
 * 给「当前这一行 + 光标位置」一份补全建议；⚠️ **整行不以 {@link COMMAND_PREFIX} 开头就一个候选都不给**（与 `parseLine` 逐字一致）
 */
/** ⚠️ {@link COMMAND_PREFIX} **不进词**：候选在去掉前缀的那一段上算，而 `line` / `cursor` 全部是**带前缀**那个坐标系里的位置 */
export function complete(request: CompletionRequest): Completion {
  const line = request.line;
  const cursor = clampCursor(request.cursor, line.length);
  const lead = COMMAND_PREFIX.length;
  // ⚠️ 判据是「整行**开头**有前缀」而不是「光标左边有」：光标落在 `/` 之前时本行还没成型
  if (!line.startsWith(COMMAND_PREFIX) || cursor < lead) {
    return { candidates: [], line, cursor };
  }
  // 最后一个非空白串就是光标词的前缀；⚠️ 光标落在某个词的**第一个字符**上时，那个词**就是**光标词
  const before = line.slice(lead, cursor);
  const segments = before.split(WHITESPACE);
  const partial = segments[segments.length - 1] as string;
  const done = segments.slice(0, -1).filter((one) => one !== "");
  const names: CompletionNames = { targetNames: request.targetNames ?? [] };

  const candidates = sortedUnique(
    candidatesFor(done, names).filter((one) => one.startsWith(partial)),
  );
  if (candidates.length === 0) return { candidates, line, cursor };

  const start = cursor - partial.length;
  // ⚠️ 光标落在空白上（`user | add`）时它是一个**空词**，不能吃掉后面那个已经敲好的词
  let end = cursor;
  if (partial !== "" || !WHITESPACE.test(line[start] ?? "")) {
    while (end < line.length && !WHITESPACE.test(line[end] as string)) end += 1;
  }

  // ⚠️ 这里替调用方挑**字典序第一个**候选：「第一个」得由同一套排序说了算，两处各挑一个
  // 就会出现「列表第一项」与「Tab 填进去的」说的不是同一个词
  const chosen = render(candidates[0] as string);
  return {
    candidates,
    line: line.slice(0, start) + chosen + line.slice(end),
    cursor: start + chosen.length,
  };
}
