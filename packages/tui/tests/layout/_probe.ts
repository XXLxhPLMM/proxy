/**
 * 本目录各档共用的**读帧那一半**：把一帧（带 ANSI 的原始帧或已剥过的帧）读成「哪一格是什么色、
 * 哪一列、哪一行」。
 *
 * ⚠️ **收件门槛是「两个以上档真用到」**：只被一档用到的东西留在那一档里。
 * ⚠️ 依赖方向只有一条：本模块 → `./_harness.js`（`sidebarScreen` 要先取帧再切列），故不成环。
 *
 * @module tests/layout
 */

import { widthOf } from "@/lib/format.js";
import type { LayoutProps } from "@/app.js";
import { renderScreen, SIDEBAR, stripAnsi } from "./_harness.js";

/** 按屏行号找到含 `needle` 的那一行（`-1` = 没有） */
export function screenRowOf(lines: readonly string[], needle: string): number {
  return lines.findIndex((line) => line.includes(needle));
}

/**
 * 第 `index` 个字符渲染时，**某种着色生效的 SGR 参数**（`null` = 没生效）
 * @description 与 {@link sgrStateAt} **同一套解析**，而它答的是「**哪一个**色」而不是
 * 「有没有色」。⚠️ 侧边栏那一列**整列都有底色**（`surface`），故「底色开没开」在这条判据上
 * **恒为真** —— 「选中项没有底色」与「hover 铺满整列」都必须问「**哪一个**底色」。
 * @description 顺带一个坑：真彩色写成 `38;2;r;g;b` / `48;2;r;g;b`，而 `39` / `49` 是**清**前景/背景。
 */
export function sgrColorAt(line: string, index: number, kind: "fg" | "bg"): string | null {
  const base = kind === "fg" ? 30 : 40;
  const clear = kind === "fg" ? 39 : 49;
  let color: string | null = null;
  let i = 0;
  while (i < index && i < line.length) {
    if (line[i] !== "\u001B") {
      i += 1;
      continue;
    }
    i += 1;
    const start = i;
    while (i < line.length && !/[A-Za-z]/u.test(line[i] as string)) i += 1;
    const params = line.slice(start + (line[start] === "[" ? 1 : 0), i);
    // 跳过终止字母
    i += 1;
    if (params.startsWith("?")) continue;
    const codes = codesOf(params);
    // ⚠️ **真彩色必须整段认走**：`38;2;R;G;B` 的三个分量与 `0` / `39` / `49` **取值重叠** ——
    // 「这一段里有 0 就当复位」会把 `#00d9ff`（R 分量就是 0）读成「这一格没有颜色」，而症状是
    // 「断言永远为假」与「实现错了」长得一模一样（引导屏那六档渐变里第一档正好是 `#00d9ff`，
    // 它踩的就是这个洞）。
    const truecolor = codes.length === 5 && (codes[0] === 38 || codes[0] === 48) && codes[1] === 2;
    if (truecolor) {
      if (codes[0] === base + 8 || codes[0] === base) color = params;
    } else if (codes.includes(clear) || codes.includes(0)) color = null;
    else if (codes[0] === base + 8 || codes[0] === base) color = params;
  }
  return color;
}

/**
 * ⚠️ **真彩色的参数必须整段跳过**：`38;2;R;G;B` 里那三个 0–255 的分量与背景色的
 * `100`–`107`（亮黑等）**取值重叠** —— 逐个判的话一个**前景**色序列里的 `104` 会被读成
 * 「亮背景黑」，于是判据说「这一格有底色」而屏幕上根本没有底色（实测踩过一次）。
 */
/** `38;2;187;154;247` → `[38, 2, 187, 154, 247]`（`Number("[38")` 是 `NaN`，见调用点） */
function codesOf(params: string): readonly number[] {
  return params.split(";").map((one) => Number(one));
}

/** `#00d9ff` → `38;2;0;217;255`（素材里的 hex 与 Ink 写出来的 SGR 参数之间的**唯一**换算） */
export function fgSgrOf(hex: string): string {
  const packed = Number.parseInt(hex.slice(1), 16);
  const r = (packed >> 16) & 0xff;
  const g = (packed >> 8) & 0xff;
  const b = packed & 0xff;
  return `38;2;${String(r)};${String(g)};${String(b)}`;
}

/**
 * 侧边栏里那些行
 * @description ⚠️ 判据是「**剥掉 ANSI 之后**以 `│` 开头」而不是直接 `startsWith`：
 * 开着颜色时每一行的第一个字节是转义序列，故直接 `startsWith("│")` 会把**全部**侧边栏行滤掉 ——
 * 而滤掉之后 `find` 返回 `undefined`，于是一条本该绿的断言在**零行**上也「绿」不了，
 * 症状是 `expected undefined to be defined`（实测踩过）。
 * @description 返回的是**原始**行（含 ANSI），因为着色那组断言要读它。
 */
