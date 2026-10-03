/**
 * @fileoverview 命令面板：输入行正以 `/` 开头时，它列出**全部**命令并高亮当前该选的那一条
 * @module cmd/palette
 * @description
 * 本模块是「敲了 `/` 就浮出来的那一块」的**纯数据面**：它只回答三件事 ——
 * 面板此刻**开没开**、**列出哪几行**、**高亮在第几行**。怎么画在 `@/view/layout.tsx`，
 * 面板占哪几行在 `@/view/geometry.ts`，`↑`/`↓`/`Tab`/鼠标点各算成什么在 `@/app.tsx`。
 *
 * ## ⚠️ 面板的**开**只有一条判据：整行以 {@link COMMAND_PREFIX} 开头
 * @description
 * 没有「光标在不在命令名里」「是不是刚敲完一个空格」这些附加条件 —— 那些条件各自都能说通，
 * 合起来却会造出**两种**面板（敲命令名时一种、敲形参时另一种），而操作者看到的现象是
 * 「有时候有面板有时候没有」，屏上没有任何东西解释那个「有时候」。
 * ⚠️ 一条判据还换来一条本包需要的不变式：**面板开着 ⇒ `↑`/`↓` 归面板**（否则它们切目标）。
 * 判据若与「光标在哪」有关，「切目标还是选命令」就得跟着光标变 —— 而那正是用户最不想猜的一件事。
 *
 * ## ⚠️ 列出的是**全表**，不是「敲的那几个匹配项」
 * @description
 * 过滤会让 `↑`/`↓` 走不动：一旦把高亮写成 `/clear`，按前缀过滤的列表就塌成**一行**
 * （只有 `clear` 自己），于是第二次 `↓` 无处可去 —— 症状是「面板只能选一次」。
 * 故本模块列出 {@link ./parse.ts:COMMAND_SPECS} 的**每一行**，敲出来的东西只用来**定高亮**，
 * 不用来**裁列表**。⚠️ 代价是敲 `/zzz` 时面板还开着（19 行全在、**一行都没高亮**）——
 * 那是诚实的：那 19 行正是「表里有什么」的答案，而「不认识的命令」只在回车之后才成立。
 *
 * ## ⚠️ 高亮**只由输入行决定**（界面上没有「高亮在第几行」这个状态）
 * @description
 * `↑`/`↓` 走完之后**把那一行写进输入行**，于是下一帧的高亮由那行字自己算出来 ——
 * 于是「输入行上敲的是 A、面板高亮的是 B」那种不一致**在类型上就不可能发生**。
 * ⚠️ 这也是为什么本模块**不许**出现 `PaletteNav` 之类的累加器：加上它就会出现
 * 「行里的字没变、高亮却自己走了一格」，而症状是「按了一下 `↓` 它跳了两格」。
 *
 * ## 本模块零终端、零 React、零 HTTP、零 `fs` —— 与 `@/cmd` 其余部分同一条纪律
 * @description
 * 它只 import `./parse.js`。故「面板该列哪几行、高亮该落在哪」在一台没有终端的机器上就能逐字断言。
 *
 * @module
 */

import { COMMAND_PREFIX, COMMAND_SPECS, type CommandSpec } from "./parse.js";

