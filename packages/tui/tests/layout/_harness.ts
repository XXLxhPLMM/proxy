/**
 * 本目录各档共用的**造帧那一半**：真 `render()` 一次，再把那一帧变成三种可下标的取法，
 * 外加喂 `@/app` 的那份最小 props 与几格样本。
 *
 * ⚠️ **本模块是全目录唯一 import `ink` 的地方**，而「`FORCE_COLOR` 必须在 ink（因而 chalk）被 import
 * 之前设好」那一句**刻意不在这里**：`vi.hoisted` 只在**入口模块**里被提升到 import 之前，放进一个被
 * import 的模块它就是一句普通调用 ⇒ 跑在 ink 之后、chalk 的 level 已经是 0、Ink 一个转义序列都不生成，
 * 而症状不是「测试红」而是**十几条着色判据一起红**（`sgrColorAt` 恒给 `null`）。
 * 故每一档自带那一句（与 `tests/input/` 同一形状），理由归本目录 `AGENTS.md`。
 *
 * ⚠️ **每次取帧各起各的流**（`fakeStdout()` 是工厂而不是单例）：共用一条流的话两帧会互相追加，
 * 而症状是「比较两帧的那几条断言偶尔读到上一帧的尾巴」。
 *
 * ⚠️ **收件门槛是「两个以上档真用到」**：只被一档用到的东西留在那一档里 ——
 * 搬进来就成了一份没人能单独删掉、也没人说得清谁在用的间接层。
 *
 * @module tests/layout
 */

import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement } from "react";
import {
  SESSION_STRIDE,
  SIDEBAR_TOP_PAD_ROWS,
  geometry,
  type GeometryInput,
} from "@/lib/geometry.js";
import { flatten, type FlatLog, type LogEntry, type LogRow, type Turn } from "@/lib/log/index.js";
import { slotsOf } from "@/components/index.js";
import { Layout, type LayoutProps, type SessionRow } from "@/app.js";

/** 本档用的标准尺寸（下面的用例大多围绕它） */
export const COLUMNS = 100;
const ROWS = 28;
/** 侧边栏宽（与 `geometry` 的缺省一致；**用例一律显式给**，故两边读的是同一个数） */
export const SIDEBAR = 32;

/**
 * 夹具里的版本串（⚠️ **刻意不是真实版本号**，且显示宽度与任何 `x.y.z` 相同 ⇒ 状态行右半的宽度预算
 * 与真实版本号那一档逐列相同）
 * @description
 * `version` 只是从 `LayoutProps` 灌进去的一个字符串，而这一族判的是**排版**（右半印不印得下、左半
 * 裁得对不对）。故它取一个**永不腐烂**的值：钉一个真实版本号的话，每次抬版本都得记得回来改它，
 * 而改漏了就是一次假绿（症状不是「断言红」，而是「判据悄悄变成了另一个字符串」）。
 * ⚠️ 而断言仍用 `v` + 本常量拼出来（**不许**改成「等于包版本」）：屏上那个版本号的真相源是
 * `build.mjs` 读进来的那一份，包清单一改它就跟着变，而**这一档要锁的是「印出来了」**这件事。
 */
export const FIXTURE_VERSION = "9.9.9";

/**
 * 一个假的会话行（**每一格都齐** —— `seen` 与 `run` 是两件「记得看没看」与「跑没跑完」，
 * 合成一格的话切回来看一眼就把「跑完了」一起清了；缺了这一格 `@/app` 的那一段压根编不过，
 * 而症状是「喂了半个会话」而不是一条响亮的红）
 */
export function sessionRow(over: Partial<SessionRow> = {}): SessionRow {
  return { id: "s1", name: "会话 1", manager: null, run: "idle", seen: true, ...over };
}

/**
 * 第 `index` 项的**名字那一行**的屏行号（顶部那 {@link SIDEBAR_TOP_PAD_ROWS} 行 + 步长 {@link SESSION_STRIDE}）
 */
