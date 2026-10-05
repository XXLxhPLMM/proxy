/** @fileoverview 命令面板：输入行正以 `/` 开头时列出**全部**命令并高亮当前该选的那一条（纯数据面，零终端、零 React、零 HTTP、零 `fs`） */
/** ⚠️ `enterOutcomeOf` 的判据只落在**行**上：「光标挪一下」不是一次补全 —— 拿光标当判据就是给算术瑕疵发绿牌 */
/** ⚠️ `/help` 敲全了高亮就是它自己：判据若落在「命令名敲全了没」上，这条命令按多少次回车都跑不了 */
/** ⚠️ **命令名恒是一个词**（表里没有组）：于是「两段命令名的尾随空格」那一族问题在命令表变了之后不存在 */

import { COMMAND_PREFIX, COMMAND_SPECS } from "./parse.js";

/** 面板的一行：一列命令名 + 一列说明 */
export interface PaletteRow {
  /** 给人看的命令名（`@/commands:CommandSpec.path` 逐字，不另抄） */
  readonly path: string;
  /** 那条命令的一句说明（同上） */
  readonly summary: string;
}

/** 面板此刻的样子（`open` 为假时其余字段没有意义，故一律给中性值） */
export interface Palette {
  readonly open: boolean;
  /** 高亮那一行的下标；`-1` = 敲的东西表里没有（**不高亮**） */
  readonly at: number;
  /** 全表（顺序 = 命令表的顺序，即 `help` 的呈现顺序） */
  readonly rows: readonly PaletteRow[];
}

/** 全表（**模块加载时从那唯一一张表算出**，故它不可能与表漂） */
export const PALETTE_ROWS: readonly PaletteRow[] = COMMAND_SPECS.map((spec) => ({
  path: spec.path,
  summary: spec.summary,
}));

/** 面板关着的那一份（`open` 假时界面上不用它，但一份中性值好过到处判 `null`） */
const CLOSED: Palette = { open: false, at: -1, rows: [] };

/** 面板开不开：⚠️ 判据只有「整行以 {@link COMMAND_PREFIX} 开头」这一条（附加条件会造出「有时候有面板有时候没有」） */
export function paletteOpen(line: string): boolean {
  return line.startsWith(COMMAND_PREFIX);
}

/** `rest` 里**命令名那一个词**（以及它占到的字符数）；⚠️ 它**不是**「整行」—— `/usage alice` 里命令名已敲完，
 * 而真形参（`alice`）落在它之外，于是 `paletteFill` 只换掉它 */
function commandPathOf(rest: string): { readonly text: string; readonly end: number } {
  const head = /^\s*(\S+)/u.exec(rest);
  return {
    text: head?.[1] ?? "",
    end: head === null ? 0 : head[0].length,
  };
}

/** 输入行正以 `/` 敲的那一段命令名；⚠️ 它是**第一个非空白词**（`usage alice` 的命令名是 `usage`）且看**输入行**而不是**光标** */
export function commandHead(line: string): string {
  return commandPathOf(line.slice(COMMAND_PREFIX.length)).text;
}

/** 面板此刻的样子 + 高亮落在哪一行；⚠️ 列出的是**全表**而不是「敲的那几个匹配项」（按前缀过滤会让列表塌成一行，第二次 `↓` 无处可去） */
export function paletteOf(line: string): Palette {
  if (!paletteOpen(line)) return CLOSED;
  const head = commandHead(line);
  const names = PALETTE_ROWS.map((row) => row.path.slice(COMMAND_PREFIX.length));
  // ⚠️ **完全相同的那一条优先**：只按「以它开头」挑的话 `/r` 会高亮到 `r` **前面**那条 `rename`
  // （表里 `rename` 排在 `r` 前面），于是 `Tab` 补出一条他没敲的命令
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
  // ⚠️ `row.path` **已经带前缀**，直接拼会得到 `//status`，故这里削掉前缀再拼。
  const name = row.path.slice(COMMAND_PREFIX.length);
  const tail = rest.slice(commandPathEnd(rest));
  // ⚠️ 光标落在**刚写进去的那一段之后**而不是行尾：落在行尾的话操作者敲形参会插到别的地方去
  return {
    line: COMMAND_PREFIX + name + tail,
    cursor: COMMAND_PREFIX.length + name.length,
  };
}

/** 按下 `Enter` 那一刻的结论：**补全**还是**提交**（判别联合，`fill` 那一支带新的输入行与光标） */
export type EnterOutcome =
  | { readonly kind: "fill"; readonly line: string; readonly cursor: number }
  | { readonly kind: "submit" };

/**
 * 那一档的 `Enter` 结论：接受高亮改得了**命令名**就**补全**，改不了就**提交**
 * @description 后三档判据（面板关着 / 开着但没有高亮 / 开着而接受之后这一行逐字相同）都归 `submit`，
 * 而它们合成一档是因为调用方对它们的处置**是同一件事**：把这一行交给解析层。
 */
// ⚠️ **只认命令名、也只比命令名**：形参的值补全是 `Tab` 的活（`@/commands/complete.js`）—— 顺带补它的话，
// 「敲完 `/config PORT` 想直接回车跑一条没写完的命令」会被静默改成一条别的命令
export function enterOutcomeOf(line: string, cursor: number): EnterOutcome {
  const palette = paletteOf(line);
  if (!palette.open) return { kind: "submit" };
  const row = palette.rows[palette.at];
  if (row === undefined) return { kind: "submit" };
  const filled = paletteFill(line, cursor, row);
  // ⚠️ **判据只有这一行**：光标那一格不算「补全」—— 拿光标当判据就是给那个瑕疵发绿牌
  if (completesName(line, filled.line)) return { kind: "fill", line: filled.line, cursor: filled.cursor };
  return { kind: "submit" };
}

/**
 * 接受高亮是不是**真的补出了命令名**
 * @description 命令名恒是一个词，于是「填完只多一个尾随空格」那种形状今天不存在 ——
 * 判据因此干净地落在「**命令名**变没变」上，而 `/help` 的高亮**就是它自己**
 * （按「敲全了没」判的话那条命令按多少次回车都跑不了，见文件头）。
 */
// ⚠️ 而 `/help` 的高亮**就是它自己** —— 按「敲全了没」判的话那条命令按多少次回车都跑不了（见文件头）
function completesName(line: string, filled: string): boolean {
  return filled !== line;
}

/** 让第 `at` 行留在视口里所需的**首行号**（移动最少的那一个）；⚠️ 不是 `clamp` —— `clamp` 那一种在列表比视口长时会让高亮跑到看不见的地方 */
/** ⚠️ `at` 为 `-1`（没有高亮）时给 `0`：没有高亮就没有「要看见的那一行」 */
export function paletteWindow(at: number, rows: number, total: number): number {
  if (rows <= 0) return 0;
  const maxStart = Math.max(0, total - rows);
  const wanted = Math.max(at, 0) - rows + 1;
  return Math.min(Math.max(wanted, 0), maxStart);
}