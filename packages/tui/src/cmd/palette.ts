/** @fileoverview 命令面板：输入行正以 `/` 开头时列出**全部**命令并高亮当前该选的那一条（纯数据面，零终端、零 React、零 HTTP、零 `fs`） */

import { COMMAND_PREFIX, COMMAND_SPECS, type CommandSpec } from "./parse.js";

/** 面板的一行：一列命令名 + 一列说明 */
export interface PaletteRow {
  /** 给人看的命令名（`@/cmd:CommandSpec.path` 逐字，不另抄） */
  readonly path: string;
  /** 那条命令的一句说明（同上） */
  readonly summary: string;
  /** 这条命令名**不止一段**；⚠️ 它决定 {@link paletteFill} 补不补那个尾随空格（不补，`/user add` 之后接着敲形参会粘成 `/user addalice`） */
  readonly needsSpace: boolean;
}

/** 面板此刻的样子（`open` 为假时其余字段没有意义，故一律给中性值） */
export interface Palette {
  readonly open: boolean;
  /** 高亮那一行的下标；`-1` = 敲的东西表里没有（**不高亮**） */
  readonly at: number;
  /** 全表（顺序 = 命令表的顺序，即 `help` 的呈现顺序） */
  readonly rows: readonly PaletteRow[];
}

/** 命令名里有第二段吗（`@/cmd:CommandSpec.name` 含空格） */
function needsSpace(spec: CommandSpec): boolean {
  return spec.name.includes(" ");
}

/** 表里每一条的 `name`；⚠️ 判据是「表里有没有一条命令名以这段文字开头」，不能拿「被选中那条」的名字问（那只在**新名字更长**时成立） */
const COMMAND_NAMES: readonly string[] = COMMAND_SPECS.map((spec) => spec.name);

/** 全表（**模块加载时从那唯一一张表算出**，故它不可能与表漂） */
export const PALETTE_ROWS: readonly PaletteRow[] = COMMAND_SPECS.map((spec) => ({
  path: spec.path,
  summary: spec.summary,
  needsSpace: needsSpace(spec),
}));

/** 面板关着的那一份（`open` 假时界面上不用它，但一份中性值好过到处判 `null`） */
const CLOSED: Palette = { open: false, at: -1, rows: [] };

/** 面板开不开：⚠️ 判据只有「整行以 {@link COMMAND_PREFIX} 开头」这一条（附加条件会造出「有时候有面板有时候没有」） */
export function paletteOpen(line: string): boolean {
  return line.startsWith(COMMAND_PREFIX);
}

/** `rest` 里那些**连起来仍然落在命令名里**的词（以及它们占到的字符数）；⚠️ 它**不是**「吃到第一个空白为止」—— `/user add ` 里命令名已敲完，按空白截断会让按一次 `↓` 光标不动 */
/** ⚠️ 一个词都不匹配时退回「第一个词」，否则拼出 `/target switchzzz keep-me` 这种连着的串 */
function commandPathOf(rest: string): { readonly text: string; readonly end: number } {
  let text = "";
  let end = 0;
  const words = /\S+/gu;
  let match: RegExpExecArray | null = words.exec(rest);
  while (match !== null) {
    const next = text === "" ? match[0] : `${text} ${match[0]}`;
    if (!COMMAND_NAMES.some((name) => name.startsWith(next))) break;
    text = next;
    end = match.index + match[0].length;
    match = words.exec(rest);
  }
  if (end > 0) return { text, end };
  const head = /^\s*\S+/u.exec(rest);
  return {
    text: head === null ? "" : head[0].trimStart(),
    end: head === null ? 0 : head[0].length,
  };
}

/** 输入行正以 `/` 敲的那一段命令名；⚠️ 它**跨空白**（`user add alice` 的命令名是 `user add`）且看**输入行**而不是**光标** */
export function commandHead(line: string): string {
  return commandPathOf(line.slice(COMMAND_PREFIX.length)).text;
}

/** 面板此刻的样子 + 高亮落在哪一行；⚠️ 列出的是**全表**而不是「敲的那几个匹配项」（按前缀过滤会让列表塌成一行，第二次 `↓` 无处可去） */
export function paletteOf(line: string): Palette {
  if (!paletteOpen(line)) return CLOSED;
  const head = commandHead(line);
  const names = PALETTE_ROWS.map((row) => row.path.slice(COMMAND_PREFIX.length));
  // ⚠️ **完全相同的那一条优先**：表里 `users` 排在 `user` **前面**，只按「以它开头」挑的话敲
  // `/user` 会高亮 `/users`，于是 `Tab` 补出一条他没敲的命令。
  const exact = names.indexOf(head);
  const at = exact !== -1 ? exact : names.findIndex((name) => name.startsWith(head));
  return { open: true, at, rows: PALETTE_ROWS };
}

/** ⚠️ **不循环**（到头就停），而 `at === -1` 时从两端起（`↓` 到第一行、`↑` 到最后一行）—— 不这么做「敲了一个表里没有的东西之后按 `↓`」永远没反应 */
export function paletteStep(at: number, step: 1 | -1, total: number): number {
  if (total <= 0) return -1;
  if (at === -1) return step === 1 ? 0 : total - 1;
  return Math.min(Math.max(at + step, 0), total - 1);
}

/** `rest`（`/` 之后那一段）里属于**当前那条命令名**的部分有多长；⚠️ 判据与 {@link commandHead} 同在 {@link commandPathOf} 一处，真形参（`alice`）自然落在它之外 */
function commandPathEnd(rest: string): number {
  return commandPathOf(rest).end;
}

/** 把命令名那一段换成面板里的某一行（`Tab` / `↑`/`↓` / 鼠标点**共用这一个实现**）；⚠️ 它之后的内容（形参）**原样保留** */
export function paletteFill(
  line: string,
  cursor: number,
  row: PaletteRow,
): { readonly line: string; readonly cursor: number } {
  const rest = line.slice(COMMAND_PREFIX.length);
  // ⚠️ `row.path` **已经带前缀**，直接拼会得到 `//user add`，故这里削掉前缀再拼。
  const name = row.path.slice(COMMAND_PREFIX.length);
  const tail = rest.slice(commandPathEnd(rest));
  const spacer = row.needsSpace && tail === "" ? " " : "";
  const written = name + spacer;
  return {
    line: COMMAND_PREFIX + written + tail,
    cursor: COMMAND_PREFIX.length + written.length,
  };
}

/** 让第 `at` 行留在视口里所需的**首行号**（移动最少的那一个）；⚠️ 不是 `clamp` —— `clamp` 那一种在列表比视口长时会让高亮跑到看不见的地方 */
/** ⚠️ `at` 为 `-1`（没有高亮）时给 `0`：没有高亮就没有「要看见的那一行」 */
export function paletteWindow(at: number, rows: number, total: number): number {
  if (rows <= 0) return 0;
  const maxStart = Math.max(0, total - rows);
  const wanted = Math.max(at, 0) - rows + 1;
  return Math.min(Math.max(wanted, 0), maxStart);
}