/**
 * 按**显示列**切出一段，而 **ANSI 转义序列原样留着**
 * @description ⚠️ 侧边栏那一列的底色（SGR）正是本档那几条判据要看的东西，故切的时候
 * **不许剥 ANSI**：剥了之后 `sgrStateAt` / `sgrFgAt` 拿到的下标与原串对不上，而症状是
 * 「断言永远为假」—— 与「实现错了」长得一模一样（实测踩过一次）。
 */
export function column(line: string, width: number): string {
  let out = "";
  let shown = 0;
  let i = 0;
  while (i < line.length && shown < width) {
    if (line[i] === "\u001B") {
      const bracket = line.indexOf("[", i);
      if (bracket === -1 || bracket > i + 2) {
        out += line[i];
        i += 1;
        continue;
      }
      let end = bracket + 1;
      while (end < line.length && !/[A-Za-z]/u.test(line[end] as string)) end += 1;
      out += line.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    out += line[i];
    shown += widthOf(line[i] as string);
    i += 1;
  }
  return out;
}

/** 侧边栏那一列的行（**按列宽**切出来：满屏上那两根竖线已经没有了） */
export function sidebarColumn(lines: readonly string[], width = SIDEBAR): readonly string[] {
  return lines.map((line) => column(line, width));
}

/**
 * 侧边栏那一列的**逐屏行**（空行留着，故下标就是**屏行号**）
 * @description ⚠️ **不走 {@link renderFrame}**：那个取帧**滤掉空行**，而**项与项之间**那一行间隔在侧边栏
 * 那一列上**一个字都没有** —— 用前者当下标时后面每一项的下标会整体前移那么多，而症状是「断言逐条都对、
 * 其实量的是上面那一行」（会话名那一行被测成它上面那行空白，而那行当然没有会话名）。
 */
export async function sidebarScreen(props: LayoutProps): Promise<readonly string[]> {
  return sidebarColumn(await renderScreen(props));
}

/** 从第 `from` 个显示列起切到屏尾（ANSI 原样留着） */
export function restColumns(line: string, from: number): string {
  let out = "";
  let shown = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\u001B") {
      const bracket = line.indexOf("[", i);
      if (bracket === -1 || bracket > i + 2) {
        out += line[i];
        i += 1;
        continue;
      }
      let end = bracket + 1;
      while (end < line.length && !/[A-Za-z]/u.test(line[end] as string)) end += 1;
      out += line.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (shown >= from) out += line[i];
    shown += widthOf(line[i] as string);
    i += 1;
  }
  return out;
}

/** 找到第一个包含 `needle` 的行的下标（`-1` = 没有） */
export function rowOf(lines: readonly string[], needle: string): number {
  return lines.findIndex((line) => line.includes(needle));
}

/**
 * **覆盖**第 `column` 个显示列的那个格子在原始串里的字符下标（`-1` = 那一列没有格子）
 * @description ⚠️ 缺了它，「最右那一列换了底色」这类判据只能按**字符下标**写 —— 而那一列
 * 在原始串里的下标要减去前面所有转义序列的长度（颜色一开就是几十），于是那种断言要么恒真
 * 要么恒假，而症状与「实现错了」一模一样。
 * ⚠️ 判据是「**覆盖**」而不是「起点恰好在」：一个 CJK 字符占两列，而第 N 列完全可能落在
 * 它**中间**（那一列不属于任何格子的起点）—— 按「起点恰好在」写的话这种列一律给 `-1`，
 * 于是断言静默地变成「那一列没有底色」。
 */
export function rawIndexOfColumn(line: string, column: number): number {
  let shown = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\u001B") {
      const bracket = line.indexOf("[", i);
      if (bracket === -1 || bracket > i + 2) return -1;
      let end = bracket + 1;
      while (end < line.length && !/[A-Za-z]/u.test(line[end] as string)) end += 1;
      i = end + 1;
      continue;
    }
    const w = widthOf(line[i] as string);
    if (shown + w > column) return i;
    shown += w;
    i += 1;
  }
  return -1;
}

/** 那个**显示列**上生效的底色（`null` = 没有） */
export function bgAtColumn(line: string, column: number): string | null {
  const at = rawIndexOfColumn(line, column);
  return at < 0 ? null : sgrColorAt(line, at, "bg");
}

/**
 * 那个**显示列**上生效的底色**三通道**（`null` = 没有底色**或**不是真彩色）
 * @description ⚠️ 「深浅」这件事**只比通道之和**：把 hex 换成人眼公式算亮度的话，公式本身就是
 * 另一份判据（而它挑不出「哪一档更亮」时要靠人眼复核）。⚠️ 非真彩色（`48;2;` 那一段缺分量）给
 * `null` —— 调用点必须先自检它不是 `null`，否则「浅于」这条断言在无色终端上**恒真**。
 */
export function bgRgbAt(line: string, column: number): readonly number[] | null {
  const params = bgAtColumn(line, column);
  if (params === null) return null;
  const parts = params.split(";");
  return parts.length === 5 ? [Number(parts[2]), Number(parts[3]), Number(parts[4])] : null;
}

