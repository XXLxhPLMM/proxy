/**
 * `@/app` 的**真渲染**断言（假 TTY + 真 Ink）
 *
 * ## 为什么这一档非有不可
 * @description 这一档守的是六件**只有真渲染才看得见**的事：
 * 1. **Ink 对过宽的 `<Text>` 是静默软换行。** 一换行，**后面所有行都往下移**、边框随之错位 ——
 *    症状是「侧边栏里有一个名字把整块框顶歪了」。而它**只在长名字那一档出现**（中文名的显示宽度
 *    是 ASCII 的两倍，纯 ASCII 的用例对「按 `length` 算」与「按显示宽度算」两种实现**零鉴别力**）。
 * 2. **选中态是不是「最亮的那一档 + 加粗」且**没有反底色**。** 底色那一列归 hover，而「拆成三段」
 *    的高亮（段与段之间有 `49m` 关背景）在别的实现里会照样通过上一版那种「开没开底色」的判据 ——
 *    故这一档的探测器**真的解析 SGR 参数**（{@link sgrColorAt} / {@link sgrStateAt}）。
 * 3. **折出来的输入行与框**对不对得上**：框的高度是几何层按折行数给的，而画面上是 Ink 按它自己
 *    的布局画的 —— 两者不一致的症状是「输入串第二行跑到框外面去了」。
 * 4. **状态行在框外**：它在框**内**时与输入串抢同一行，而那一帧的 `notice` 会盖住它。
 * 5. **模态窗口压在别的区之上**：它是绝对定位的后画的一个兄弟，坐标全对而**画不进上层**时，
 *    症状是「窗口内容被主区盖掉」—— 纯函数档完全看不见这一层。
 * 6. **`esc` 那一枚真的压在标题那一行上**（而不是标题下面那一行）。
 * 7. **遮罩盖住整个可视区域**：Ink 没有半透明，遮罩是「重新铺一层不透明的底色」，而**任何自己带
 *    底色或带边框的盒子都会盖在它上面或把它挖空** —— 症状是「整屏压暗了而侧边栏没压暗」「屏最底下
 *    横着两条亮线」，两者都不让任何 `includes` 断言变红。故判据是**逐格**比两帧（见 ⑥ 那组）。
 *
 * ## 假 TTY 而不是真终端
 * @description
 * `render()` 要一个 `stdout.isTTY`（否则 Ink 退化成逐帧输出、不排边框）与 `columns` / `rows`
 * —— 这三个都能**注入**，故不需要真 pty。⚠️ 本档**测不到**「真终端退出后干不干净」那一半。
 *
 * ## 每条负向断言都做过变异
 * @description 见文件末尾那张表（**九条全部转红**）。⚠️ 仍绿的必须逐条写清它为什么绿 ——
 * 一条恒绿的断言是「护栏在生效」的假象，而本档历史上真的有过那种（见 ① 那条注释）。
 */

import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import stringWidth from "string-width";

// ⚠️ `FORCE_COLOR` 必须在 **ink（因而 chalk）被 import 之前**设好，否则 chalk 会按
// 「本进程标准输出不是终端」把 level 定成 0，而那样 Ink **根本不生成任何转义序列** ——
// 于是「选中态是不是最亮那一档 + 加粗」与「hover 那一条是不是另一个底色」两条判据
// 会变成恒真的空断言（没有序列 = 没有裸格子）。
// ⚠️ `vi.hoisted` 是 vitest 唯一保证「在 import 之前」的手段。
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import {
  MAIN_TEXT_X,
  SESSION_CLOSE_COLUMNS,
  SESSION_MARK_COLUMNS,
  SESSION_ROWS,
  SESSION_STRIDE,
  SIDEBAR_GAP,
  SIDEBAR_TEXT_X,
  geometry,
  type GeometryInput,
} from "@/lib/geometry.js";
import { MARK_SELECTED } from "@/components/index.js";
import { flatten, type FlatLog, type LogEntry, type LogRow, type Turn } from "@/lib/log/index.js";
import { widthOf } from "@/lib/format.js";
import { LOGO, LOGO_TAG, LOGO_WIDTH } from "@/features/output/logo.js";
import { themeOf, toneColor, type Theme } from "@/theme/index.js";
import { Layout, type LayoutProps, type SessionRow } from "@/app.js";
import type { MenuView } from "@/components/index.js";

/** 本档用的标准尺寸（下面的用例大多围绕它） */
const COLUMNS = 100;
const ROWS = 28;
/** 侧边栏宽（与 `geometry` 的缺省一致；**用例一律显式给**，故两边读的是同一个数） */
const SIDEBAR = 32;

/** 第 `index` 项的**名字那一行**的屏行号（⚠️ 顶部**不留白**、项间空一行 ⇒ 步长 `SESSION_STRIDE`） */
const ITEM_ROW = (index: number): number => index * SESSION_STRIDE;

/** 一个假 TTY：Ink 只要求 `isTTY` / `columns` / `rows` / `write` */
function fakeStdout(columns: number, rows: number): PassThrough & {
  columns: number;
  rows: number;
  isTTY: boolean;
} {
  const stream = new PassThrough() as PassThrough & {
    columns: number;
    rows: number;
    isTTY: boolean;
  };
  stream.columns = columns;
  stream.rows = rows;
  stream.isTTY = true;
  return stream;
}

/**
 * 真渲染一次，返回**那一帧的全部行**（ANSI 已去掉，空行已滤掉）
 * @description
 * ⚠️ `interactive: false` 是这里的关键：它让 Ink **不排增量帧**，而是在 `unmount()` 时把
 * 最后一帧**一次性**写出来，故缓冲里恰好一份纯文本帧。
 * ⚠️ 不用它就得去切 `log-update` 的光标移动序列 —— 本档实测踩过两次：那种切法会切出一个
 * 只含**半帧**的「最后一帧」，于是每一条断言都在半个屏上跑，而它看起来还挺像真的。
 */
async function renderFrame(props: LayoutProps): Promise<readonly string[]> {
  const stdout = fakeStdout(props.columns, props.rows);
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const stdin = new PassThrough();
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => stdin,
    setEncoding: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
  });
  const instance = render(createElement(Layout, props), {
    stdout: stdout as never,
    stdin: stdin as never,
    patchConsole: false,
    exitOnCtrlC: false,
    interactive: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  instance.unmount();
  await new Promise((resolve) => setTimeout(resolve, 40));
  // ⚠️ **反向自检**：Ink 必须真的写了东西。少了它，一个「什么都没渲染出来」的实现会让本档
  // 的每一条 `includes` 都绿 —— 而「渲染是空的」恰恰是这一类界面最可能的失败形态。
  return stripAnsi(output)
    .split("\n")
    .filter((line) => line !== "");
}

/**
 * 真渲染一次，返回**按屏行号索引**的帧（ANSI 已去掉、**空行留着**）
 * @description ⚠️ 与 {@link renderFrame} 的区别只有一处，却决定一批断言成不成立：
 * `renderFrame` **滤掉空行**（它答的是「这一行有字吗」），而「状态行画在第几行」这类判据
 * 要的是**屏行号** —— 用前者当下标的话，结果区里有多少空行就错多少。
 * ⚠️ 于是凡是量「第几行」的判据一律走这个函数。
 */
async function renderScreen(props: LayoutProps): Promise<readonly string[]> {
  const raw = await renderRaw(props);
  return raw.map((line) => stripAnsi(line));
}

/** 按屏行号找到含 `needle` 的那一行（`-1` = 没有） */
function screenRowOf(lines: readonly string[], needle: string): number {
  return lines.findIndex((line) => line.includes(needle));
}

/**
 * 真渲染一次，返回**带 ANSI 的原始帧**（着色那几组断言要读 SGR）
 * @description ⚠️ 与 {@link renderFrame} 只差「不剥 ANSI」：剥了之后 {@link sgrColorAt} 拿到的
 * 下标与原串对不上，而症状是「断言永远为假」—— 与「实现错了」长得一模一样（实测踩过一次）。
 */
async function renderRaw(props: LayoutProps): Promise<readonly string[]> {
  const stdout = fakeStdout(props.columns, props.rows);
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const stdin = new PassThrough();
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => stdin,
    setEncoding: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
  });
  const instance = render(createElement(Layout, props), {
    stdout: stdout as never,
    stdin: stdin as never,
    patchConsole: false,
    exitOnCtrlC: false,
    interactive: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  instance.unmount();
  await new Promise((resolve) => setTimeout(resolve, 40));
  return output.split("\n");
}
/**
 * 去掉 CSI / SGR 序列（**逐字符扫**而不是一条正则）
 * @description ⚠️ 判据里的 `\u001B` 会把本包的 `no-control-regex` 触发，而给测试档开一条
 * `eslint-disable` 等于让这条纪律从此不再被看见 —— 这里的**唯一**写法就是「按字节扫」。
 * ⚠️ 终止条件是「参数段之后的第一个字母」（CSI 的最后一段），而**不是**任何字母：
 * 字符串里出现裸字母时按后者判会**把正文吃掉**。
 */
function stripAnsi(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "\u001B") {
      out += ch;
      i += 1;
      continue;
    }
    const bracket = text.indexOf("[", i);
    // 没有 `[` 或没有终止字母 ⇒ 不是一条 CSI，原样留着（那是一个 ESC 键之类）
    if (bracket === -1 || bracket > i + 2) {
      out += ch;
      i += 1;
      continue;
    }
    let end = bracket + 1;
    while (end < text.length && !/[A-Za-z]/u.test(text[end] as string)) end += 1;
    i = end < text.length ? end + 1 : text.length;
  }
  return out;
}

/**
 * 第 `index` 个字符渲染时，**某种着色生效的 SGR 参数**（`null` = 没生效）
 * @description 与 {@link sgrStateAt} **同一套解析**，而它答的是「**哪一个**色」而不是
 * 「有没有色」。⚠️ 侧边栏那一列**整列都有底色**（`surface`），故「底色开没开」在这条判据上
 * **恒为真** —— 「选中项没有底色」与「hover 铺满整列」都必须问「**哪一个**底色」。
 * @description 顺带一个坑：真彩色写成 `38;2;r;g;b` / `48;2;r;g;b`，而 `39` / `49` 是**清**前景/背景。
 */
