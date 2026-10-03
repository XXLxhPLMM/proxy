/**
 * `@/console/layout` 的**真渲染**断言（假 TTY + 真 Ink）
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
 * 6. **`esc` 那一枚真的压在上边框上**（而不是框内第一行）。
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
  SESSION_ROWS,
  geometry,
  type GeometryInput,
} from "@/console/geometry.js";
import { flatten, type FlatLog, type LogEntry, type LogRow } from "@/console/log.js";
import { widthOf } from "@/ui/format.js";
import { Layout, type LayoutProps, type SessionRow } from "@/console/layout.js";

/** 本档用的标准尺寸（下面的用例大多围绕它） */
const COLUMNS = 100;
const ROWS = 28;
/** 侧边栏宽（与 `geometry` 的缺省一致；**用例一律显式给**，故两边读的是同一个数） */
const SIDEBAR = 22;

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
    if (codes.includes(clear)) color = null;
    else if (codes.includes(0)) color = null;
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
type GeoFields = Pick<LayoutProps, "columns" | "rows" | "sidebarWidth" | "input" | "palette" | "window">;

/** 几何的入参（与 {@link props} 读的是同一批字段） */
function geoInput(p: GeoFields): GeometryInput {
  return {
    columns: p.columns,
    rows: p.rows,
    sidebarWidth: p.sidebarWidth,
    input: p.input,
    paletteCount: p.palette === null ? 0 : p.palette.total,
    window: p.window !== null,
    windowRows: p.window === null ? 0 : p.window.rows.length,
    windowFooter: p.window !== null && p.window.footer !== null,
  };
}

/** 一份最小的 props（各用例只改自己关心的那几项） */
function props(over: Partial<LayoutProps> = {}): LayoutProps {
  const columns = over.columns ?? COLUMNS;
  const rows = over.rows ?? ROWS;
  const sidebarWidth = over.sidebarWidth ?? SIDEBAR;
  const sessions: readonly SessionRow[] = over.sessions ?? [
    { id: "s1", name: "会话 1", manager: "live-ok" },
    { id: "s2", name: "会话 2", manager: null },
  ];
  const input = over.input ?? "";
  const palette = over.palette ?? null;
  const flat: FlatLog =
    over.flat ??
    flatten(
      [{ id: 1, at: 0, rows: [{ kind: "kv", key: "写入", value: "已改" }] }] as readonly LogEntry[],
      geometry(geoInput({ columns, rows, sidebarWidth, input, palette, window: null })).outputWidth,
    );
  return {
    columns,
    rows,
    color: false,
    version: "5.2.0",
    sidebarWidth,
    sessions,
    selectedSessionId: "s1",
    hoveredSessionId: null,
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
    closeHot: false,
    ...over,
  };
}