/** 三通道之和（**只用来比大小**，不比色相） */
export function depthOf(rgb: readonly number[]): number {
  return rgb[0] + rgb[1] + rgb[2];
}

/** 这一行**画到第几列**（`stripAnsi` 之后按显示列数 —— 尾部没画过的列不算「一格」） */
export function paintedColumns(line: string): number {
  return widthOf(stripAnsi(line));
}

/**
 * 那个**字符下标**落在第几个**显示列**（**越界或落进一条转义序列里一律 `-1`**）
 * @description ⚠️ {@link indexOfText} 那一族的下标是**字符**下标，而 {@link bgAtColumn} 收的是
 * **显示列** —— 混用时探针落在窗口外面（症状是「量到的是遮罩，于是那条关于框的断言恒红」，
 * 而它与「框真的没带底色」症状一样）。有中文时两者能差出一整行。
 * ⚠️ **「没有那个下标」必须给 `-1` 而不是行尾那一列或 0**：`-1` 让调用点能先自检，而一个落在
 * 范围内的数字会让「两者相等」「小于预算」那类比较**恒成立**。⚠️ **那条纪律按入参域分档，不跨探测器**：{@link rawIndexOfColumn} 答的是**显示列域**，那一域入参恒 ≥ 0 而负值**不可达**（`rawIndexOfColumn("abc", -1)` 实测给的是 `0`，即第一个画出来的格子）；两个域各自要答的越界见 `AGENTS.md`「探测器自检」那一节。
 */
export function columnOfIndex(line: string, index: number): number {
  // ⚠️ **越界一律 `-1`**：那个下标必须指着**一个字符**，而 `line.length` 之内不蕴含「指着字符」
  // （它把转义序列的字节也算进去了）—— 故越界那一支在循环**外面**先答掉
  if (index < 0 || index >= line.length) return -1;
  let shown = 0;
  let i = 0;
  while (i < index) {
    if (line[i] === "\u001B") {
      const bracket = line.indexOf("[", i);
      if (bracket === -1 || bracket > i + 2) return -1;
      let end = bracket + 1;
      while (end < line.length && !/[A-Za-z]/u.test(line[end] as string)) end += 1;
      i = end + 1;
      // ⚠️ 跳过的这一段**越过了 `index`** ⇒ 那个下标落在一条转义序列内部，答不出它落在第几列
      if (i > index) return -1;
      continue;
    }
    shown += widthOf(line[i] as string);
    i += 1;
  }
  return shown;
}

/** `#181a26` → `48;2;24;26;38`（主题里那个 hex 与 Ink 写出来的底色 SGR 之间的**唯一**换算） */
export function bgSgrOf(hex: string): string {
  return `48;2;${fgSgrOf(hex).slice("38;2;".length)}`;
}

/** 第一个含 `needle` 的**原始**行的下标（`-1` = 没有） */
export function rowRawOf(lines: readonly string[], needle: string): number {
  return lines.findIndex((line) => line.includes(needle));
}

/** `needle` 在那一个**原始**行里的字符下标（`-1` = 没有）—— 传去 {@link sgrColorAt} 的那一个 */
export function indexOfText(line: string, needle: string): number {
  return line.indexOf(needle);
}

/**
 * 那个字符渲染时**是不是加粗**（`1` 开、`22` 关）
 * @description ⚠️ 与 {@link sgrStateAt} 同一套扫描（逐段走 SGR、跳过 `38`/`48` 的参数）。
 * ⚠️ 它存在是因为「选中态有颜色之外的第二通道」这条不变式**在无色终端里也要成立**，
 * 而无色终端里没有颜色可读 —— 只判颜色的那一版判据对那条不变式**零鉴别力**。
 */
export function isBoldAt(line: string, index: number): boolean {
  let on = false;
  let i = 0;
  while (i < index && i < line.length) {
    if (line[i] !== "\u001B") {
      i += 1;
      continue;
    }
    i += 1;
    const start = i;
    while (i < line.length && !/[A-Za-z]/u.test(line[i] as string)) i += 1;
    const params = line.slice(start + (line[start] === "[" ? 1 : 0), i);
    i += 1;
    if (params.startsWith("?")) continue;
    const codes = codesOf(params);
    let j = 0;
    while (j < codes.length) {
      const code = codes[j] as number;
      if (code === 0 || code === 22) on = false;
      else if (code === 1) on = true;
      // 跳过扩展色的参数（`38`/`48` 后面那几段不是加粗）
      j += code === 38 || code === 48 ? (codes[j + 1] === 2 ? 5 : codes[j + 1] === 5 ? 3 : 2) : 1;
    }
  }
  return on;
}

/** 在帧里找到含 `needle` 的那一行，返回「那一行 + 那一行内的下标」 */
export function atText(
  lines: readonly string[],
  needle: string,
): { line: string; index: number } {
  const row = rowRawOf(lines, needle);
  const line = row >= 0 ? (lines[row] as string) : "";
  return { line, index: line.indexOf(needle) };
}