// ⚠️ 顶部那几行**必须算进去**：写死行号的后果是「几何一改、量的是上面那一行空白」而断言照旧绿。
export const ITEM_ROW = (index: number): number => SIDEBAR_TOP_PAD_ROWS + index * SESSION_STRIDE;

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
export async function renderFrame(props: LayoutProps): Promise<readonly string[]> {
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
export async function renderScreen(props: LayoutProps): Promise<readonly string[]> {
  const raw = await renderRaw(props);
  return raw.map((line) => stripAnsi(line));
}

/**
 * 真渲染一次，返回**带 ANSI 的原始帧**（着色那几组断言要读 SGR）
 * @description ⚠️ 与 {@link renderFrame} 只差「不剥 ANSI」：剥了之后 {@link sgrColorAt} 拿到的
 * 下标与原串对不上，而症状是「断言永远为假」—— 与「实现错了」长得一模一样（实测踩过一次）。
 */
export async function renderRaw(props: LayoutProps): Promise<readonly string[]> {
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
export function stripAnsi(text: string): string {
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
  | "view"
  | "rename"
  | "sessions"
  | "sessionsTop"
  | "menu"
>;

/** 几何的入参（与 {@link props} 读的是同一批字段） */
export function geoInput(p: GeoFields): GeometryInput {
  return {
    columns: p.columns,
    rows: p.rows,
    sidebarWidth: p.sidebarWidth,
    sessionCount: p.sessions.length,
    sessionsTop: p.sessionsTop,
    input: p.input,
    paletteCount: p.palette === null ? 0 : p.palette.total,
    // ⚠️ **槽位是现算的那一串**（与 `@/app.tsx` 读的是**同一个**函数）：喂 `true` 这类错形状的话
    // `geometry` 不抛（`true.length` 是 `undefined`），破口表现为「断言空解引用」而不是一炸就响 ——
    // 故这条入参形状由 `probes.test.ts` 自检。
    // ⚠️ **两个入参**：改名框那一格属于 `rename` 而不属于 `view`，少给一个就少一槽
    // （而症状是「改名框画在内容区之外」）。
    window: slotsOf(p.view, p.rename),
    windowCloseHint: p.view?.closeHint ?? true,
    menu:
      p.menu === null
        ? null
        : { x: p.menu.origin[0], y: p.menu.origin[1], items: p.menu.items },
  };
}

/** 一份最小的 props（各用例只改自己关心的那几项） */
export function props(over: Partial<LayoutProps> = {}): LayoutProps {
  const columns = over.columns ?? COLUMNS;
  const rows = over.rows ?? ROWS;
  const sidebarWidth = over.sidebarWidth ?? SIDEBAR;
  const sessions: readonly SessionRow[] = over.sessions ?? [
    { id: "s1", name: "会话 1", manager: "live-ok", run: "idle", seen: true },
    { id: "s2", name: "会话 2", manager: null, run: "idle", seen: true },
  ];
  const input = over.input ?? "";
  const palette = over.palette ?? null;
  const sessionsTop = over.sessionsTop ?? 0;
  const menu = over.menu ?? null;
  const flat: FlatLog =
    over.flat ??
    flatten(
      [entryOf([{ kind: "kv", key: "写入", value: "已改" }])],
      geometry(
        geoInput({
          columns,
          rows,
          sidebarWidth,
          input,
          palette,
          view: null,
          rename: null,
          sessions,
          sessionsTop,
          menu,
        }),
      ).outputWidth,
    );
  return {
    columns,
    rows,
    color: false,
    version: FIXTURE_VERSION,
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
    inputSelection: null,
    modelStatus: { provider: null, reasoning: "medium" },
    ghost: null,
    notice: null,
    palette,
    mouseHint: null,
    showLogo: false,
    droppedHint: null,
    view: null,
    rename: null,
    menu,
    ...over,
  };
}

/** 一行日志（造结果区内容用） */
export function noteRow(text: string): LogRow {
  return { kind: "note", text };
}

/** 一格「工具结果」（⚠️ 结果区那一格装的是 `Turn` 而**不是** `LogRow` —— 见 `@/lib/log/turn.js`） */
function toolTurn(rows: readonly LogRow[]): Turn {
  return { kind: "tool-result", rows };
}

/** 一格输出（造结果区内容用；`id` 从 1 起，理由见 `@/lib/log/rows.ts:append`） */
export function entryOf(rows: readonly LogRow[]): LogEntry {
  return { id: 1, at: 0, turns: [toolTurn(rows)] };
}