/** 面板的一行：一列命令名 + 一列说明 */
export interface PaletteRow {
  /** 给人看的命令名（`@/cmd:CommandSpec.path` 逐字，不另抄） */
  readonly path: string;
  /** 那条命令的一句说明（同上） */
  readonly summary: string;
  /**
   * 这条命令名**不止一段**（`user add` 而不是 `usage`）
   * @description ⚠️ 它决定 {@link paletteFill} 补不补那个尾随空格。不补的话操作者接着敲形参
   * 会粘在名字后面（`/user addalice`），而那是一个**静默**的参数错误。
   * ⚠️ 而**单段**的命令（`usage` / `status`）刻意**不补**：补了就得敲两次 `↓` 才能走过它
   * （面板的补完与高亮在下一帧就同步，而补一个空格会让面板那一行的判据 ——
   * 「光标与 `/` 之间没有空白」—— 不成立），于是第一次 `↓` 就把关面板这件事做掉了。
   */
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

/**
 * 命令表里每一条的 `name`（**从那唯一一张表现取**，不是另抄一份）
 * @description 它答的是「**表里有没有一条命令名以这段文字开头**」—— 即「这一段算不算命令名
 * 的一部分」。⚠️ 不能拿「被选中那条」的名字去问同一个问题：那个判据只在**新名字更长**时成立，
 * 于是从 `/user add` 走到 `/user set` 时旧路径只被吃掉一个词（见 {@link commandPathEnd}）。
 */
const COMMAND_NAMES: readonly string[] = COMMAND_SPECS.map((spec) => spec.name);

/** 全表（**模块加载时从那唯一一张表算出**，故它不可能与表漂 —— 复制一份才会） */
export const PALETTE_ROWS: readonly PaletteRow[] = COMMAND_SPECS.map((spec) => ({
  path: spec.path,
  summary: spec.summary,
  needsSpace: needsSpace(spec),
}));

/** 面板关着的那一份（`open` 假时界面上不用它，但一份中性值好过到处判 `null`） */
const CLOSED: Palette = { open: false, at: -1, rows: [] };

/**
 * 面板此刻开不开
 * @description
 * 与 {@link ./complete.ts:complete} 对同一行的回答**同进同退**：不带 {@link COMMAND_PREFIX}
 * 的行不是一条命令的候选（`st`、`3`、`abc` 全都不是），故那一层给零候选、这一层关掉。
 * ⚠️ 两层若有一处更宽，操作者就会遇到「面板亮着而 Tab 什么也不做」—— 而那是两层各答各的，
 * 屏上没有任何东西说它们本该一致。
 */
export function paletteOpen(line: string): boolean {
  return line.startsWith(COMMAND_PREFIX);
}

/**
 * `rest` 里那些**连起来仍然落在命令名里**的词（以及它们占到的字符数）
 * @description
 * 判据只有一条：「**表里有没有一条命令名以这一段开头**」（{@link COMMAND_NAMES}）。它同时回答
 * 两个问题，故 {@link commandHead} 与 {@link commandPathEnd} **必须**走它 —— 两处各判一次就会
 * 在某次改动里分叉，而症状是「高亮在 `/user` 而输入行上写的是 `/user add`」。
 *
 * ⚠️ 它**不是**「吃到第一个空白为止」：`/user add ` 里那条命令名**已经敲完**（后面那个空格就是
 * 分界），按空白截断得到 `user`，于是高亮落在 `/user` 上 —— 而 `↑`/`↓` 走一步之后输入行变成
 * `/user add`，光标却停在上一条命令上。屏上那个形状是「按了 `↓` 它不动」。
 * ⚠️ 它也**不是**「是不是被选中那条命令名的前缀」：那个判据只在**新名字更长**时成立，于是从
 * `/user add` 走到 `/user set` 时旧路径只被吃掉 `user` 一个词，剩下的 ` add` 变成尾巴，
 * 屏幕上得到 `/user set add` —— **一条命令里夹着一个形参**，而 `parseLine` 不会因此报错。
 *
 * ⚠️ **一个词都不匹配时**退回「第一个词」：那是「正在敲的那一段」，而留着它会拼出
 * `/target switchzzz keep-me` 这种串（连着的两个词，中间没有空格）。
 */
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

/**
 * 输入行正以 `/` 敲的那一段命令名（`/` 之后到**第一个不属于命令名的词**，含光标之后的字）
 * @description ⚠️ 它**跨空白**（{@link commandPathOf}）：`/user add alice` 的命令名是 `user add`
 * 而不是 `user` —— 那三个词里前两个仍然落在命令名里，而按空白截断会让高亮停在 `/user` 上，
 * 于是 `↑`/`↓` 往下一格之后输入行与高亮**指着两条不同的命令**。
 * ⚠️ 而它看的**不是光标位置**（`/user |add` 的命令名是 `user add`）：`@/cmd:complete` 按光标
 * 所在的那个**词**补形参，两处看的是不同的位置，给两个答案不是矛盾，是两个问题；
 * 而命令面板的职责只有「命令名」这一件。
 */
export function commandHead(line: string): string {
  return commandPathOf(line.slice(COMMAND_PREFIX.length)).text;
}

/**
 * 面板此刻的样子 + 高亮落在哪一行
 * @description
 * 高亮 = **第一个**名字以命令名开头的行；一个都没有就是 `-1`（整块面板没有反底色）。
 * ⚠️ 用**表的顺序**而不是字典序：表的顺序是「先查帮助、再干活」，而字典序会把 `acl` 顶到
 * `config` 前面去 —— 那对「按 `c` 然后回车」是另一个答案。⚠️ 唯一一处仍按字典序排序的是
 * {@link ./complete.ts}，而它**只管形参的值**（命令名归本模块），故两处排序各管一段、不重叠。
 */
export function paletteOf(line: string): Palette {
  if (!paletteOpen(line)) return CLOSED;
  const head = commandHead(line);
  const names = PALETTE_ROWS.map((row) => row.path.slice(COMMAND_PREFIX.length));
  // ⚠️ **完全相同的那一条优先**：表里 `users` 排在 `user` **前面**（表的顺序是「先查帮助、
  // 再干活」），而只按「以它开头」挑的话敲 `/user` 会高亮 `/users` —— 那是一个**存在的**命令，
  // 于是操作者敲完 `/user` 看到的高亮与手打的不一致，`Tab` 就会补出一条他没敲的命令。
  const exact = names.indexOf(head);
  const at = exact !== -1 ? exact : names.findIndex((name) => name.startsWith(head));
  return { open: true, at, rows: PALETTE_ROWS };
}

/**
 * `↑`/`↓` 之后高亮该停在哪一行
 * @description
 * ⚠️ **不循环**（到头就停）而 `at === -1` 时从两端起：`↓` 到第一行、`↑` 到最后一行 ——
 * 不这么做的话「敲了一个表里没有的东西之后按 `↓`」永远没反应，而那恰好是最需要面板给点提示的时刻。
 * @param at - 现在高亮在哪（`-1` = 没有高亮）
 * @param step - `1` 往下、`-1` 往上
 * @param total - 一共几行
 */
export function paletteStep(at: number, step: 1 | -1, total: number): number {
  if (total <= 0) return -1;
  if (at === -1) return step === 1 ? 0 : total - 1;
  return Math.min(Math.max(at + step, 0), total - 1);
}

/**
 * `rest`（`/` 之后那一段）里属于**当前那条命令名**的部分有多长（字符数）
 * @description
 * ⚠️ 判据写在 {@link commandPathOf} 上（与 {@link commandHead} **同一处**）：「**表里有没有
 * 一条命令名以这一段开头**」，而不是「它是不是被选中那条命令名的前缀」。后者只在**新名字更长**
 * 时成立，于是从 `/user add` 走到 `/user set` 时旧路径只被吃掉 `user` 一个词，剩下的 ` add`
 * 变成尾巴，屏幕上得到 `/user set add` —— 一条命令里夹着一个形参，而 `parseLine` 不会因此报错。
 * ⚠️ 这条判据同时把 `alice` 这种真形参留在外面：`user add alice` 不是任何命令名的前缀，
 * 故命令名到 `add` 为止 —— 它之后的内容原样保留。
 */
function commandPathEnd(rest: string): number {
  return commandPathOf(rest).end;
}

/**
 * 把命令名那一段换成面板里的某一行（`Tab` / `↑`/`↓` / 鼠标点**共用这一个实现**）
 * @description
 * ⚠️ 换的是**整条命令名**（{@link commandPathEnd} 定出它的末尾），而它之后的内容
 * （形参）**原样保留** —— 于是 `/user ad|d alice` + 选中 `user add` 得到 `/user add alice`
 * 而不是 `/user add d alice`。少做这一处的后果是补全顺手改掉操作者已经敲好的形参。
 *
 * @param line - 当前整行（**不** trim：行首那个 `/` 的位置不能动）
 * @param cursor - 当前光标（落点必须在刚写进去的那一段**之后**）
 * @param row - 面板里的某一行
 * @returns 换完之后的整行与光标
 */
export function paletteFill(
  line: string,
  cursor: number,
  row: PaletteRow,
): { readonly line: string; readonly cursor: number } {
  const rest = line.slice(COMMAND_PREFIX.length);
  // ⚠️ `row.path` **已经带前缀**（它是要给人看的那一串），而前缀由下面那行 `COMMAND_PREFIX +`
  // 写一次 —— 直接拼 `path` 会得到 `//user add`。这里削掉前缀再拼，故判据是「行首那一列
  // 是前缀」，而不是「调用方记得别重复给」。
  const name = row.path.slice(COMMAND_PREFIX.length);
  const tail = rest.slice(commandPathEnd(rest));
  const spacer = row.needsSpace && tail === "" ? " " : "";
  const written = name + spacer;
  return {
    line: COMMAND_PREFIX + written + tail,
    cursor: COMMAND_PREFIX.length + written.length,
  };
}

/**
 * 让第 `at` 行留在视口里所需的**首行号**（移动最少的那一个）
 * @description
 * ⚠️ 不是 `clamp`：`clamp` 把首行号夹进 `[0, total - rows]`，而判据是「`at` 落在
 * `[start, start + rows)` 里」，且满足它的 `start` 取**最小**的那个 —— 于是高亮恰好被顶到
 * 视口最后一行时才滚。`clamp` 那一种在列表比视口长时会让第 0 行之外的高亮跑到看不见的地方，
 * 那一帧看上去就是「按了 `↓` 没反应」。
 *
 * ⚠️ `at` 为 `-1`（没有高亮）时给 `0`：没有高亮就没有「要看见的那一行」，从头显示最省事。
 *
 * @param at - 高亮的下标（`/^[0-9]+$/` 之外的值由本函数自己夹，故调用方不必预夹）
 * @param rows - 视口几行（由几何层给，见 `@/view/geometry.ts:Geometry.paletteViewportRows`）
 * @param total - 一共几行
 */
export function paletteWindow(at: number, rows: number, total: number): number {
  if (rows <= 0) return 0;
  const maxStart = Math.max(0, total - rows);
  const wanted = Math.max(at, 0) - rows + 1;
  return Math.min(Math.max(wanted, 0), maxStart);
}