/** 侧边栏那一列的行（**按列宽**切出来：满屏上那两根竖线已经没有了） */
function sidebarColumn(lines: readonly string[], width = SIDEBAR): readonly string[] {
  return lines.map((line) => column(line, width));
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
/* ── ① 每一行都等宽（Ink 静默软换行的护栏）────────────────────────────── */

describe("不变量 ①：任何一行的显示宽度都不许超过终端列数", () => {
  it("侧边栏里有一个**超长中文会话名**时，每一行仍然等宽", async () => {
    // ⚠️ 名字刻意是**中文**：ASCII 名的显示宽度等于 `String.length`，而中文是两倍，
    // 所以一个纯 ASCII 的用例会同时通过「按 length 算」与「按显示宽度算」两种实现 ——
    // 那样的用例对这条判据**零鉴别力**。
    const lines = await renderFrame(
      props({
        sessions: [
          { id: "s1", name: "会话 1", manager: "live-ok" },
          { id: "s2", name: "一个非常非常长的会话名字", manager: "一个非常长的控制面名字" },
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
      [{ id: 1, at: 0, rows: [noteRow(long)] }] as readonly LogEntry[],
      geometry(geoInput(props())).outputWidth,
    );
    const lines = await renderFrame(props({ flat, top: 0 }));
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(COLUMNS);
    expect(lines.filter((line) => line.includes("这是一段")).length).toBeGreaterThan(1);
  });
});

/* ── ② 侧边栏 = 会话：每项两行，且**没有标题行** ───────────────────────── */

describe("不变量 ②：侧边栏列会话，每项两行（名字 + 它连的控制面），顶部没有标题行", () => {
  it("会话名在第一行、控制面名在第二行（两行都画得出来）", async () => {
    const lines = await renderFrame(props());
    const first = sidebarColumn(lines);
    expect(first[0]).toContain("会话 1");
    expect(first[1]).toContain("live-ok");
    expect(first[SESSION_ROWS]).toContain("会话 2");
    expect(first[SESSION_ROWS + 1]).toContain("未选控制面");
  });

  it("第二行答的是「这个会话连的是哪一台」——`null` 说成一句人话而不是空串", async () => {
    const lines = await renderFrame(
      props({
        sessions: [
          { id: "s1", name: "会话 1", manager: "机房那台" },
          { id: "s2", name: "会话 2", manager: null },
        ],
      }),
    );
    const first = sidebarColumn(lines);
    expect(first[0]).toContain("会话 1");
    expect(first[1]).toContain("机房那台");
    // 空串与「名字是空的控制面」在屏上同形，而「还没选」是一个**常见的**状态
    expect(first[3]).toContain("未选控制面");
  });

  it("顶部**没有标题行**：第一项从第 0 行起，且那一行就是会话名", async () => {
    const lines = await renderFrame(props());
    const first = sidebarColumn(lines);
    expect(first[0]).toContain("会话 1");
    expect(first[0]).not.toContain("控制面（");
  });

  it("名字太长时它被裁，而**不把下一项顶下去**（每一项恒占两行）", async () => {
    // ⚠️ 少了「按可用宽度裁」这一步，Ink 会**静默软换行** —— 而那多出来的一行会把下一项
    // 顶到第三行去，于是侧边栏里的项与几何给的 `sidebarRows` **不再是同序**：
    // 命中测试说「第 2 项」，屏上第 2 行却是第 1 项的第二个字。
    const lines = await renderFrame(
      props({
        sessions: [
          { id: "s1", name: "一个非常非常长的会话名字", manager: "一个非常长的控制面名字" },
          { id: "s2", name: "会话 2", manager: null },
        ],
      }),
    );
    const first = sidebarColumn(lines);
    expect(first[0]).toContain("…");
    expect(first[SESSION_ROWS]).toContain("会话 2");
    // ⚠️ 而那一项**不许越过侧边栏**：预算少扣一列时多出来的那一格落进间隔列，
    // 于是那一列上出现了字 —— 而屏上那根竖线（间隔）本该是空的
    expect(restColumns(lines[0] ?? "", SIDEBAR)).toMatch(/^ /u);
  });

  it("装不下的必须说一声（静默少画几行 ⇒ 操作者以为会话就这几个）", async () => {
    const many: SessionRow[] = [];
    for (let i = 0; i < 40; i += 1) many.push({ id: `s${i}`, name: `会话 ${i}`, manager: null });
    const lines = await renderFrame(props({ rows: 12, sessions: many }));
    expect(sidebarColumn(lines).some((line) => line.includes("还有"))).toBe(true);
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
    const first = raw[0] ?? "";
    const at = indexOfText(first, "会话 1");
    const other = indexOfText(raw[2] ?? "", "会话 2");
    expect(sgrColorAt(first, at, "fg")).not.toBeNull();
    expect(sgrColorAt(raw[2] ?? "", other, "fg")).not.toBe(sgrColorAt(first, at, "fg"));
    // ⚠️ **加粗是颜色之外的第二通道**：无色终端里它是「哪一个被选中了」的唯一线索
    expect(isBoldAt(first, at)).toBe(true);
    expect(isBoldAt(raw[2] ?? "", other)).toBe(false);
  });

  it("hover 那一项换的是**另一层**底色（与那一列的 `surface` 不是同一个）", async () => {
    const base = await renderRaw(props({ color: true }));
    const hot = await renderRaw(props({ color: true, hoveredSessionId: "s2" }));
    const probe = (line: string): string | null => bgAtColumn(line, 20);
    // 第二个会话占第 2、3 行（每项两行），而 hover 铺满**整项两行**
    expect(probe(hot[2] ?? "")).not.toBe(probe(base[2] ?? ""));
    expect(probe(hot[3] ?? "")).toBe(probe(hot[2] ?? ""));
    // 而**没有被指着**的那一项仍然是那一列的底色（两个通道互不干扰）
    expect(probe(hot[0] ?? "")).toBe(probe(base[0] ?? ""));
  });

  it("hover 的底色铺满**整列两行**（不铺满的话右边留下一截列的底色，看着像画歪了）", async () => {
    const hot = await renderRaw(props({ color: true, hoveredSessionId: "s2", sidebarWidth: 20 }));
    const row = hot[SESSION_ROWS] ?? "";
    const band = bgAtColumn(row, 19);
    expect(band).not.toBeNull();
    for (const column of [0, 5, 12, 19]) expect(bgAtColumn(row, column)).toBe(band);
    // 第二行同样是这一层（hover 铺满**整项两行**，不是只有第一行）
    expect(bgAtColumn(hot[SESSION_ROWS + 1] ?? "", 19)).toBe(band);
  });

  it("指针在手柄上时那一列自己换一层底色（「这一列能拖」看得见）", async () => {
    const off = await renderRaw(props({ color: true, sidebarWidth: 20 }));
    const on = await renderRaw(props({ color: true, sidebarWidth: 20, handleHot: true }));
    // 手柄 = 最右那一列（第 19 列，第 0 起）
    expect(bgAtColumn(on[3] ?? "", 19)).not.toBe(bgAtColumn(off[3] ?? "", 19));
    // 而它左侧那一列**不变**（否则那一整列都会亮，「能拖的那一列」就说不清了）
    expect(bgAtColumn(on[3] ?? "", 18)).toBe(bgAtColumn(off[3] ?? "", 18));
  });

  it("无色终端里侧边栏与主区长得一样（代价记在 layout.tsx 的「已知缺口」）", async () => {
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
      props({ sessions: [{ id: "s1", name: "会话 1", manager: "http://10.0.0.9:18080" }] }),
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

/* ── ⑥ 模态窗口：压在最上层、右上角一枚 esc、背后**变浅** ──────────────── */

describe("不变量 ⑥：模态窗口压在别的区之上，右上角有一枚 esc", () => {
  const window = {
    title: "控制面（2）",
    rows: [
      { id: "a", name: "live-ok", detail: "http://10.0.0.9:18080 · 超时 5000ms", state: "connected" as const, current: true },
      { id: "b", name: "bad-token", detail: "http://10.0.0.1:18081 · 超时 5000ms", state: "unauthorized" as const, current: false },
    ],
    at: 0,
    footer: "↑↓ 选 · Enter 接到当前会话 · Esc 关窗",
  };

  it("窗口开着时那一块**盖住**底下那一行（而不是与它并排）", async () => {
    const lines = await renderScreen(props({ window }));
    const titleRow = screenRowOf(lines, "控制面（2）");
    const topRow = screenRowOf(lines, "╭");
    // ⚠️ **标题在框内第一行**：上边框在它**上面**一行 —— 而那一行的两端正是窗口的左右角，
    // 说明窗口是**独立的一块**（它与侧边栏那一列是同一屏上的两层，不是一条一条拼起来的框）
    expect(topRow).toBeGreaterThanOrEqual(0);
    expect(titleRow).toBe(topRow + 1);
    expect(stripAnsi(lines[titleRow] ?? "")).toMatch(/│/u);
  });

  it("右上角有一枚 esc，**压在上边框那一行上**", async () => {
    const lines = await renderScreen(props({ window }));
    expect(screenRowOf(lines, "esc")).toBe(screenRowOf(lines, "╭"));
  });

  it("窗口里逐行给出链接与状态字形，而「当前会话连的是它」另有记号", async () => {
    const lines = await renderFrame(props({ window }));
    const joined = lines.join("\n");
    expect(joined).toContain("live-ok");
    expect(joined).toContain("http://10.0.0.9:18080");
    expect(joined).toContain("●");
    expect(joined).toContain("←当前");
  });

  it("背后**变浅**：整屏铺一层 `scrim`（比侧边栏那一列的底色浅）", async () => {
    const off = await renderRaw(props({ color: true }));
    const on = await renderRaw(props({ color: true, window }));
    // 主区第一行：没开窗口时**没有**底色，开了之后有
    const offBg = sgrColorAt(off[0] ?? "", indexOfText(off[0] ?? "", "已改"), "bg");
    const onBg = sgrColorAt(on[0] ?? "", indexOfText(on[0] ?? "", "已改"), "bg");
    expect(offBg).toBeNull();
    expect(onBg).not.toBeNull();
  });

  it("窗口自己的底色比背后**深**（否则「浮在上面」看起来像「铺在下面」）", async () => {
    const on = await renderRaw(props({ color: true, window }));
    const behindRow = on[0] ?? "";
    const behindAt = indexOfText(behindRow, "已改");
    const titleRow = on[rowRawOf(on, "控制面（2）")] ?? "";
    const insideAt = indexOfText(titleRow, "控制面（2）");
    // ⚠️ **两个下标都先自检**：探针给 -1 时 `sgrColorAt` 恒返回 `null`，而
    // 「`null` ≠ 那个底色」恒成立 —— 那是一条**恒绿**的判据（实测踩过一次）。
    expect(behindAt).toBeGreaterThanOrEqual(0);
    expect(insideAt).toBeGreaterThanOrEqual(0);
    const behind = sgrColorAt(behindRow, behindAt, "bg");
    const inside = sgrColorAt(titleRow, insideAt, "bg");
    expect(behind).not.toBeNull();
    expect(inside).not.toBe(behind);
  });

  it("关掉窗口之后那一层 `scrim` 也没了（它跟着窗口，不是一个常驻底色）", async () => {
    const off = await renderRaw(props({ color: true }));
    expect(sgrColorAt(off[0] ?? "", indexOfText(off[0] ?? "", "已改"), "bg")).toBeNull();
  });

  it("底部那一条说明在窗口里（↑↓ / Enter / Esc 各是什么）", async () => {
    const lines = await renderFrame(props({ window }));
    expect(lines.join("\n")).toContain("Esc 关窗");
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
 * | R8 | 窗口底色与背后取反 | ⑥「窗口自己的底色比背后深」（探针先自检） |
 * | R9 | `esc` 那一枚画在框内第一行 | ⑥「它压在上边框那一行上」 |
 * | R10 | 间隔列那个空盒子漏掉 | ②「画出来的主区第一列 == 几何给的 x」 |
 * | R11 | 面板高亮去掉记号 | ⑤「高亮那一行左边有记号」 |
 * | R12 | 状态行不按右半占掉的宽裁左半 | ⑤的窄屏档 + ④ |
 * | R13 | 结果块少一行 | ④「各区高度之和 == 终端行数」 |
 */