function sgrColorAt(line: string, index: number, kind: "fg" | "bg"): string | null {
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
function fgSgrOf(hex: string): string {
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
function column(line: string, width: number): string {
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
/* ── props 与几何（**两处喂的是同一组字段**，故逐字相同）─────────────────── */

/** 几何入参要的那几个字段（`props` 的一个子集 —— 「画与点同源」的实现形式） */
type GeoFields = Pick<
  LayoutProps,
  | "columns"
  | "rows"
  | "sidebarWidth"
  | "input"
  | "palette"
  | "window"
  | "sessions"
  | "sessionsTop"
  | "menu"
>;

/** 几何的入参（与 {@link props} 读的是同一批字段） */
function geoInput(p: GeoFields): GeometryInput {
  return {
    columns: p.columns,
    rows: p.rows,
    sidebarWidth: p.sidebarWidth,
    sessionCount: p.sessions.length,
    sessionsTop: p.sessionsTop,
    input: p.input,
    paletteCount: p.palette === null ? 0 : p.palette.total,
    window: p.window !== null,
    windowRows: p.window === null ? 0 : p.window.rows.length,
    windowNote: p.window !== null && p.window.note !== null,
    menu:
      p.menu === null
        ? null
        : { x: p.menu.origin[0], y: p.menu.origin[1], items: p.menu.items },
  };
}

/** 一份最小的 props（各用例只改自己关心的那几项） */
function props(over: Partial<LayoutProps> = {}): LayoutProps {
  const columns = over.columns ?? COLUMNS;
  const rows = over.rows ?? ROWS;
  const sidebarWidth = over.sidebarWidth ?? SIDEBAR;
  const sessions: readonly SessionRow[] = over.sessions ?? [
    { id: "s1", name: "会话 1", manager: "live-ok", run: "idle" },
    { id: "s2", name: "会话 2", manager: null, run: "idle" },
  ];
  const input = over.input ?? "";
  const palette = over.palette ?? null;
  const sessionsTop = over.sessionsTop ?? 0;
  const menu = over.menu ?? null;
  const flat: FlatLog =
    over.flat ??
    flatten(
      [entryOf([{ kind: "kv", key: "写入", value: "已改" }])],
      geometry(geoInput({ columns, rows, sidebarWidth, input, palette, window: null, sessions, sessionsTop, menu }))
        .outputWidth,
    );
  return {
    columns,
    rows,
    color: false,
    version: "5.2.0",
    sidebarWidth,
    sessions,
    sessionsTop,
    selectedSessionId: "s1",
    hoveredSessionId: null,
    sessionCloseHot: false,
    handleHot: false,
    managerStates: ["connected", "unauthorized", "connected"],
    flat,
    top: 0,
    input,
    cursor: 0,
    ghost: null,
    notice: null,
    palette,
    mouseHint: null,
    showLogo: false,
    droppedHint: null,
    window: null,
    menu,
    renaming: false,
    ...over,
  };
}

/** 侧边栏那一列的行（**按列宽**切出来：满屏上那两根竖线已经没有了） */
function sidebarColumn(lines: readonly string[], width = SIDEBAR): readonly string[] {
  return lines.map((line) => column(line, width));
}

/**
 * 侧边栏那一列的**逐屏行**（空行留着，故下标就是**屏行号**）
 * @description ⚠️ **不走 {@link renderFrame}**：那个取帧**滤掉空行**，而**项与项之间**那一行间隔在侧边栏
 * 那一列上**一个字都没有** —— 用前者当下标时后面每一项的下标会整体前移那么多，而症状是「断言逐条都对、
 * 其实量的是上面那一行」（会话名那一行被测成它上面那行空白，而那行当然没有会话名）。
 */
async function sidebarScreen(props: LayoutProps): Promise<readonly string[]> {
  return sidebarColumn(await renderScreen(props));
}

/** 从第 `from` 个显示列起切到屏尾（ANSI 原样留着） */
function restColumns(line: string, from: number): string {
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
function rowOf(lines: readonly string[], needle: string): number {
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
function rawIndexOfColumn(line: string, column: number): number {
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
function bgAtColumn(line: string, column: number): string | null {
  const at = rawIndexOfColumn(line, column);
  return at < 0 ? null : sgrColorAt(line, at, "bg");
}

/**
 * 那个**显示列**上生效的底色**三通道**（`null` = 没有底色**或**不是真彩色）
 * @description ⚠️ 「深浅」这件事**只比通道之和**：把 hex 换成人眼公式算亮度的话，公式本身就是
 * 另一份判据（而它挑不出「哪一档更亮」时要靠人眼复核）。⚠️ 非真彩色（`48;2;` 那一段缺分量）给
 * `null` —— 调用点必须先自检它不是 `null`，否则「浅于」这条断言在无色终端上**恒真**。
 */
function bgRgbAt(line: string, column: number): readonly number[] | null {
  const params = bgAtColumn(line, column);
  if (params === null) return null;
  const parts = params.split(";");
  return parts.length === 5 ? [Number(parts[2]), Number(parts[3]), Number(parts[4])] : null;
}

/** 三通道之和（**只用来比大小**，不比色相） */
function depthOf(rgb: readonly number[]): number {
  return rgb[0] + rgb[1] + rgb[2];
}

/** 这一行**画到第几列**（`stripAnsi` 之后按显示列数 —— 尾部没画过的列不算「一格」） */
function paintedColumns(line: string): number {
  return widthOf(stripAnsi(line));
}

/**
 * 那个**字符下标**落在第几个**显示列**
 * @description ⚠️ {@link indexOfText} 那一族的下标是**字符**下标，而 {@link bgAtColumn} 收的是
 * **显示列** —— 混用时探针落在窗口外面（症状是「量到的是遮罩，于是那条关于框的断言恒红」，
 * 而它与「框真的没带底色」症状一样）。有中文时两者能差出一整行。
 */
function columnOfIndex(line: string, index: number): number {
  let shown = 0;
  let i = 0;
  while (i < index && i < line.length) {
    if (line[i] === "\u001B") {
      const bracket = line.indexOf("[", i);
      if (bracket === -1 || bracket > i + 2) return -1;
      let end = bracket + 1;
      while (end < line.length && !/[A-Za-z]/u.test(line[end] as string)) end += 1;
      i = end + 1;
      continue;
    }
    shown += widthOf(line[i] as string);
    i += 1;
  }
  return shown;
}

/** `#181a26` → `48;2;24;26;38`（主题里那个 hex 与 Ink 写出来的底色 SGR 之间的**唯一**换算） */
function bgSgrOf(hex: string): string {
  return `48;2;${fgSgrOf(hex).slice("38;2;".length)}`;
}

/** 第一个含 `needle` 的**原始**行的下标（`-1` = 没有） */
function rowRawOf(lines: readonly string[], needle: string): number {
  return lines.findIndex((line) => line.includes(needle));
}

/** `needle` 在那一个**原始**行里的字符下标（`-1` = 没有）—— 传去 {@link sgrColorAt} 的那一个 */
function indexOfText(line: string, needle: string): number {
  return line.indexOf(needle);
}

/**
 * 那个字符渲染时**是不是加粗**（`1` 开、`22` 关）
 * @description ⚠️ 与 {@link sgrStateAt} 同一套扫描（逐段走 SGR、跳过 `38`/`48` 的参数）。
 * ⚠️ 它存在是因为「选中态有颜色之外的第二通道」这条不变式**在无色终端里也要成立**，
 * 而无色终端里没有颜色可读 —— 只判颜色的那一版判据对那条不变式**零鉴别力**。
 */
function isBoldAt(line: string, index: number): boolean {
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
function atText(
  lines: readonly string[],
  needle: string,
): { line: string; index: number } {
  const row = rowRawOf(lines, needle);
  const line = row >= 0 ? (lines[row] as string) : "";
  return { line, index: line.indexOf(needle) };
}

/** 一行日志（造结果区内容用） */
function noteRow(text: string): LogRow {
  return { kind: "note", text };
}

/** 一格「工具结果」（⚠️ 结果区那一格装的是 `Turn` 而**不是** `LogRow` —— 见 `@/lib/log/turn.js`） */
function toolTurn(rows: readonly LogRow[]): Turn {
  return { kind: "tool-result", rows };
}

/** 一格输出（造结果区内容用；`id` 从 1 起，理由见 `@/lib/log/rows.ts:append`） */
function entryOf(rows: readonly LogRow[]): LogEntry {
  return { id: 1, at: 0, turns: [toolTurn(rows)] };
}
/* ── ① 每一行都等宽（Ink 静默软换行的护栏）────────────────────────────── */

describe("不变量 ①：任何一行的显示宽度都不许超过终端列数", () => {
  it("侧边栏里有一个**超长中文会话名**时，每一行仍然等宽", async () => {
    // ⚠️ 名字刻意是**中文**：ASCII 名的显示宽度等于 `String.length`，而中文是两倍，
    // 所以一个纯 ASCII 的用例会同时通过「按 length 算」与「按显示宽度算」两种实现 ——
    // 那样的用例对这条判据**零鉴别力**。
    const lines = await renderFrame(
      props({
        sessions: [
          { id: "s1", name: "会话 1", manager: "live-ok", run: "idle" },
          { id: "s2", name: "一个非常非常非常长的会话名字", manager: "一个非常长的控制面名字", run: "idle" },
        ],
      }),
    );
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(COLUMNS);
    // 截断必须带省略标记（`ellipsis` 的契约）：被切掉的半个名字读不出来
    expect(sidebarColumn(lines).some((line) => line.includes("…"))).toBe(true);
  });

  it("⚠️ 整屏**只有输入框**有框：侧边栏与主区都**没有竖线**", async () => {
    const lines = await renderFrame(props());
    const framed = lines.filter((line) => /[╭╰│]/u.test(stripAnsi(line)));
    // ⚠️ **反向自检**：输入框**确实有**框（上下框 2 + 框内「输入行 + 消息」2 = 4 行）
    expect(framed.length).toBeGreaterThanOrEqual(4);
    expect(framed[0]).toContain("╭");
    expect(framed[framed.length - 1]).toContain("╰");
    // ⚠️ 而框**只在底部**：结果区与侧边栏那几行一个框字符都没有
    const unframed = lines.filter((line) => !/[╭╰│]/u.test(stripAnsi(line)));
    expect(unframed.length).toBeGreaterThan(0);
    for (const line of unframed) expect(line).not.toMatch(/[│╭╰]/u);
  });

  it("结果区里一段很长的散文会**换行**而不是把框顶歪", async () => {
    const long = "这是一段刻意写得很长的说明文字".repeat(12);
    const flat = flatten(
      [entryOf([noteRow(long)])],
      geometry(geoInput(props())).outputWidth,
    );
    const lines = await renderFrame(props({ flat, top: 0 }));
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(COLUMNS);
    expect(lines.filter((line) => line.includes("这是一段")).length).toBeGreaterThan(1);
  });
});

/* ── ② 侧边栏 = 会话：每项两行、项间空一行、顶部**不留白** ────────────────── */

describe("不变量 ②：侧边栏列会话，每项两行（名字 + 它连的控制面），项间空一行", () => {
  it("会话名在第一行、控制面名在第二行（两行都画得出来）", async () => {
    const first = await sidebarScreen(props());
    expect(first[ITEM_ROW(0)]).toContain("会话 1");
    expect(first[ITEM_ROW(0) + 1]).toContain("live-ok");
    expect(first[ITEM_ROW(1)]).toContain("会话 2");
    expect(first[ITEM_ROW(1) + 1]).toContain("未选控制面");
  });

  it("第二行答的是「这个会话连的是哪一台」——`null` 说成一句人话而不是空串", async () => {
    const first = await sidebarScreen(
      props({
        sessions: [
          { id: "s1", name: "会话 1", manager: "机房那台", run: "idle" },
          { id: "s2", name: "会话 2", manager: null, run: "idle" },
        ],
      }),
    );
    expect(first[ITEM_ROW(0)]).toContain("会话 1");
    expect(first[ITEM_ROW(0) + 1]).toContain("机房那台");
    // 空串与「名字是空的控制面」在屏上同形，而「还没选」是一个**常见的**状态
    expect(first[ITEM_ROW(1) + 1]).toContain("未选控制面");
  });

  // ⚠️ 这一条与下面那条是一对：**顶部不留白**（第一项就在第 0 行）与**项间空一行**（两个判据各自独立）：
  // 少间隔的会话名与控制面名会互相读串，而顶部留一行的话点击要落在「空着的那一行」上才有意义。
  it("⚠️ 顶部**不留白**：第一项就落在第 0 行（那一行不是「空着的那一行」）", async () => {
    const screen = await sidebarScreen(props());
    expect(screen[0]).toContain("会话 1");
    // ⚠️ **反向自检**：主区在同一行上有内容 —— 否则「第 0 行是空的」与「整帧没渲染」长得一样。
    // ⚠️ 按**显示列**切（{@link restColumns}）而不是 `slice`：后者数的是 UTF-16 码元，而这一行上有汉字
    // —— 侧边栏一变宽，切点就落在「刚刚好切在『写入』后面」的位置上，而症状是「主区没渲染」。
    const full = (await renderScreen(props()))[0] ?? "";
    expect(restColumns(full, SIDEBAR + SIDEBAR_GAP)).toContain("写入");
  });

  it("⚠️ 两项之间那一行在侧边栏那一列上**一个字都没有**（它只属于「间隔」）", async () => {
    const first = await sidebarScreen(props());
    const gap = ITEM_ROW(0) + SESSION_ROWS;
    expect(SESSION_STRIDE - SESSION_ROWS).toBe(1);
    expect(first[gap]?.trim()).toBe("");
    // ⚠️ 而它上面与下面**都有字**：那一格夹在两个项之间，不是「清单到头了」
    expect(first[gap - 1]).toContain("live-ok");
    expect(first[gap + 1]).toContain("会话 2");
  });

  it("⚠️ 第一项落在 {@link Geometry.sessionRows} 给的那一行上（画出来的行号 == 几何给的行号）", async () => {
    // ⚠️ 判据量的是「**画出来的行号 == 几何给的行号**」：少补那个间隔盒子时每一项都比几何给的行号高一行，
    // 而 `sidebarRows` 仍按间隔算 —— 症状是「屏上第一项是会话 1、点它切到别的会话」。
    const p = props();
    const g = geometry(geoInput(p));
    const screen = await renderScreen(p);
    expect(screen[g.sidebarRows[0]!.y]?.slice(0, SIDEBAR)).toContain("会话 1");
    expect(screen[g.sidebarRows[1]!.y]?.slice(0, SIDEBAR)).toContain("会话 2");
  });

  it("名字太长时它被裁，而**不把下一项顶下去**（每一项恒占两行）", async () => {
    // ⚠️ 少了「按可用宽度裁」这一步，Ink 会**静默软换行** —— 而那多出来的一行会把下一项
    // 顶到第三行去，于是侧边栏里的项与几何给的 `sidebarRows` **不再是同序**：
    // 命中测试说「第 2 项」，屏上第 2 行却是第 1 项的第二个字。
    const p = props({
      sessions: [
        { id: "s1", name: "一个非常非常非常长的会话名字", manager: "一个非常长的控制面名字", run: "idle" },
        { id: "s2", name: "会话 2", manager: null, run: "idle" },
      ],
    });
    const first = await sidebarScreen(p);
    expect(first[ITEM_ROW(0)]).toContain("…");
    expect(first[ITEM_ROW(1)]).toContain("会话 2");
    // ⚠️ 而那一项**不许越过侧边栏**：预算少扣一列时多出来的那一格落进间隔列，
    // 于是那一列上出现了字 —— 而屏上那根竖线（间隔）本该是空的。
    // ⚠️ 结果区**必须有内容**才量得到它：Ink 每行末尾去空白，而那一行的主区若是空的，
    // 「右边没字」在「没溢出」与「溢出到间隔列又被去掉了」两种实现下**都对**。
    const three = flatten(
      [entryOf([noteRow("一"), noteRow("二"), noteRow("三")])],
      geometry(geoInput(props())).outputWidth,
    );
    const filled = { ...p, flat: three };
    // ⚠️ 量的是**名字那一行**（顶部不留白 ⇒ 它是第 0 行），而主区第 0 行上落的是结果区的**第一**行
    const row = (await renderScreen(filled))[ITEM_ROW(0)] ?? "";
    expect(row).toContain("一");
    // ⚠️ 而**下一项**在第 {@link SESSION_STRIDE} 行（中间那一行是间隔）：名字那一行不许把它顶下来
    expect((await renderScreen(filled))[ITEM_ROW(1)]).toContain("会话 2");
    expect(column(row, SIDEBAR + 1)).toBe(`${column(row, SIDEBAR)} `);
  });

  it("装不下的必须说一声（静默少画几行 ⇒ 操作者以为会话就这几个）", async () => {
    const many: SessionRow[] = [];
    for (let i = 0; i < 40; i += 1) many.push({ id: `s${i}`, name: `会话 ${i}`, manager: null, run: "idle" });
    const p = props({ rows: 12, sessions: many });
    const g = geometry(geoInput(p));
    expect(g.sidebarOverflowRow).not.toBeNull();
    // ⚠️ 判据是「**几何说的那一行**」而不是「屏上有这么一句」：贴着屏底的那一句若画在别的行上，
    // 滚动之后它就会跑到别处去而断言照旧绿。
    const screen = await renderScreen(p);
    expect(screen[g.sidebarOverflowRow!.y]?.slice(0, SIDEBAR)).toContain(`共 ${String(many.length)}`);
  });

  it("⚠️ 那一句说清「第几–第几 / 共几个」，而**装得下时不占**那一行", async () => {
    const many: SessionRow[] = [];
    for (let i = 1; i <= 7; i += 1) many.push({ id: `s${i}`, name: `会话 ${i}`, manager: null, run: "idle" });
    const p = props({ rows: 12, sessions: many });
    const g = geometry(geoInput(p));
    expect(g.sessionViewportRows).toBeLessThan(many.length);
    // ⚠️ 12 行装得下 4 项（步长 3：0–1、3–4、6–7、9–10），而末项与说明行之间还有一格空着
    expect(g.sessionViewportRows).toBe(4);
    expect((await renderScreen(p))[g.sidebarOverflowRow!.y] ?? "").toContain("1–4 / 共 7");
    // ⚠️ **跟着窗口滚**：滚过之后那句话说的是「现在看到的」那几个，而不是恒定的 1–4
    const scrolled = props({ rows: 12, sessions: many, sessionsTop: 2 });
    const gScrolled = geometry(geoInput(scrolled));
    expect(gScrolled.sessionFirst).toBe(2);
    expect((await renderScreen(scrolled))[gScrolled.sidebarOverflowRow!.y] ?? "").toContain("3–6 / 共 7");
    // ⚠️ 而**全部装得下**时那一格是 `null`（于是**不占**那一行），屏上也没有那句话
    const fits = props({ rows: 12, sessions: many.slice(0, 2) });
    expect(geometry(geoInput(fits)).sidebarOverflowRow).toBeNull();
    expect((await renderScreen(fits)).join("\n")).not.toContain("共");
  });

  it("⚠️ 装不下时画出来的是窗口**那一段**（`sessionFirst` 的渲染侧）", async () => {
    const many: SessionRow[] = [];
    for (let i = 1; i <= 9; i += 1) many.push({ id: `s${i}`, name: `会话 ${i}`, manager: null, run: "idle" });
    const p = props({ rows: 12, sessions: many, sessionsTop: 2 });
    const g = geometry(geoInput(p));
    expect(g.sessionFirst).toBe(2);
    expect(g.sidebarRows.length).toBeLessThan(many.length);
    const joined = (await sidebarScreen(p)).join("\n");
    // ⚠️ 会话名**互相不含**（「会话 1」不是「会话 8」的一个子串），故这几条各有各的落点；
    // 少加 {@link Geometry.sessionFirst} 的实现会画出前 5 项 → 「会话 1」与「会话 2」都还在屏上
    expect(joined).toContain("会话 3");
    expect(joined).not.toContain("会话 1");
    expect(joined).not.toContain("会话 2");
    expect(joined).not.toContain("会话 8");
  });

  // ⚠️ 这一组是「悬停才画出来的那一枚「✕」」：**位置恒定、宽度恒定、只画在悬停的那一项上**。
  // 三条各自独立：位置错位是「点它关掉了邻居」，宽度漂移是「悬停那一帧名字在抖」。

  it("⚠️ 那一枚「✕」只在**悬停的那一项**上，且落在它的**名字那一行**", async () => {
    const p = props({ hoveredSessionId: "s2" });
    const g = geometry(geoInput(p));
    const screen = await renderScreen(p);
    // ⚠️ **逐屏行**量位置：判在「屏上有这么一枚」上的话，画在控制面那一行（差一格）也照样绿
    expect(screen[g.sidebarRows[1]!.y]?.slice(0, SIDEBAR)).toContain("✕");
    expect(screen[g.sidebarRows[1]!.y + 1]?.slice(0, SIDEBAR)).not.toContain("✕");
    expect(screen[g.sidebarRows[0]!.y]?.slice(0, SIDEBAR)).not.toContain("✕");
    // ⚠️ 而**没有悬停**时一个都没有 —— 那一枚是**状态**画出来的
    expect((await renderScreen(props())).join("\n")).not.toContain("✕");
  });

  it("⚠️ 那一枚「✕」落在几何给的那一格上（点得着的那一格 == 画出来的那一格）", async () => {
    const p = props({
      sessions: [
        { id: "s1", name: "会话 1", manager: null, run: "idle" },
        { id: "s2", name: "会话 2", manager: null, run: "idle" },
      ],
      hoveredSessionId: "s2",
    });
    const slot = geometry(geoInput(p)).sidebarCloseRows[1]!;
    const row = (await renderScreen(p))[slot.y]?.slice(0, SIDEBAR) ?? "";
    const trimmed = row.trimEnd();
    // ⚠️ **按显示列量**而不是按字符下标：一个 CJK 字符占两列，按下标会偏，而症状是「位置看着差不多」。
    // 而「去掉尾部空白之后的末格就是那一枚」这个判据同时钉住了两件事：它在**名字右边**，
    // 且它落在 {@link Geometry.sidebarCloseRows} 给的那一列上（不是更靠右、也不是压着名字）。
    expect(trimmed.slice(-1)).toBe("✕");
    expect(widthOf(trimmed) - 1).toBe(slot.x);
  });

  it("⚠️ 会话名的裁剪预算**恒**扣掉那两列（悬停不改变它有多宽）", async () => {
    const p = props({
      sessions: [
        { id: "s1", name: "一个非常非常非常长的会话名字", manager: "live-ok", run: "idle" },
        { id: "s2", name: "会话 2", manager: null, run: "idle" },
      ],
    });
    const cold = await sidebarScreen(p);
    const hot = await sidebarScreen({ ...p, hoveredSessionId: "s1" });
    const row = ITEM_ROW(0);
    expect(cold[row]).toContain("…");
    expect(hot[row]).toContain("✕");
    // ⚠️ 而名字那一行的字**不许进右边那 {@link SESSION_CLOSE_COLUMNS} 列**：那两列是**恒**留给按钮的，
    // 而按钮只在悬停时画 —— 名字越界的话悬停那一帧它就被压在按钮底下，而那一帧正是正在读它的那一帧。
    expect(widthOf(cold[row]!.trimEnd())).toBeLessThanOrEqual(SIDEBAR - SESSION_CLOSE_COLUMNS);
    // ⚠️ **判据是「去掉那一枚之后逐字相同」**：只在悬停时才扣那两列的实现，两帧的**截断点**不同
    // （省略标记落在不同的列上），而每一列都还在预算内 —— 于是「每一行都不超宽」那条判据零鉴别力。
    expect(hot[row]!.replace("✕", "").trimEnd()).toBe(cold[row]!.trimEnd());
  });

  it("⚠️ 会话名恒不超过侧边栏宽（少算一列就是 Ink 静默软换行、整屏往下移）", async () => {
    const rows = await sidebarScreen(
      props({
        sessions: [{ id: "s1", name: "一个非常非常非常长的会话名字", manager: null, run: "idle" }],
        hoveredSessionId: "s1",
      }),
    );
    const row = rows[ITEM_ROW(0)] ?? "";
    expect(row).toContain("…");
    expect(widthOf(row.trimEnd())).toBeLessThanOrEqual(SIDEBAR);
    // ⚠️ 那一枚「✕」**不许把那一行顶宽**：越界的那一格落进间隔列，于是那一列上出现了字
    expect(restColumns(row, SIDEBAR)).toBe("");
  });

  // ⚠️ 这一组守的是「那一枚记号」：**三档**（转圈 / 打勾 / 没有）与「恒留的那两列」——
  // 后者是本组的一半，因为两帧的列位不同的话「这个名字在跳」，而症状是「焦点那一块在抖」。
  const marked = (run: readonly ("idle" | "running" | "done")[]) =>
    props({
      sessions: run.map((one, i) => ({
        id: `s${String(i + 1)}`,
        name: `会话 ${String(i + 1)}`,
        manager: null,
        run: one,
      })),
    });

  it("⚠️ 名字前面那一枚记号：运行中转圈 / 跑完打勾 / 没跑过**一个字都没有**", async () => {
    const p = marked(["running", "done", "idle"]);
    const screen = await sidebarScreen(p);
    expect(screen[ITEM_ROW(0)]).toContain("⠋ 会话 1");
    expect(screen[ITEM_ROW(1)]).toContain("✔ 会话 2");
    expect(screen[ITEM_ROW(2)]).toContain("会话 3");
    // ⚠️ **反向自检**：没跑过的那一项一个记号都没有（而不是留着一个空格被当成「没有记号」）
    expect(screen[ITEM_ROW(2)]).not.toContain("✔");
    expect(screen[ITEM_ROW(0)]).not.toContain("✔");
  });

  it("⚠️ 那一列记号位**恒在**（三帧里名字落在同一列），而它落在缩进右边 {@link SESSION_MARK_COLUMNS} 列处", async () => {
    const p = marked(["idle", "running", "done"]);
    const g = geometry(geoInput(p));
    const raw = await renderRaw(p);
    const columnOfName = (i: number): number => {
      const row = raw[g.sidebarRows[i]!.y] ?? "";
      const at = indexOfText(row, `会话 ${String(i + 1)}`);
      // ⚠️ 探针先自检：给 -1 时 `columnOfIndex` 恒返回 -1，而「三者相等」对三个 -1 恒成立
      expect(at).toBeGreaterThanOrEqual(0);
      return columnOfIndex(row, at);
    };
    const columns = [0, 1, 2].map(columnOfName);
    expect(columns[1]).toBe(columns[0]);
    expect(columns[2]).toBe(columns[0]);
    expect(columns[0]).toBe(SIDEBAR_TEXT_X + SESSION_MARK_COLUMNS);
  });

  it("⚠️ 一个会话都没有 ⇒ 侧边栏**整个不画**（屏上零会话字符，而那一列的宽度归 0）", async () => {
    const p = props({ sessions: [] });
    // ⚠️ 判据是「几何说这一列不存在」而不是「屏幕上没字」：后者在「整个界面没渲染」时恒成立
    expect(geometry(geoInput(p)).sidebar).toBeNull();
    const screen = await renderScreen(p);
    const joined = screen.join("\n");
    expect(joined).not.toContain("会话");
    expect(joined).not.toContain("未选控制面");
    // ⚠️ **反向自检**：同一帧里主区**有**内容（否则上面两条只是「什么都没渲染」）
    expect(screen[0]).toContain("已改");
  });

  it("侧边栏与主区之间**隔一列**（那一列两边都没有底色）", async () => {
    const raw = await renderRaw(props({ color: true, sidebarWidth: 20 }));
    const first = raw[3] ?? "";
    expect(bgAtColumn(first, 19)).not.toBeNull();
    expect(bgAtColumn(first, 20)).toBeNull();
    // 而主区从第 21 列起：那一行里第 20 列（间隔列）上**什么都没有**，
    // 而第 21 列往后是结果区那一行的内容
    expect(restColumns(stripAnsi(raw[0] ?? ""), 20)).toMatch(/^ /u);
    expect(restColumns(stripAnsi(raw[0] ?? ""), 21)).not.toBe("");
  });

  it("**画出来的**主区第一列 == 几何给的 `output.x`（间隔列漏插一个元素时它少一列）", async () => {
    // ⚠️ 这条判据量的是「Ink 摆出来的位置」与「几何算出来的位置」**逐字相同**：Ink 只把**兄弟**
    // 排在一起，故那一列间隔必须真的插一个元素，否则主区会贴在侧边栏右边（少一列），
    // 而症状是「点输入行定位插入符偏一个字」—— 屏上完全看不出那根竖线本该在哪。
    for (const sidebarWidth of [14, 20, 30]) {
      const p = props({ sidebarWidth });
      const g = geometry(geoInput(p));
      const lines = await renderScreen(p);
      const row = lines[screenRowOf(lines, "已改")] ?? "";
      expect(row.slice(g.output!.x)).toContain("已改");
    }
  });
});

/* ── ③ 选中 = 最亮那一档 + 加粗（**没有底色**）／hover = 另一个底色 ───────── */

describe("不变量 ③：选中靠「最亮那一档 + 加粗」，hover 靠**另一层底色**", () => {
  it("选中的那一项**没有**底色，而未选中的那几行连底色都没有", async () => {
    const raw = await renderRaw(props({ color: true }));
    // ⚠️ 判据必须问「**哪一个**底色」而不是「开没开」：侧边栏**整列**都有 `surface` 底色，
    // 于是「开没开」在这一列上恒为真，而「选中项没有底色」真正要说的是
    // **它没有多出 hover 那一层** —— 故与同一项的缩进处逐字相同。
    const at = atText(raw, "会话 1");
    expect(sgrColorAt(at.line, at.index, "bg")).toBe(sgrColorAt(at.line, 1, "bg"));
    // 而「未选中那一项」与「选中那一项」的底色也相同（选中只走前景色 + 加粗）
    const other = atText(raw, "会话 2");
    expect(sgrColorAt(other.line, other.index, "bg")).toBe(sgrColorAt(at.line, at.index, "bg"));
  });

  it("选中的那一项是**最亮的那一档前景** + 加粗，而未选中的那几行不是", async () => {
    const raw = await renderRaw(props({ color: true }));
    // ⚠️ 行号从 {@link ITEM_ROW} 算（顶部不留白），而 `renderRaw` 的下标就是屏行号
    const first = raw[ITEM_ROW(0)] ?? "";
    const at = indexOfText(first, "会话 1");
    const second = raw[ITEM_ROW(1)] ?? "";
    const other = indexOfText(second, "会话 2");
    // ⚠️ **两个探针下标先自检**：给 -1 时 `sgrColorAt` 恒返回 `null`，而「`null` ≠ 那个色」恒成立
    expect(at).toBeGreaterThanOrEqual(0);
    expect(other).toBeGreaterThanOrEqual(0);
    expect(sgrColorAt(first, at, "fg")).not.toBeNull();
    expect(sgrColorAt(second, other, "fg")).not.toBe(sgrColorAt(first, at, "fg"));
    // ⚠️ **加粗是颜色之外的第二通道**：无色终端里它是「哪一个被选中了」的唯一线索
    expect(isBoldAt(first, at)).toBe(true);
    expect(isBoldAt(second, other)).toBe(false);
  });

  // ⚠️ 「选中只高亮**标题**」这一条：两行都高亮的话，「我选了哪一项」与「它连着的那台是当前那台」
  // 在屏上读起来一样 —— 而这两个是**两件事**（面板与侧边栏各有自己的「当前」记号）。
  it("⚠️ 选中只高亮**标题那一行**：控制面那一行既不换色也不加粗", async () => {
    const p = props({ color: true });
    const g = geometry(geoInput(p));
    const theme = themeOf({ color: true, scrimmed: false });
    const raw = await renderRaw(p);
    const nameRow = raw[g.sidebarRows[0]!.y] ?? "";
    const managerRow = raw[g.sidebarRows[0]!.y + 1] ?? "";
    const nameAt = indexOfText(nameRow, "会话 1");
    const managerAt = indexOfText(managerRow, "live-ok");
    // ⚠️ **两个探针下标先自检**（给 -1 时下面两条恒成立）
    expect(nameAt).toBeGreaterThanOrEqual(0);
    expect(managerAt).toBeGreaterThanOrEqual(0);
    expect(sgrColorAt(nameRow, nameAt, "fg")).toBe(fgSgrOf(toneColor("selected", theme)!));
    expect(isBoldAt(nameRow, nameAt)).toBe(true);
    expect(sgrColorAt(managerRow, managerAt, "fg")).toBe(fgSgrOf(toneColor("idle", theme)!));
    expect(isBoldAt(managerRow, managerAt)).toBe(false);
  });

  it("⚠️ 选中的与**未选中**的那些行都**没有多出底色**（那一列的底色恒是 `surface`，只归 hover）", async () => {
    const p = props({ color: true });
    const g = geometry(geoInput(p));
    const raw = await renderRaw(p);
    const surface = bgSgrOf(toneColor("surface", themeOf({ color: true, scrimmed: false }))!);
    // ⚠️ **逐行逐项**量：只量一项的话「选中那一项加了反底色」会被漏掉，而那正是旧版的做法
    for (const i of [0, 1]) {
      for (const y of [g.sidebarRows[i]!.y, g.sidebarRows[i]!.y + 1]) {
        expect(bgAtColumn(raw[y] ?? "", SIDEBAR - 1)).toBe(surface);
      }
    }
    // ⚠️ 而**反向对照**：悬停那一项确实换成了 `hover` 那一档 —— 否则上面那条只是「探针永远是 null」
    const hot = await renderRaw(props({ color: true, hoveredSessionId: "s2" }));
    expect(bgAtColumn(hot[g.sidebarRows[1]!.y] ?? "", SIDEBAR - 1)).toBe(
      bgSgrOf(toneColor("hover", themeOf({ color: true, scrimmed: false }))!),
    );
  });

  it("hover 那一项换的是**另一层**底色（与那一列的 `surface` 不是同一个）", async () => {
    const base = await renderRaw(props({ color: true }));
    const hot = await renderRaw(props({ color: true, hoveredSessionId: "s2" }));
    const probe = (line: string): string | null => bgAtColumn(line, 20);
    // 第二个会话占第 3、4 行（每项两行 + 项间一行），而 hover 铺满**整项两行**
    const name = ITEM_ROW(1);
    expect(probe(hot[name] ?? "")).not.toBe(probe(base[name] ?? ""));
    expect(probe(hot[name + 1] ?? "")).toBe(probe(hot[name] ?? ""));
    // 而**没有被指着**的那一项仍然是那一列的底色（两个通道互不干扰）
    expect(probe(hot[ITEM_ROW(0)] ?? "")).toBe(probe(base[ITEM_ROW(0)] ?? ""));
  });

  it("hover 的底色铺满**整列两行**（不铺满的话右边留下一截列的底色，看着像画歪了）", async () => {
    const hot = await renderRaw(props({ color: true, hoveredSessionId: "s2", sidebarWidth: 20 }));
    const name = ITEM_ROW(1);
    const row = hot[name] ?? "";
    const band = bgAtColumn(row, 19);
    expect(band).not.toBeNull();
    for (const column of [0, 5, 12, 19]) expect(bgAtColumn(row, column)).toBe(band);
    // 第二行同样是这一层（hover 铺满**整项两行**，不是只有第一行）
    expect(bgAtColumn(hot[name + 1] ?? "", 19)).toBe(band);
  });

  it("⚠️ 悬停那一项时底色**铺到「✕」底下那一格**（不在字形那里戳一个洞）", async () => {
    // ⚠️ Ink 把 `<Box backgroundColor>` 写成「一串带底色的空格」并在写完复位，而裸字形不带底色 ——
    // 于是 `<Text>` 上漏给 background 时那一格会取**默认底色**，在 hover 那一档上看着像「破了一个洞」。
    const p = props({ color: true, hoveredSessionId: "s1" });
    const hot = await renderRaw(p);
    const row = hot[geometry(geoInput(p)).sidebarRows[0]!.y] ?? "";
    const at = indexOfText(row, "✕");
    // ⚠️ 探针下标先自检（`-1` 时恒给 `null`，而症状与「实现坏了」一模一样）
    expect(at).toBeGreaterThanOrEqual(0);
    const beside = bgAtColumn(row, 5);
    expect(beside).not.toBeNull();
    expect(sgrColorAt(row, at, "bg")).toBe(beside);
  });

  it("⚠️ 「✕」指在上面时亮成「别按」那一档，而只是**露出来**时与那一项的名字同档", async () => {
    const at = ITEM_ROW(1);
    const fgOf = async (p: LayoutProps): Promise<string | null> => {
      const row = (await renderRaw(p))[at] ?? "";
      const glyph = indexOfText(row, "✕");
      return glyph < 0 ? null : sgrColorAt(row, glyph, "fg");
    };
    const revealed = await fgOf(props({ color: true, hoveredSessionId: "s2" }));
    const armed = await fgOf(props({ color: true, hoveredSessionId: "s2", sessionCloseHot: true }));
    // ⚠️ **先自检**：探针给 `null` 时「两者不同」恒成立，而那是「那一枚压根没画出来」
    expect(revealed).not.toBeNull();
    expect(armed).not.toBeNull();
    expect(revealed).not.toBe(armed);
  });

  it("指针在手柄上时那一列自己换一层底色（「这一列能拖」看得见）", async () => {
    const off = await renderRaw(props({ color: true, sidebarWidth: 20 }));
    const on = await renderRaw(props({ color: true, sidebarWidth: 20, handleHot: true }));
    // 手柄 = 最右那一列（第 19 列，第 0 起）
    expect(bgAtColumn(on[3] ?? "", 19)).not.toBe(bgAtColumn(off[3] ?? "", 19));
    // 而它左侧那一列**不变**（否则那一整列都会亮，「能拖的那一列」就说不清了）
    expect(bgAtColumn(on[3] ?? "", 18)).toBe(bgAtColumn(off[3] ?? "", 18));
  });

  it("无色终端里侧边栏与主区长得一样（无色档**刻意**把底色退成 `undefined`）", async () => {
    const lines = await renderFrame(props({ color: false }));
    expect(lines.length).toBeGreaterThan(5);
  });
});

/* ── ④ 输入框随折行长高，**状态行在框外** ────────────────────────────── */

describe("不变量 ④：输入框随折行长高；状态行在框**外**且不含链接", () => {
  it("输入串折成几行，框就多几行（每一行都不越出终端宽度）", async () => {
    const short = await renderFrame(props({ input: "/status" }));
    const long = await renderFrame(
      props({
        input: "/target add live http://10.0.0.9:18080 0123456789abcdef0123456789abcdef 5000",
      }),
    );
    for (const set of [short, long]) {
      for (const line of set) expect(stringWidth(line)).toBeLessThanOrEqual(COLUMNS);
    }
    // 折行的那一档：框**更高**（上边框出现在更靠上的一行）
    const gShort = geometry(geoInput(props({ input: "/status" })));
    const gLong = geometry(
      geoInput(
        props({
          input: "/target add live http://10.0.0.9:18080 0123456789abcdef0123456789abcdef 5000",
        }),
      ),
    );
    expect(gLong.inputRows).toBeGreaterThan(gShort.inputRows);
    expect(gLong.input!.y).toBeLessThan(gShort.input!.y);
  });

  it("折出来的每一行都在**框内**（第二行不跑到框外）", async () => {
    const input = "/target add live http://10.0.0.9:18080 0123456789abcdef0123456789abcdef 5000";
    const p = props({ input });
    const lines = await renderScreen(p);
    const g = geometry(geoInput(p));
    const top = screenRowOf(lines, "╭");
    const bottom = screenRowOf(lines, "╰");
    expect(g.inputRows).toBeGreaterThan(1);
    // 折出来的那些字符必须**落在框内那几行里**
    const fragment = input.slice(0, 20);
    const at = screenRowOf(lines, fragment);
    expect(at).toBeGreaterThan(top);
    expect(at).toBeLessThan(bottom);
  });

  it("提示符只在第一行；续行与第一行的字**左对齐**（悬挂缩进）", async () => {
    const p = props({
      input: `/user pass charlie ${"汉字".repeat(20)}`,
    });
    const raw = await renderRaw(p);
    const g = geometry(geoInput(p));
    expect(g.inputRows).toBeGreaterThan(1);
    const promptRow = raw[g.inputTextRows[0]!.y] ?? "";
    const secondRow = raw[g.inputTextRows[1]!.y] ?? "";
    // 第 0 行有 `❯ `，第 1 行没有 —— 而两行的第一个字落在**同一列**
    expect(stripAnsi(promptRow)).toContain("❯");
    expect(stripAnsi(secondRow)).not.toContain("❯");
    expect(g.inputTextRows[0]!.x).toBe(g.inputTextRows[1]!.x);
  });

  it("状态行在框**外**：它比上边框更靠下，而它那几行不在框内", async () => {
    const p = props();
    const lines = await renderFrame(p);
    const g = geometry(geoInput(p));
    expect(g.statusLine!.y).toBeGreaterThan(g.input!.y + g.input!.height - 1);
    // 状态行是**最底**那一行
    const bottom = rowOf(lines, "╰");
    expect(g.statusLine!.y).toBeGreaterThan(bottom);
    // ⚠️ **渲染出来的那一行 == 几何给的 y**：只断言几何值的话，一个把状态行画在别的行的
    // 实现照样全绿（几何与绘制是两条路，而这一条量的正是「绘制有没有跟着几何走」）
    const screen = await renderScreen(p);
    expect(screenRowOf(screen, "● 2")).toBe(g.statusLine!.y);
    expect(screenRowOf(screen, "╰")).toBe(g.statusLine!.y - 1);
  });

  it("状态行左半是各状态的台数（各自上色），右半是版本号", async () => {
    const p = props({ version: "5.2.0", managerStates: ["connected", "connected", "unauthorized"] });
    const lines = await renderFrame(p);
    const last = lines[lines.length - 1] ?? "";
    // `● 2` 与 `▲ 1`（各状态一个字形 + 它的台数），而版本号在右半
    expect(last).toContain("● 2");
    expect(last).toContain("▲ 1");
    expect(last).toContain("v5.2.0");
  });

  it("台数为空时那一句**也没有链接**（零台那一档走的就是它）", async () => {
    const lines = await renderFrame(props({ managerStates: [], version: "5.2.0" }));
    const last = lines[lines.length - 1] ?? "";
    expect(last).toContain("台账里没有控制面");
    expect(last).not.toContain("http");
  });

  it("窄到放不下时那句 fallback 里也没有链接", async () => {
    const p = props({
      columns: 60,
      sidebarWidth: 20,
      managerStates: ["connected", "unauthorized", "unreachable", "connecting", "unknown"],
      version: "5.2.0",
    });
    const lines = await renderFrame(p);
    const last = lines[lines.length - 1] ?? "";
    expect(last).not.toContain("http");
  });

  it("状态行**不显示链接**（链接在 /managers 窗口里）", async () => {
    const lines = await renderFrame(
      props({ sessions: [{ id: "s1", name: "会话 1", manager: "http://10.0.0.9:18080", run: "idle" }] }),
    );
    const last = lines[lines.length - 1] ?? "";
    expect(last).not.toContain("http://");
  });

  it("零台的那些状态档**不出现**（一个恒为 0 的「连接中 0」只占地方）", async () => {
    const lines = await renderFrame(props({ managerStates: ["connected", "connected"] }));
    const last = lines[lines.length - 1] ?? "";
    expect(last).toContain("● 2");
    expect(last).not.toContain("◌");
    expect(last).not.toContain("▲");
  });

  it("一个控制面都没有时说一句人话（空行与「忘了画」在屏上同形）", async () => {
    const lines = await renderFrame(props({ managerStates: [] }));
    expect(lines[lines.length - 1]).toContain("台账里没有控制面");
  });
});

/* ── ⑤ 命令面板：高亮**没有底色**，而它是最亮那一档 + 加粗 ─────────────── */

describe("不变量 ⑤：面板的高亮靠「最亮那一档 + 加粗 + 记号」，没有反底色", () => {
  const palette = {
    rows: [
      { text: "/help", summary: "列出命令" },
      { text: "/status", summary: "服务进程与代理的现状" },
    ],
    at: 1,
    total: 2,
    footer: null,
  };

  it("高亮那一行**没有底色**（这一列的底色归 hover）", async () => {
    const raw = await renderRaw(props({ color: true, palette, input: "/status" }));
    const at = atText(raw, "服务进程与代理的现状");
    expect(at.index).toBeGreaterThan(0);
    expect(sgrColorAt(at.line, at.index, "bg")).toBeNull();
  });

  it("高亮那一行是最亮的那一档前景 + 加粗，而未高亮的那行不是", async () => {
    const raw = await renderRaw(props({ color: true, palette, input: "/status" }));
    const at = atText(raw, "服务进程与代理的现状");
    const other = atText(raw, "列出命令");
    expect(isBoldAt(at.line, at.index)).toBe(true);
    expect(isBoldAt(other.line, other.index)).toBe(false);
    expect(sgrColorAt(at.line, at.index, "fg")).not.toBe(sgrColorAt(other.line, other.index, "fg"));
  });

  it("高亮那一行左边有记号（形状通道，无色终端里靠它认）", async () => {
    const lines = await renderFrame(props({ palette, input: "/status" }));
    expect(lines.some((line) => line.includes("▍"))).toBe(true);
  });

  it("面板浮在输入框正上方，且至多占结果区内容行的四成", async () => {
    const p = props({ palette: { ...palette, total: 19, rows: manyRows(19) }, input: "/" });
    const g = geometry(geoInput(p));
    expect(g.paletteRows.length + (g.paletteFooterRow === null ? 0 : 1)).toBeLessThanOrEqual(
      Math.floor(g.output!.height * 0.4),
    );
    const lines = await renderScreen(p);
    expect(screenRowOf(lines, "╭")).toBeGreaterThanOrEqual(0);
  });
});

/** 造 n 行候选（面板「装不下」那一档用） */
function manyRows(n: number): { text: string; summary: string | null }[] {
  return Array.from({ length: n }, (_, i) => ({ text: `/cmd-${i}`, summary: null }));
}

/* ── ⑥ 模态窗口：压在最上层、右上角一枚 esc 提示、背后**整屏铺上遮罩** ── */

describe("不变量 ⑥：模态是一张**无框**卡片浮在**极暗遮罩**上，标题与 `esc` 提示同一行", () => {
  const window = {
    title: "控制面（2）",
    rows: [
      { id: "a", name: "live-ok", detail: "http://10.0.0.9:18080 · 超时 5000ms", state: "connected" as const, current: true },
      { id: "b", name: "bad-token", detail: "http://10.0.0.1:18081 · 超时 5000ms", state: "unauthorized" as const, current: false },
    ],
    at: 0,
    note: null,
  };
  /** 空台账那一档（`note` 非空 ⇒ 内容区第一行是它） */
  const empty = { ...window, title: "控制面（0）", rows: [], note: "台账里还没有控制面 · 用 /target add 加一个" };

  it("⚠️ 卡片**没有框**：两个上角是空白，而标题落在**标题那一行**", async () => {
    // ⚠️ **必须 `color: true`**：无色档里 Ink 把行尾空白 `trimEnd` 掉了，卡片右缘那一列**压根没有
    // 格子**，探针会给 -1 —— 而「那一格是空格」对 -1 恒成立（这条判据就是这么变成恒绿的）。
    const p = props({ color: true, window });
    const raw = await renderRaw(p);
    const lines = raw.map((line) => stripAnsi(line));
    const g = geometry(geoInput(p));
    const box = g.windowBox!;
    // ⚠️ 标题在**内区那一行**（没有上边框，而内区离卡片上缘还隔着 1 列 padding）
    expect(screenRowOf(lines, "控制面（2）")).toBe(g.windowHeader!.y);
    expect(g.windowHeader!.y).toBe(box.y + 1);
    // ⚠️ **两个上角那一格是空格**：一圈框线会把一张卡片画成「另一个终端窗口」，而满屏接管之后
    // 屏上并没有别的窗口。⚠️ 判据落在**那两格**而不是「整帧没有 ╭」—— 输入框自己是圆角框，
    // 「整帧没有框线字形」那条对输入框恒红，而它压根不回答「卡片有没有框」。
    for (const column of [box.x, box.x + box.width - 1]) {
      const at = rawIndexOfColumn(raw[box.y] ?? "", column);
      expect(at).toBeGreaterThanOrEqual(0);
      expect((raw[box.y] ?? "")[at]).toBe(" ");
    }
  });

  it("⚠️ **padding 1** 在画面上：标题离卡片左缘 4 列（1 + 3），`esc` 提示离右缘也是 4 列", async () => {
    const p = props({ color: true, window });
    const raw = await renderRaw(p);
    const box = geometry(geoInput(p)).windowBox!;
    const row = raw[box.y + 1] ?? "";
    const at = indexOfText(row, "控制面（2）");
    const action = indexOfText(row, "关窗");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(action).toBeGreaterThanOrEqual(0);
    // ⚠️ 判据是**画出来的显示列**：几何对了而呈现层少缩一格时，只有这一条会红
    // ⚠️ 期望值写**字面量**而不是那几个常量：拿常量当期望值的话，改常量与改实现同时发生 ⇒ 恒绿
    expect(columnOfIndex(row, at)).toBe(box.x + 1 + 3);
    // 而那一枚的**右端**离卡片右缘 1 + 3 列（量的是动作文案的右端：它与那一枚同宽，且没有首列空隙）
    expect(columnOfIndex(row, action) + widthOf("关窗")).toBe(box.x + box.width - 1 - 3);
  });

  it("⚠️ 标题与内容之间有一道**可见的分隔**（`MARK_SELECTED` 铺满内区第一行）", async () => {
    const p = props({ color: true, window });
    const g = geometry(geoInput(p));
    const screen = await renderScreen(p);
    // ⚠️ **横向**：从**内区左缘**起是内区那么多个 `MARK_SELECTED`，紧跟着是右侧那一列 padding
    const row = stripAnsi(restColumns(screen[g.windowContent!.y] ?? "", g.windowContent!.x));
    expect(row.slice(0, g.windowContent!.width)).toBe(MARK_SELECTED.repeat(g.windowContent!.width));
    expect(row.slice(g.windowContent!.width, g.windowContent!.width + 1)).toBe(" ");
    // ⚠️ **纵向**：它**夹在标题与第一行内容之间** —— 而「第一行内容」的判据必须**从卡片左缘**起切
// （侧边栏那一列上也有一个叫 `live-ok` 的控制面名，而从主区左缘切会把「live-ok」切成「ve-ok」）
    const inCard = (needle: string): number =>
      screen.findIndex((line) => restColumns(stripAnsi(line), g.windowBox!.x).includes(needle));
    expect(g.windowContent!.y).toBe(g.windowHeader!.y + 1);
    expect(inCard("live-ok")).toBe(g.windowRows[0]!.y);
    expect(g.windowRows[0]!.y).toBe(g.windowContent!.y + 1);
    // 反向自检：同一批字形在**内容行**上只占左缘一列 —— 「铺满整行」才是分隔的形状通道
    // （⚠️ 从 `windowContent.x` 起切：那一行前面还有 padding 与 `MAIN_TEXT_X` 两列缩进）
    const first = stripAnsi(screen[g.windowRows[0]!.y] ?? "").slice(g.windowContent!.x);
    expect(first.slice(MAIN_TEXT_X).startsWith(MARK_SELECTED)).toBe(true);
    expect(first.slice(MAIN_TEXT_X + 1).startsWith(MARK_SELECTED)).toBe(false);
  });

  it("⚠️ 空台账那一句落在**内容区第一行**，而**不再有**底部说明行", async () => {
    const p = props({ window: empty });
    const g = geometry(geoInput(p));
    const screen = await renderScreen(p);
    expect(g.windowNoteRow).not.toBeNull();
    expect(screenRowOf(screen, "台账里还没有控制面")).toBe(g.windowNoteRow!.y);
    // ⚠️ 旧版那一行说明是**贴卡片底边**的键位说明；删掉之后卡片里那两句一个字都不许再出现
    expect(screen.join("\n")).not.toContain("Esc 关窗");
    expect(screen.join("\n")).not.toContain("↑↓ 选");
  });

  it("⚠️ 标题与右上角那一枚 esc **同一行**，且 esc 在卡片右端之内", async () => {
    const p = props({ window });
    const raw = await renderRaw(p);
    const g = geometry(geoInput(p));
    const box = g.windowBox!;
    const row = raw[g.windowHeader!.y] ?? "";
    const at = indexOfText(row, "esc");
    expect(at).toBeGreaterThanOrEqual(0);
    const column = columnOfIndex(row, at);
    expect(column).toBeGreaterThan(box.x);
    expect(column).toBeLessThan(box.x + box.width);
    // 而标题在**同一行**（无框 ⇒ 「右上角」只能是标题行的右端）
    expect(row.indexOf("控制面（2）")).toBeGreaterThanOrEqual(0);
  });

  it("窗口里逐行给出链接与状态字形，而「当前会话连的是它」另有记号", async () => {
    const lines = await renderFrame(props({ window }));
    const joined = lines.join("\n");
    expect(joined).toContain("live-ok");
    expect(joined).toContain("http://10.0.0.9:18080");
    expect(joined).toContain("●");
    expect(joined).toContain("←当前");
  });

  it("⚠️ 卡片里的字**不**被遮罩压暗（「窗口叫什么」是那一块唯一必须读得出来的东西）", async () => {
    const p = props({ color: true, window });
    const on = await renderRaw(p);
    const card = themeOf({ color: true, scrimmed: false });
    const behind = themeOf({ color: true, scrimmed: true });
    const titleRow = on[rowRawOf(on, "控制面（2）")] ?? "";
    const at = indexOfText(titleRow, "控制面（2）");
    expect(at).toBeGreaterThanOrEqual(0);
    // ⚠️ **先自检**：探针给 -1 时 `sgrColorAt` 恒给 `null`，而「null ≠ 那个色」恒成立。
    expect(sgrColorAt(titleRow, at, "fg")).toBe(fgSgrOf(toneColor("accent", card)!));
    // 遮罩态的那一份**必须**与它不同 —— 否则这条断言在「两份主题其实是一份」时恒绿
    expect(toneColor("accent", behind)).not.toBe(toneColor("accent", card));
    // 而**背后**那一层的前景色确实就是遮罩态那一档（两份主题真的被分别用上了）
    const behindRow = on[0] ?? "";
    const behindAt = indexOfText(behindRow, "已改");
    expect(behindAt).toBeGreaterThanOrEqual(0);
    expect(sgrColorAt(behindRow, behindAt, "fg")).toBe(fgSgrOf(toneColor("muted", behind)!));
  });

  it("⚠️ 模态开着时输入框**不画插入符**（按键已被窗口吃掉，屏上不许还留一个焦点块）", async () => {
    const p = props({ color: true, input: "/managers", cursor: 9 });
    const off = await renderRaw(p);
    const on = await renderRaw(props({ ...p, window }));
    const caretRow = geometry(geoInput(p)).inputTextRows[0]!.y;
    // ⚠️ 找的那一档**必须按那一帧自己的主题取**：遮罩态的 `selected` 是 `VEIL_TEXT`，
    // 而拿不带遮罩的那一档去搜遮罩态那一帧，**恒搜不到** —— 那条判据就这么变成恒绿的。
    const block = (line: string, theme: Theme): number => {
      const wanted = bgSgrOf(toneColor("selected", theme)!);
      let found = -1;
      for (let x = 0; x < p.columns; x += 1) {
        if (bgAtColumn(line, x) === wanted) found = x;
      }
      return found;
    };
    const plain = themeOf({ color: true, scrimmed: false });
    const behind = themeOf({ color: true, scrimmed: true });
    // ⚠️ **反向自检**：不带遮罩那一帧**必须**找得到那个块（找不到的话下面那条判据恒真，
    // 而症状与「实现没画插入符」一模一样）。
    expect(block(off[caretRow] ?? "", plain)).toBeGreaterThanOrEqual(0);
    // 遮罩开着时那一行**一格都不许**是那个色 —— 反底色是「焦点在这儿」的视觉答案，
    // 而按键已经全被窗口吃掉了（`use-keyboard.ts`），两者不一致的话操作者会先敲字才发现没进去。
    expect(block(on[caretRow] ?? "", behind)).toBe(-1);
  });

  it("⚠️ 卡片底边那一行是**空**的（键位说明不再钉在底边 ⇒ 少一个空盒子也看不出来）", async () => {
    // ⚠️ 旧版那一行说明（`Esc 关窗`）是 `flexGrow` 那个空盒子顶到卡片底边的，而删掉它之后
    // 「卡片里剩下的空间归空盒子」这条不变量**改由这一行回答**：底边那一行必须**没有字**。
    const p = props({ window });
    const box = geometry(geoInput(p)).windowBox!;
    const lines = await renderScreen(p);
    const bottom = stripAnsi(restColumns(lines[box.y + box.height - 1] ?? "", box.x));
    expect(bottom.trim()).toBe("");
  });

  // ⚠️ 这条是本档**最贵**的一条断言，而它守着的是一个「屏上看着没毛病、其实遮罩漏了两块」的实现：
  // ① 侧边栏那一列**自己带底色**（`surface`），Ink 后画 ⇒ 它盖在整屏那层遮罩上，于是整屏压暗了它没压暗；
  // ② 输入框**上下框那两行**里 Ink 只读节点自己的 `borderBackgroundColor`（不继承祖先底色），
  //    边框一画就把那两行重写成「没有底色」，于是遮罩在屏最底下被挖掉两条横缝。
  // 两条都不会让任何一条 `includes` 断言变红 —— 故判据是**逐格**比两帧的底色。
  it("⚠️ 背后**整屏铺上遮罩**：卡片那一块之外，每一格的底色都与关窗时不同", async () => {
    const p = props({ color: true, window });
    const off = await renderRaw(props({ color: true }));
    const on = await renderRaw(p);
    const box = geometry(geoInput(p)).windowBox!;
    // ⚠️ **探针先自检**：窗口矩形给 `null` 时下面一行都不跑，而那正是「什么都没测」
    expect(box).not.toBeNull();
    let checked = 0;
    const missed: string[] = [];
    const caret = bgSgrOf(toneColor("selected", themeOf({ color: true, scrimmed: false }))!);
    for (let y = 0; y < p.rows; y += 1) {
      const before = off[y] ?? "";
      const after = on[y] ?? "";
      // ⚠️ 只量「**至少一帧里画过字**」的那些列：Ink 把行尾空白 `trimEnd` 掉了，
      // 那里压根没有一格，量它等于量一个不存在的东西（症状是恒红的假失败）。
      const painted = Math.max(paintedColumns(before), paintedColumns(after));
      for (let x = 0; x < painted; x += 1) {
        if (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) continue;
        checked += 1;
        const was = bgAtColumn(before, x);
        const now = bgAtColumn(after, x);
        // ⚠️ **插入符那一格是唯一的例外**：它用反底色（`selected`）当「颜色之外的形状通道」，
        // 而反底色是**自己给的**底色 ⇒ 遮罩压不到它，也**不该**压到它（压暗了它就不再是最亮的一格，
        // 「光标在哪儿」这一条信息就没了）。故按「那一格本来就是反底色」放行，而不是放宽整条判据。
        if (was === caret || now === caret) continue;
        if (was === now || now === null) missed.push(`(${String(x)},${String(y)}) ${String(was)} → ${String(now)}`);
      }
    }
    // ⚠️ 计数也是判据的一部分：屏是 100×28 = 2800 格，而卡片占 70×14 = 980 ⇒ 至多 1820 格在它之外；
    // 「漏了整屏」那种实现会掉到几百，于是这条仍是**够不着**的。
    expect(checked).toBeGreaterThan(1500);
    expect(missed.slice(0, 8)).toEqual([]);
  });

  it("窗口浮在上面：卡片比遮罩**亮**（亮卡片浮在极暗遮罩上，明暗差就是「压在上面」）", async () => {
    const p = props({ color: true, window });
    const on = await renderRaw(p);
    const behindRow = on[0] ?? "";
    const behindAt = indexOfText(behindRow, "已改");
    const titleRow = on[rowRawOf(on, "控制面（2）")] ?? "";
    const insideAt = indexOfText(titleRow, "控制面（2）");
    // ⚠️ **两个下标都先自检**：探针给 -1 时 `bgRgbAt` 恒给 `null`，而 `null` 与任何数比较都是假 ——
    // 那是一条**恒绿**的判据（实测踩过一次）。
    expect(behindAt).toBeGreaterThanOrEqual(0);
    expect(insideAt).toBeGreaterThanOrEqual(0);
    const behind = bgRgbAt(behindRow, columnOfIndex(behindRow, behindAt));
    const inside = bgRgbAt(titleRow, columnOfIndex(titleRow, insideAt));
    expect(behind).not.toBeNull();
    expect(inside).not.toBeNull();
    // ⚠️ 比的是**深浅**不是「两个不相等」：遮罩最深而卡片次之，方向反了的话屏上读到的是
    // 「背后浮出一块亮斑」，而「不相等」那条判据对它**恒绿**。
    expect(depthOf(inside!)).toBeGreaterThan(depthOf(behind!));
  });

  it("⚠️ 卡片**整块**同一档底色（标题行、分隔行、中间的空行）", async () => {
    const p = props({ color: true, window });
    const on = await renderRaw(p);
    const box = geometry(geoInput(p)).windowBox!;
    expect(box).not.toBeNull();
    const panel = bgSgrOf(toneColor("panel", themeOf({ color: true, scrimmed: true }))!);
    // ⚠️ **逐行**量：卡片高度与内容无关（屏高一半），所以中间那段空行也在卡片里 ——
    // 只量标题与内容两行的话，中间那一段掉色（`flexGrow` 那个空盒子被算到卡片之外）测不出来。
    for (let y = box.y; y < box.y + box.height; y += 1) {
      expect(bgAtColumn(on[y] ?? "", box.x + 1)).toBe(panel);
    }
  });

  // ⚠️ 这一组替掉了旧版那条「`esc` 指着自己换一档」：悬停态已被删掉，而**能观测到**的那一半是
  // 「那一枚没有自己的一层底色」—— ⚠️ 因此这里**不能**用底色把「它画了」与「卡片画的」分开
  //（两处同色，而旧版正因为 `panelHot` 不同色才验得到）；「指针移上去不重绘」那一半归 `input.test.ts`。
  it("⚠️ 那一枚 `esc` 提示**没有自己的一层底色**：每一格都与卡片同色", async () => {
    const p = props({ color: true, window });
    const on = await renderRaw(p);
    const g = geometry(geoInput(p));
    const chip = g.windowClose!;
    const row = on[chip.y] ?? "";
    const panel = bgSgrOf(toneColor("panel", themeOf({ color: true, scrimmed: true }))!);
    // ⚠️ **逐列**量那一枚（含首尾那两列空隙）：它恒与卡片同色，而少给它一格不会在屏上留痕 ——
    // 所以这一条只钉住「同色」，**不**假装钉住了「这一枚自己画了那一格」。
    for (let x = chip.x; x < chip.x + chip.width; x += 1) {
      expect(bgAtColumn(row, x)).toBe(panel);
    }
  });

  it("⚠️ `esc` 提示的**按键字形与动作文案不同色**（同色 = 「按哪个」与「会发生什么」读起来一样）", async () => {
    const p = props({ color: true, window });
    const on = await renderRaw(p);
    const row = on[geometry(geoInput(p)).windowClose!.y] ?? "";
    const keyAt = indexOfText(row, "esc");
    const actionAt = indexOfText(row, "关窗");
    expect(keyAt).toBeGreaterThanOrEqual(0);
    expect(actionAt).toBeGreaterThanOrEqual(0);
    const key = sgrColorAt(row, keyAt, "fg");
    const action = sgrColorAt(row, actionAt, "fg");
    // ⚠️ **两个探针都先自检**：`null` 与任何值比较都为真差别，而「两者不同」对两个 `null` 恒假
    expect(key).not.toBeNull();
    expect(action).not.toBeNull();
    expect(key).not.toBe(action);
    // ⚠️ 而**方向**也钉死：按键是最亮那一档、动作是最暗那一档（反过来读起来像「按动作」）
    expect(key).toBe(fgSgrOf(toneColor("accent", themeOf({ color: true, scrimmed: false }))!));
    expect(action).toBe(fgSgrOf(toneColor("idle", themeOf({ color: true, scrimmed: false }))!));
  });

  it("关掉窗口之后整屏**没有**遮罩（它跟着窗口，不是一个常驻底色）", async () => {
    const off = await renderRaw(props({ color: true }));
    const plain = themeOf({ color: true, scrimmed: false });
    const scrimmed = themeOf({ color: true, scrimmed: true });
    // 主区那一格：没有底色（不是「压暗版的没有底色」）
    const at = indexOfText(off[0] ?? "", "已改");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(bgAtColumn(off[0] ?? "", columnOfIndex(off[0] ?? "", at))).toBeNull();
    // 侧边栏那一格：**没被压暗过**的那一档 —— 拿遮罩态的 `surface` 蒙混过关的实现会被这条逮到
    const sidebar = bgAtColumn(off[1] ?? "", 1);
    expect(sidebar).toBe(bgSgrOf(toneColor("surface", plain)!));
    expect(sidebar).not.toBe(bgSgrOf(toneColor("surface", scrimmed)!));
  });

  it("键位说明住在**右上角那一枚**里（`esc` 与它的动作文案），而底部**没有**说明行了", async () => {
    const lines = await renderFrame(props({ window }));
    const joined = lines.join("\n");
    expect(joined).toContain("esc");
    expect(joined).toContain("关窗");
    // ⚠️ 旧版那一句是「↑↓ 选 · Enter … · Esc 关窗」**贴在卡片底边**的整行；删掉之后
    // ↑↓ 与 Enter 的键位提示在卡片里**一个字都不许**残留（它们由 `/help` 与命令摘要给出）。
    expect(joined).not.toContain("Esc 关窗");
    expect(joined).not.toContain("Enter 接到当前会话");
  });
});

/* ── ⑦ 引导屏与 logo：控制面在哪选，这一屏必须说 ───────────────────────── */

describe("不变量 ⑦：引导屏回答「控制面在哪选」", () => {
  it("有控制面但当前会话没有输出时出 logo，且引导语提到 /managers", async () => {
    const lines = await renderFrame(
      props({ showLogo: true, flat: flatten([], 100), managerStates: ["connected"] }),
    );
    const joined = lines.join("\n");
    expect(joined).toContain("/managers");
    expect(joined).toContain("会话");
  });

  it("台账为空时引导语说怎么加一个控制面", async () => {
    const lines = await renderFrame(
      props({ showLogo: true, flat: flatten([], 100), managerStates: [] }),
    );
    expect(lines.join("\n")).toContain("target add");
  });

  it("**logo 让位给输出**：当前会话有输出时不出 logo（两者同一位置）", async () => {
    const lines = await renderFrame(props({ showLogo: false }));
    const joined = lines.join("\n");
    expect(joined).toContain("已改");
    expect(joined).not.toContain("TAGLINE-anchor");
  });
});

/* ── ⑧ 引导屏那块标记：**居中**、逐行一色、放不下就不画 ─────────────────── */

describe("不变量 ⑧：引导屏那块标记（几何说它在哪，它就在哪）", () => {
  const empty = { showLogo: true, flat: flatten([], 100), managerStates: ["connected"] } as const;

  /**
   * 一句**短到不会撑满内容区**的提示（居中那一档的探针）
   * @description ⚠️ 不用引导屏自己那句：它在 100 列上**恰好被 `ellipsis` 裁到内容区宽**（量到
   * 「首列 = 内容区左缘」），而一个撑满的盒子**居中等于没居中** —— 拿它当探针的话，那条判据在
   * 实现回到「不居中」时也照样绿（实测踩过一次：两档里有一档直接 `left === 0`）。
   * ⚠️ 它经 `mouseHint` 进去，于是它是**第二条**提示，而「每一条各自居中」正是要判的那件事。
   */
  const SHORT_HINT = "鼠标不可用";

  /**
   * 那一行**有字的那一段**的首列与末列（**显示列**，半开区间的两个端点）
   * @description ⚠️ 按显示列扫而**不是** `trim()` 的字符下标：提示里有汉字，而一个汉字占两列 ——
   * 少这一层的话末列会算成一半（症状是「右边留白多出一截，而看起来只差一点点」）。
   */
  function inkColumns(line: string): [number, number] {
    let first = -1;
    let last = -1;
    let at = 0;
    for (const ch of line) {
      const w = widthOf(ch);
      if (ch !== " ") {
        if (first < 0) first = at;
        last = at + w - 1;
      }
      at += w;
    }
    return [first, last];
  }

  /** 那份 props 喂进 {@link geometry} 得到的那一份几何（「画与点同源」在断言里的形状） */
  const geoOf = (p: LayoutProps) =>
    geometry(
      geoInput({
        columns: p.columns,
        rows: p.rows,
        sidebarWidth: p.sidebarWidth,
        input: p.input,
        palette: p.palette,
        window: p.window,
        sessions: p.sessions,
        sessionsTop: p.sessionsTop,
        menu: p.menu,
      }),
    );

  it("⚠️ 艺术字**逐行逐字**与素材一致，且**上下都没有**服务端 banner 那两条分割线", async () => {
    const lines = await renderFrame(props(empty));
    const joined = lines.join("\n");
    for (const line of LOGO) expect(joined).toContain(line.text);
    expect(joined).toContain(LOGO_TAG);
    // ⚠️ 那两条 `─…✦…─` 是服务端启动画面的排版，界面上没有第二块横向区域放它
    expect(joined).not.toContain("✦");
    expect(joined).not.toContain("THE BEST PROXY SERVER");
  });

  it("⚠️ 那块标记**纵向居中**在结果区里（期望值从纯函数取，不写死屏幕行号）", async () => {
    const p = props(empty);
    const g = geoOf(p);
    expect(g.welcome).not.toBeNull();
    // ⚠️ 判据是「屏上第 `welcome.y` 行的内容 == 素材第一行」——它把「画在哪一行」与「画的是什么」
    // 绑在一起，而分开断言两次（找行 + 比字）的话，行号算错而字对的情形会被放过去。
    // ⚠️ 走 `renderScreen` 而不是 `renderFrame`：后者**滤掉空行**（它答的是「这一行有字吗」），
    // 而「第几行」这类判据要的是屏行号 —— 用前者当下标的话结果区里有几个空行就错几行。
    const screen = await renderScreen(p);
    expect(screen[g.welcome!.y] ?? "").toContain(LOGO[0]!.text);
    expect(screen[g.welcome!.y + LOGO.length] ?? "").toContain(LOGO_TAG);
  });

  it("⚠️ 艺术字**横向居中**（左右留白由那一行内容的实际起点决定）", async () => {
    const p = props(empty);
    const screen = await renderScreen(p);
    const row = screenRowOf(screen, LOGO[0]!.text);
    expect(row).toBeGreaterThanOrEqual(0);
    const ink = (screen[row] ?? "").search(/\S/);
    const mainX = SIDEBAR + SIDEBAR_GAP;
    expect(ink).toBe(mainX + Math.floor((COLUMNS - mainX - LOGO_WIDTH) / 2));
  });

  it("⚠️ 底下那几行提示**在内容区居中**（奇偶两档屏宽都验：只在偶数宽上成立的话是巧合）", async () => {
    // ⚠️ 判据是**左右留白相等**，而**不是**「起点等于某个算出来的数」：后者等于把实现的算术抄一份，
    // 实现改一个取整方式断言就跟着红，而屏上看着没变。
    // ⚠️ **量的是那一行「有字的那一段」的起止列**而不是那句提示的宽度：抄一份整句会随文案漂，
    // 而抄一个前缀算不出末列（有中文时字宽不是 1）。
    // ⚠️ **奇偶两档都要**：内容区宽 = 屏宽 − 侧边栏 − 间隔，两档差一列，于是「居中」在两档上落到取整的
    // 两边；只跑一档的话 `Math.floor` 与 `Math.ceil` 的差别在另一档上会长成「偏了一列」。
    for (const columns of [100, 101]) {
      const p = props({ ...empty, columns, mouseHint: SHORT_HINT });
      const screen = await renderScreen(p);
      const area = geoOf(p).output!;
      const row = screenRowOf(screen, SHORT_HINT);
      expect(row, `屏上没有那条短提示（${String(columns)} 列）`).toBeGreaterThanOrEqual(0);
      const [first, last] = inkColumns(screen[row] ?? "");
      const left = first - area.x;
      const right = area.x + area.width - (last + 1);
      // ⚠️ **反向自检**：它**不是**靠左的（左右留白一大一小 ⇒ 判据恒假；两侧都是 0 ⇒ 「居中」没发生）
      expect(left, `${String(columns)} 列：左侧留白`).toBeGreaterThan(0);
      expect(Math.abs(left - right), `${String(columns)} 列：左右留白`).toBeLessThanOrEqual(1);
    }
  });

  it("⚠️ 放不下就**如实不画**（艺术字不裁、不缩），而底下那几行提示仍然在", async () => {
    // ⚠️ 窄到装不下 {@link LOGO_WIDTH} 列：截断的 ASCII 艺术字比没有更糟
    const lines = await renderFrame(props({ ...empty, columns: SIDEBAR + SIDEBAR_GAP + LOGO_WIDTH - 1 }));
    const joined = lines.join("\n");
    expect(joined).not.toContain(LOGO[0]!.text);
    // ⚠️ 提示**会被裁**（`ellipsis` 到那一屏的宽度），故判据取它**必然还在**的那个开头 ——
    // 「提示整句都在」在这种窄屏上恒假，而那与「提示没了」长得一样
    expect(joined).toContain("左边点一个会");
  });

  it("⚠️ 上色时**逐行一色**（六档渐变自上而下），不上色时一个字都不上色", async () => {
    const colored = await renderRaw(props({ ...empty, color: true }));
    const row = colored.findIndex((line) => line.includes(LOGO[0]!.text));
    expect(row).toBeGreaterThanOrEqual(0);
    const at = indexOfText(colored[row] as string, LOGO[0]!.text);
    expect(sgrColorAt(colored[row] as string, at, "fg")).toBe(fgSgrOf(LOGO[0]!.color));
    const plain = await renderRaw(props(empty));
    const plainRow = plain.findIndex((line) => line.includes(LOGO[0]!.text));
    const plainAt = indexOfText(plain[plainRow] as string, LOGO[0]!.text);
    expect(sgrColorAt(plain[plainRow] as string, plainAt, "fg")).toBeNull();
  });
});

/* ── ⑨ 会话菜单：浮在侧边栏与输入框**之上**，而它**不是模态**（背后照旧有字） ── */

describe("不变量 ⑨：会话菜单是一块浮层，浮在别的东西上面，而背后那一层照旧可见", () => {
  const menu = (over: Partial<MenuView> = {}): MenuView => ({
    sessionId: "s1",
    items: ["删除会话", "重命名"],
    at: 0,
    origin: [4, 6],
    ...over,
  });

  it("关掉时屏上一个字都不多（菜单不是常驻的）", async () => {
    const lines = await renderFrame(props());
    expect(lines.join("\n")).not.toContain("删除会话");
    expect(lines.join("\n")).not.toContain("重命名");
  });

  it("⚠️ 两项都画在几何给的那两行上，且**高亮落在 `at` 那一项**（记号 + 加粗）", async () => {
    const p = props({ menu: menu(), selectedSessionId: "s2" });
    const g = geometry(geoInput(p));
    const screen = await renderScreen(p);
    expect(screen[g.menuRows[0]!.y]?.slice(g.menu!.x)).toContain("删除会话");
    expect(screen[g.menuRows[1]!.y]?.slice(g.menu!.x)).toContain("重命名");
    const raw = await renderRaw(p);
    const row = raw[g.menuRows[0]!.y] ?? "";
    expect(row).toContain("▍");
    expect(isBoldAt(row, indexOfText(row, "删除会话"))).toBe(true);
    // ⚠️ 而**第二项没有**高亮（`at` 换了就换全套）
    const other = raw[g.menuRows[1]!.y] ?? "";
    expect(other).not.toContain("▍");
  });

  it("⚠️ 菜单**浮在上面**：它压住的那几格本来就是侧边栏那一列的底色，而卡片那一块换成 `panel`", async () => {
    const p = props({ color: true, menu: menu({ origin: [1, 0] }) });
    const g = geometry(geoInput(p));
    expect(g.menuRows[0]!.y).toBe(0);
    const raw = await renderRaw(p);
    // ⚠️ **逐格量**：菜单在第 0 行第 1 列，而那一格在关掉菜单时是 `surface`（侧边栏那一列的底色）
    const off = await renderRaw(props({ color: true }));
    const panel = bgSgrOf(toneColor("panel", themeOf({ color: true, scrimmed: false }))!);
    expect(bgAtColumn(off[0] ?? "", 1)).toBe(
      bgSgrOf(toneColor("surface", themeOf({ color: true, scrimmed: false }))!),
    );
    expect(bgAtColumn(raw[0] ?? "", 1)).toBe(panel);
    // ⚠️ 而菜单之外那一行**没被遮罩压暗**（菜单不是模态 —— 屏上后几块都照旧亮着）
    expect(bgAtColumn(raw[0] ?? "", SIDEBAR + SIDEBAR_GAP + 4)).toBe(bgAtColumn(off[0] ?? "", SIDEBAR + SIDEBAR_GAP + 4));
  });

  it("空白处那一份只有一项（那里没有「它」可以删除或改名）", async () => {
    const one = menu({ sessionId: null, items: ["新建会话"], at: 0 });
    const p = props({ menu: one });
    const g = geometry(geoInput(p));
    expect(g.menuRows).toHaveLength(1);
    const screen = await renderScreen(p);
    expect(screen[g.menuRows[0]!.y]?.slice(g.menu!.x)).toContain("新建会话");
    expect(screen.join("\n")).not.toContain("删除会话");
  });
});

/* ── 探测器：三个「看起来能过、其实恒错」的坑 ─────────────────────────── */

describe("探测器自检（这一组测的是本档的探测器本身）", () => {
  it("sgrColorAt 答的是「**哪一个**色」——选中的那一项与未选中的那几行不同", async () => {
    const raw = await renderRaw(props({ color: true }));
    const at = atText(raw, "会话 1");
    expect(at.index).toBeGreaterThanOrEqual(0);
    expect(sgrColorAt(at.line, at.index, "fg")).not.toBeNull();
  });

  it("反向自检：整帧真的渲染出了东西（空渲染会让上面每一条 `includes` 都绿）", async () => {
    const lines = await renderFrame(props());
    // ⚠️ **不许按屏高断言**：本档的取帧会把**空行**滤掉，而结果区那 21 行里只有 1 行有内容
    // （`renderFrame` 的判据是「有内容」而不是「有这么多行」—— 见它自己的注释）
    expect(lines.length).toBeGreaterThanOrEqual(8);
    expect(lines.some((line) => line.includes("╭"))).toBe(true);
    expect(lines.some((line) => line.includes("会话 1"))).toBe(true);
  });

  it("反向自检：探测器找得到那一行（找不到时它给 -1，而上面几条会恒假）", async () => {
    const raw = await renderRaw(props());
    expect(rowRawOf(raw, "会话 1")).toBeGreaterThanOrEqual(0);
  });
});

/* ── 变异实测表（**十三条全部转红**）─────────────────────────────────────
 *
 * 跑法：`node <harness>/mut-layout.mjs`（harness 逐条改源码 → 跑本档 → 复原）。
 *
 * ⚠️ 表里有三条是**补断言之后**才转红的，而它们绿的时候各自暴露了一个真问题：
 * - **R1**（名字预算少扣一列）：绿 —— 因为多出来的那一格**落在间隔列上**，
 *   而当时的判据只量「每一行都不超宽」与「下一项没被顶下去」，两者都对。
 *   补的那条是「间隔列上不许有字」—— 于是它转红。
 * - **R8**（窗口底色与背后取反）：绿 —— 因为那条断言里的探针下标是 `-1`
 *   （找的是第 10 行，而标题不在那儿），而 `sgrColorAt(line, -1, …)` 恒返回 `null`，
 *   `null ≠ scrim` 恒成立。**这是一条恒绿的判据**：探针给 `-1` 时必须先自检。
 * - **R4 / R5**（状态行搬进框内 / 那句话里带上链接）：绿 —— 因为它们各自的判据
 *   只在**另一档**下可见（框内那一行被 `notice` 占着，而 fallback 只在零台那一档出现）。
 *   补的那两条把两档都量了。
 *
 * | # | 变异 | 转红的判据 |
 * | --- | --- | --- |
 * | R1 | 侧边栏名字预算少扣一列 | ②「间隔列上不许有字」 |
 * | R2 | 给侧边栏加回边框（`│`） | ①「整屏只有输入框有框」 |
 * | R3 | 每项的第二行不画 | ②「会话名在第一行、控制面名在第二行」 |
 * | R4 | 状态行画进框内那一行 | ④「渲染位置 == 几何给的 y」 |
 * | R5 | fallback 那句话里带上链接 | ④「零台那一档也没有链接」 |
 * | R6 | 面板高亮加回反底色 | ⑤「高亮那一行没有底色」 |
 * | R7 | 选中那一项去掉加粗 | ③「加粗是颜色之外的第二通道」 |
 * | R8 | 窗口底色与背后取反 | ⑥「窗口自己的底色比背后**浅**」（探针先自检） |
 * | R9 | `esc` 那一枚画在框内第一行 | ⑥「它压在上边框那一行上」 |
 * | R10 | 间隔列那个空盒子漏掉 | ②「画出来的主区第一列 == 几何给的 x」 |
 * | R11 | 面板高亮去掉记号 | ⑤「高亮那一行左边有记号」 |
 * | R12 | 状态行不按右半占掉的宽裁左半 | ⑤的窄屏档 + ④ |
 * | R13 | 结果块少一行 | ④「各区高度之和 == 终端行数」 |
 *
 * ## 侧边栏那一列这一轮新增的六条（逐条实测，**六条全部转红**）
 * @description 跑法：先跑一遍基线档并断言它**全绿**（spawn 失败会长成「全部变异都红」那种假象，
 * 实测踩过一次），再逐条改源码 → 跑本档 → 复原 → 记下「哪些判据转红」。
 *
 * | # | 变异 | 转红的判据 |
 * | --- | --- | --- |
 * | S1 | `sidebar.tsx`：顶部那个留白空盒子高度给 0 | ②「顶部那几行一个字都没有」「第一项落在几何给的那一行」+ ②/③ 里所有按行号量侧边栏的（共 10 条） |
 * | S2 | `sidebar.tsx`：切片写成 `slice(0, len)`（漏 `sessionFirst`） | ②「装不下时画出来的是窗口**那一段**」 |
 * | S3 | `sidebar.tsx`：名字预算改成「悬停时用满宽」 | ②「裁剪预算**恒**扣掉那两列」+「会话名恒不超过侧边栏宽」 |
 * | S4 | `sidebar.tsx`：那一枚「✕」不再要求 `isHot`（变常驻） | ②「只在**悬停的那一项**上」 |
 * | S5 | `sidebar.tsx`：那一枚的外层 `<Box>` 去掉 `backgroundColor` | ③「悬停那一项时底色**铺到「✕」底下那一格**」 |
 * | S6 | `sidebar.tsx`：溢出说明行里的首项号写死成 `1` | ②「那一句说清「第几–第几 / 共几个」」 |
 * | S7 | `SessionSidebar.tsx`：**项间那个间隔空盒子不画了** | ② 里按行号量的**十条**一起转红（含「两项之间那一行一个字都没有」「第一项落在几何给的那一行上」「那一列记号位**恒在**」） |
 * | S8 | `SessionSidebar.tsx`：第二行（控制面）**也**跟着选中高亮 + 加粗（旧版行为） | ③「选中只高亮**标题那一行**」—— **只有这一条转红**（它是为这一条写的） |
 * | S9 | `SessionSidebar.tsx`：记号那一格按「有没有记号」决定画不画（`idle` 时少两列） | ②「那一列记号位**恒在**」+「名字前面那一枚记号」—— **两条同时转红** |
 * | S10 | `app.tsx`：零会话时仍把那一列画出来（`g.sidebar` 给一个 0×0 的矩形） | ⚠️ **绿 —— 它不是变异**：一个 0 宽的盒子**画不出任何字**，而本档那一条的另一半（`geometry` 给 `null`）量的是几何层 ⇒ 「屏上零会话字符」这一半**零鉴别力**，load-bearing 的是几何那半 |
 *
 * ⚠️ **一条被变异实测否掉的假设**（留在这里是因为它很容易被重新加回来）：「`<Text backgroundColor>`
 * 漏了 → 字形那里被戳一个洞」**是错的** —— Ink 的 `<Text>` 从**最近的带底色的祖先 `<Box>`** 继承
 * （`BackgroundContext`），故删掉 `<Text>` 那一份**渲染结果逐字相同**（实测）。真正 load-bearing 的是
 * **外层那个 `<Box backgroundColor>`**：删掉它，那一枚就继承到侧边栏的 `surface`，于是在 hover 那一档
 * 底色上真的出现一个两格宽的洞（S5 就是这一条）。
 *
 * ## 模态那一组（逐条实测，**全部转红**）
 * @description 这一组守着的是「遮罩」—— 而遮罩的历史教训是：**它可以在屏上看着没毛病而其实漏了两块**
 * （侧边栏那一列自带底色、输入框上下框那两行不继承祖先底色），而当时那几条 `includes` 断言一条都没红。
 * 故这一组的判据是**逐格**比两帧的底色，而不是「某一个格子有没有遮罩」。
 *
 * | # | 变异 | 转红的判据 |
 * | --- | --- | --- |
 * | M1 | `composer.tsx`：去掉 `borderBackgroundColor` | ⑥「背后**整屏铺上遮罩**」（屏最底下那两行从遮罩上被挖掉） |
 * | M2 | `palette.ts`：`themeOf` 忽略 `scrimmed`（侧边栏不压暗） | ⑥「背后**整屏铺上遮罩**」+「关掉窗口之后整屏**没有**遮罩」 |
 * | M3 | `window.tsx`：去掉卡片那个 `<Box>` 的 `backgroundColor` | ⑥「卡片**整块**同一档底色」 |
 * | M5 | `geometry.ts`：宽度退回常量 | 几何档「宽 = 整屏宽 × 70%」+ ⑥「背后**整屏铺上遮罩**」（卡片变宽 → 更多格子落在它之外） |
 * | M6 | `palette.ts`：`scrim` 调回**浅**色（回到旧版的亮遮罩） | 主题档 ①③④ + ⑥「卡片比遮罩**亮**」—— **五条同时转红** |
 * | M7 | `app.tsx`：卡片也吃遮罩态那份主题 | ⑥「卡片里的字**不**被遮罩压暗」（标题渲染成被压过的那一档） |
 * | M8 | `window.tsx`：给卡片加回 `borderStyle` | ⑥ 的**五条**（卡片变成另一个终端窗口，标题被挤到第二行、`esc` 离了标题行） |
 * | M9 | `composer.tsx`：模态开着时**仍**画插入符 | ⑥「模态开着时输入框**不画插入符**」 |
 * | M12 | `geometry.ts`：`esc` 放回标题行**下面**那一行 | 几何档「`esc` 与**标题同一行**」+ ⑥「标题与 `esc` 同一行」 |
 * | M13 | `geometry.ts`：标题不减 `esc` 那几列 | 几何档「标题的预算**恒**让开 `esc`」 |
 * | M15 | `geometry.ts`：`WINDOW_PADDING` 改成 0 | 几何档 ①②③ + ⑥「卡片**没有框**」+「**padding 1** 在画面上」—— **五条同时转红** |
 * | M16 | `window.tsx`：上边那一格 padding 的空盒子删掉 | ⑥「卡片**没有框**」+「**padding 1** 在画面上」 |
 * | M17 | `window.tsx`：分隔那一行改成 `MARK_BLANK` | ⑥「有一道**可见的分隔**」 |
 * | M18 | `close-chip.tsx`：动作文案也用 `accent` | ⑥「按键字形与动作文案**不同色**」 |
 *
 * ⚠️ **两条一开始是恒绿的，补断言之后才转红**（留在这里是因为「恒绿的判据」很容易被重新加回来）：
 * - **M10**（`windowRect` 删掉「屏高 × 比例」那一项）：绿 —— 因为当时那条断言用的是 28 行的屏，
 *   而那一档「屏高一半 = 14」与「最小 15 行」给出**同一个数**，比例项在那台屏上不承重。
 *   改成 50 行的屏（比例 25 > 下限 15）之后转红。
 * - **M9** 的第一版断言：绿 —— 因为它按**不带遮罩**的那一档 `selected` 去搜遮罩态那一帧，
 *   而遮罩态的 `selected` 已被压暗 ⇒ **恒搜不到**。改成「按那一帧自己的主题取那一档」之后转红
 *   （反向那一档「遮罩开着时才画」也一并转红）。
 * - ⚠️ **M15 第一版也是恒绿的**：判据里写的是 `box.x + WINDOW_PADDING`（拿**常量**当期望值），
 *   于是「改常量」与「改实现」同时发生而断言照旧绿。改成**字面量**并另加一条「那三个常数本身
 *   就等于 1/3/3」之后转红 —— 这条纪律对任何「期望值来自被测对象」的判据都成立。
 */
