/**
 * 本文件夹各档共用的那圈东西：造一次挂载（假 TTY + 真 `App` + 真 `MouseSource`）、造台账、
 * 坐标换算、以及 ANSI 与字节的读法
 * @description ⚠️ 各档按同一套挂载造屏面，而**坐标一律从 `@/lib/geometry` 算** ——
 * 写死屏幕行号的后果是「几何一改、点就点空了而断言照旧绿」。共用不变量见 `AGENTS.md`。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement } from "react";

import { App } from "@/AppState.js";
import { widthOf } from "@/lib/format.js";
import { createMouseSource, type MouseEvent } from "@/services/terminal/mouse.js";
import { pinSession, saveSession, writeLedger } from "@/services/config/index.js";
import { COMMAND_SPECS } from "@/commands/parse.js";
import { geometry, SIDEBAR_WIDTH, type GeometryInput, type WindowSlot } from "@/lib/geometry.js";

export const COLUMNS = 100;
export const ROWS = 28;

/** 探活窗口要一个**不动的**时刻源，否则「最近收到过报告」会随墙钟乱跳 */
const NOW = 1_700_000_000_000;

/** 一个空台账的路径（`readLedger` 对**不存在**的库返回空台账，故这里不必先建库） */
export function emptyLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "swain-tui-input-")), "tui.db");
}

/**
 * 一个**有目标**的台账（hover 那几条要有一行可指，故不能拿空台账）
 * @description ⚠️ 端点指向一个**不存在的**端口：探活会失败，而那一格正好是「未知」——
 * hover 与连接状态是**两件独立的事**，不该被探活的结果连坐（`tests/layout/selection.test.ts` 那几条
 * 直接给 `state`，而这里走的是真台账 + 真探活）。
 */
function seededLedgerPath(): string {
  const file = join(mkdtempSync(join(tmpdir(), "swain-tui-input-")), "tui.db");
  writeLedger(file, {
    version: 1,
    selected: "live-ok",
    targets: [
      {
        id: "live-ok",
        name: "live-ok",
        baseUrl: "http://127.0.0.1:1",
        token: "t0ken",
        timeoutMs: 200,
      },
    ],
  });
  return file;
}

/** 假 TTY：Ink 只要求 `isTTY` / `columns` / `rows` / `write` */
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

/** 假 TTY 输入；⚠️ **`setEncoding` 刻意不接管**（PassThrough 自带那个就够用，见 {@link mount}） */
function fakeStdin(): PassThrough & { isTTY: boolean } {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean };
  stream.isTTY = true;
  return stream;
}

/** 一次挂好的界面（几个用例族共用，故只有一处「怎么造假 TTY」） */
export interface Mounted {
  readonly stdin: PassThrough & { isTTY: boolean };
  readonly mouseEvents: MouseEvent[];
  /** 截至此刻写进 stdout 的字节总数 */
  readonly bytes: () => number;
  /**
   * 截至此刻写进 stdout 的**原文**
   * @description ⚠️ 只有 `interactive: true` 的挂载中途有意义：`interactive: false` 那一档
   * Ink 只在 `unmount()` 时写一次，中途读到的永远是空串。需要「同一挂载里前后两帧」时用它，
   * 而不是起两次挂载 —— 后者的两次挂载时机不同，于是「两次都读到同一帧」这件事里混着
   * 「两次的挂载时序不同」这个与被测行为无关的变量。
   */
  readonly snapshot: () => string;
  readonly feed: (chunks: readonly string[]) => Promise<void>;
  /** 「退出」被请求过几次（⚠️ 默认那个替身上计数，而 `/exit` 的判据就是它） */
  readonly exits: () => number;
  /**
   * 终端改大小（**先改流上的字段，再发 `resize`** —— 顺序反了的话读到的是改之前的尺寸）
   * @description ⚠️ 那两个数**可以是 `undefined`**：`columns` / `rows` 本来就是 `tty.WriteStream`
   * 才有的字段，故「事件到了而字段没有」这个组合要能造 —— 应用必须**回到组合根那份快照**
   * （判据在 `@/hooks/useTerminalSize.ts`）。
   */
  readonly resize: (columns: number | undefined, rows: number | undefined) => Promise<void>;
  /**
   * 喂键并**等它真的排出一帧**（⚠️ 只有「这一键必定改变屏面」的那一族用得着，零输出的那一族不行）
   * @description 见 {@link settleRendered}：固定下限抢在重排之前就是「闪的测试」的成因。
   */
  readonly feedRendered: (chunks: readonly string[]) => Promise<void>;
  /** 收尾；**只在 `interactive: false` 时**返回屏上那一帧的原文 */
  readonly finish: () => Promise<string>;
}

/**
 * 等屏面**稳定下来**：输出连续 3 个 5ms 刻度都没变，且至少等过 40ms。
 *
 * @description ⚠️ 为什么不是固定 sleep：这一份假 TTY 原来每个 chunk 硬等 30ms。那在
 * 「一个主题一份档」时够用，而档数变多、并发变高之后**偶发不够** —— `/new` → Enter → 点击
 * 要连着过三道 React 渲染，30ms 里少一道就会读到上一帧（实测「两项之间那一行点不动」那条
 * 在未拆分的单档上就是 7 次红 4次，与拆分无关；拆分只是把并发抬上去）。
 * ⚠️ 等稳定是**自校准**的：机器慢就多等，机器快就少等。
 * ⚠️ 而下限 40ms **不许去掉**：门禁生效时那些 chunk 本来就一个字都不写（那正是下面几条
 * 零字节判据的依据），所以只能等「不再变」，不能等「变过」—— 后者在零输出时立刻返回。
 * ⚠️ **必须带 max elapsed 兜底（2s）**：这个循环等的是一个「不再变」的**否定**事实，
 * 而否定事实没有天然的终止保证 —— 只要 stdout 每 5ms 都在长，`stable` 就永远回不到 3。
 * 今天 `src/` 零 `setInterval`（唯一定时器是 8 秒的 `setTimeout`）所以碰不到，但**碰不到
 * 不等于不会发生**：一旦有人挂上常驻重绘，失败形态会变成「整档 89 条一起超时」，
 * 而超时栈指向 `settle` 而不是那个重绘 —— **指错了地方**。超时后照常返回，让后续断言去红。
 */
async function settle(read: () => string, minMs = 40): Promise<void> {
  const STEP_MS = 5;
  const STABLE_TICKS = 3;
  const MAX_WAIT_MS = 2000;
  const started = Date.now();
  let previous = read();
  let stable = 0;
  // ⚠️ **每轮重新读**：`read` 必须是个读取器而不是一个字符串快照 —— 传快照的话
  // `now.length === previous.length` 恒真，于是每次都在下限那一档立刻返回，等于
  // 把「等稳定」悄悄退化成「等一个比原来还短的固定 sleep」（实测 80 条一起红）。
  while (Date.now() - started < minMs || stable < STABLE_TICKS) {
    if (Date.now() - started > MAX_WAIT_MS) break;   // 挂死兜底，见文件头
    await new Promise((resolve) => setTimeout(resolve, STEP_MS));
    const now = read();
    stable = now.length === previous.length ? stable + 1 : 0;
    previous = now;
  }
}

/**
 * 等「**这一次按键**真的排出过一帧」（Ink 自己报的渲染次数，不是「屏上有没有那个字」）
 * @description ⚠️ **为什么 {@link settle} 的那一档不够**：改名框要过「命令落地 → 改状态 →
 * 几何重算 → 排帧」才出现在屏上，而 `settle` 等的是「输出不再变」—— 非交互档中途**一个字都不写**，
 * 于是它退化成 40ms 的固定下限；加上 Ink 把渲染**节流到 30fps**（`maxFps` 默认 30 ⇒ 34ms），
 * 并发一高就抢在重排之前（实测 `/rename` 那一档与「那一枚 `esc 关窗`」那一档**整套里偶发红、
 * 单跑 3 次全绿** —— 闪的测试比没有测试更坏）。
 * ⚠️ **判据必须落在「帧数变了」上而不是「屏上出现了某句话」**：后者会把自己变成恒真
 * （等的就是要断言的那个字，于是断言永不可能红）。
 * ⚠️ **必须带 max elapsed 兜底（2s）**：真没有渲染时（那一键本就不改屏面）不能让整档挂死 ——
 * 超时后照常返回，让后续断言去红。
 */
async function settleRendered(reads: () => number, before: number, maxMs = 2000): Promise<void> {
  const STEP_MS = 5;
  const started = Date.now();
  while (Date.now() - started <= maxMs) {
    if (reads() > before) return;
    await new Promise((resolve) => setTimeout(resolve, STEP_MS));
  }
}

/**
 * 起一次真渲染（假 TTY + 真 `App` + 真 `MouseSource`）
 * @description
 * `interactive: false` 时 Ink **不排增量帧**，而是在 `unmount()` 时把最后一帧一次性写出来，
 * 缓冲里于是恰好一份纯文本帧，不必去切 `log-update` 的光标移动序列（与 `tests/layout/` 同理由）。
 * ⚠️ 而「鼠标移动引起多少重绘」那一档**必须**用默认的 interactive 模式 —— 那种模式下才谈得上
 * 「一帧写了多少字节」，非 interactive 模式下一帧都不排，量出来恒为 0（假绿）。
 *
 * ⚠️ `setEncoding` 刻意**不**接管：PassThrough 自带那个就够用（Ink 的输入解析器拿到的必须是
 * **字符串** —— 它按 `indexOf(escape)` / `slice` 干活，而 PassThrough 在 `read()` 之前给的是
 * Buffer）。⚠️ 早先在这里包过一层 `(encoding) => stdin.setEncoding(encoding)`，那是在
 * `Object.assign` **之后**回读同一个属性，于是无限递归（症状是 Ink 自己的错误边界打印
 * 「Maximum call stack size exceeded」，而每一条断言都看不到自己该看的那一帧）。
 */
export async function mount(options: {
  readonly interactive: boolean;
  /** 终端行数（默认 {@link ROWS}；「装不下时的说明行」那一档要一个**矮**屏） */
  readonly rows?: number;
  /** 要不要着色（**只有**底色那几条要 `true` —— 无色终端里底色根本不存在） */
  readonly color?: boolean;
  /** 台账路径（默认空台账；hover 那几条要有一行可指） */
  readonly ledgerFile?: string;
  /**
   * Ink 的 **debug 档**：每一帧都**整帧**写出来（`ink/build/ink.js:onRender` 开头那个 debug 分支）
   * @description ⚠️ 只有「改窗口大小」那一档要它 —— 它是唯一能从字节流里**切出一整帧**的档：
   * 默认 interactive 档走的是 `log-update` 的增量差分（宽变窄时先 `clearTerminal` 再整帧），
   * 切出来的是一堆差分而不是帧；非 interactive 档则只在 `unmount()` 时写一次。
   */
  readonly debug?: boolean;
  /**
   * `AppProps.exit`（退出边界那个注入点）
   * @description ⚠️ **默认是一个会记下调用次数的替身**，而「`/exit` 退得成」与「`Ctrl+C` 退不成」
   * 两件事都由它回答 —— 真组合根那一份要去真 TTY 才看得到（`cli.tsx` 的 `finish` 读 `process.exitCode`）。
   */
  readonly exit?: () => void;
}): Promise<Mounted> {
  const rows = options.rows ?? ROWS;
  let exits = 0;
  const exit = options.exit ?? ((): void => { exits += 1; });
  const stdout = fakeStdout(COLUMNS, rows);
  let raw = "";
  stdout.on("data", (chunk: Buffer) => {
    raw += chunk.toString("utf8");
  });
  const stdin = fakeStdin();
  Object.assign(stdin, { setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });

  // ⚠️ **Ink 自己报的帧数**（`onRender` 是它每一次**真的排出一帧**时调的回调，与 interactive 无关）：
  // 「这一键排没排过帧」这件事在 stdout 上看不见 —— 非交互档中途一个字都不写 ——
  // 而它正是 {@link settleRendered} 的判据
  let renders = 0;

  // ⚠️ **真 MouseSource**，不是桩：判据要证明的是「同一份字节走了两条路」，故两条路都得是真的。
  const mouse = createMouseSource({ stdin, out: stdout, now: () => NOW });
  const mouseEvents: MouseEvent[] = [];
  mouse.onMouse((event) => mouseEvents.push(event));
  mouse.start();

  const instance = render(
    createElement(App, {
      ledgerFile: options.ledgerFile ?? emptyLedgerPath(),
      columns: COLUMNS,
      rows,
      color: options.color ?? false,
      version: "9.9.9",
      mouse,
      exit,
    }),
    {
      stdout: stdout as never,
      stdin: stdin as never,
      patchConsole: false,
      exitOnCtrlC: false,
      interactive: options.interactive,
      debug: options.debug ?? false,
      onRender: () => {
        renders += 1;
      },
    },
  );
  // ⚠️ 这里原来也是固定 150ms，而它是**唯一一个「第一帧还没写完就往下走」的口子**：
  // `mount()` 返回后第一条动作通常是 `bytes()` 取基准，而那批「本该写 0 字节」的判据
  // 算的是**差值** —— 第一帧的字节漏进来就整条红（实测「50 条移动报告写出 0 字节」那条
  // 在并发下偶发 `expected 100626 to be +0`）。故挂载这一处也要等稳定，且**保留 150ms 底线**
  // （第一帧确定会来，不能只等「不再变」—— 那在它还没写时立刻就满足）。
  await settle(() => raw, 150);
  return {
    stdin,
    mouseEvents,
    bytes: () => Buffer.byteLength(raw, "utf8"),
    snapshot: () => raw,
    exits: () => exits,
    feed: async (chunks) => {
      for (const chunk of chunks) {
        stdin.push(chunk);
        await settle(() => raw);
      }
      await settle(() => raw);
    },
    // ⚠️ **每一 chunk 各自记一次基准**：一批键里第二个键的基准必须是**第一个键之后**的帧数，
    // 否则第一个键排的那一帧会把第二个键也一并算成「排过了」
    feedRendered: async (chunks) => {
      for (const chunk of chunks) {
        const before = renders;
        stdin.push(chunk);
        await settleRendered(() => renders, before);
        await settle(() => raw);
      }
      await settle(() => raw);
    },
    finish: async () => {
      // ⚠️ 同理：unmount 之前也要等屏面稳定，否则 `interactive: false` 那一档返回的
      // 「那一帧原文」可能是**倒数第二帧**（实测它本来就只在 unmount 时写一次）
      await settle(() => raw, 60);
      mouse.stop();
      instance.unmount();
      await new Promise((resolve) => setTimeout(resolve, 40));
      return raw;
    },
    resize: async (columns, rows) => {
      // ⚠️ 类型上那两个字段是 `number`，而「事件到了而字段没有」这个组合必须能造出来 ——
      // 判据在 `@/hooks/useTerminalSize.ts`。
      const stream = stdout as { columns?: number; rows?: number };
      stream.columns = columns;
      stream.rows = rows;
      stdout.emit("resize");
      await new Promise((resolve) => setTimeout(resolve, 120));
    },
  };
}

/** 起一次真渲染，把字节一个一个喂进 stdin，返回屏上那一帧的原始输出 */
export async function renderAndFeed(
  chunks: readonly string[],
  options: { readonly rows?: number; readonly color?: boolean; readonly ledgerFile?: string } = {},
): Promise<{ readonly output: string; readonly mouseEvents: readonly MouseEvent[] }> {
  const ui = await mount({ interactive: false, ...options });
  await ui.feed(chunks);
  const output = await ui.finish();
  return { output, mouseEvents: ui.mouseEvents };
}

/** `Ctrl+C`（`^C` = 0x03）—— ⚠️ **它刻意什么都不做**，而判据是「屏上零变化」（`tests/input/exit.test.ts`） */
export const CTRL_C = String.fromCharCode(0x03);

/**
 * 去掉 CSI / SGR 序列（**逐字符扫**而不是一条正则）
 * @description ⚠️ 与 `tests/layout/` 同一条纪律：正则里的 `\u001B` 会把本包的
 * `no-control-regex` 触发，而给测试档开一条 `eslint-disable` 等于让这条纪律从此不再被看见。
 * ⚠️ 终止条件是「参数段之后的第一个字母」而**不是**任何字母 —— 按后者判会把正文吃掉。
 * @description 用途只有一个：判据要在**剥掉**转义序列之后读**片段内部**（本文件夹开着
 * `FORCE_COLOR`，`palette.test.ts` 的插入符那一格会把 `tatus` 前面的串切开）。片段**之间**多出来的转义序列
 * 不影响 `toContain`，故不必剥。
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

/**
 * 一份**有控制面**的台账路径（会话播种、窗口、拖宽那几档都要它）
 * @description ⚠️ **每次一份新的**（而不是模块级那一份常量）：会话现在**落盘**了，共用一份库的话第二个
 * 用例再 `/new` 就会撞上 `s2` 这个 `id` ⇒ `saveSession` 抛 ⇒ 「新会话没存进台账」那句话落进**上一个**会话的桶，
 * 而症状是「另一个用例的断言红了」，与它自己毫无关系（实测踩过一次）。
 */
export function ledger(): string {
  return seededLedgerPath();
}

/** 一条 SGR 鼠标报告（`column` / `row` 是终端的 1-based 坐标，与真终端一致） */
export function report(button: number, column: number, row: number, release = false): string {
  return `\u001B[<${button};${column};${row}${release ? "m" : "M"}`;
}

/**
 * 侧边栏那几档的几何（⚠️ `paletteCount: 0` —— 清单那几档的面板**永远**没开，否则「输入行以 `/` 开头」
 * 会在屏上多出一块与侧边栏判据无关的东西）
 * @description **期望值从纯函数取**，不写死屏幕行号 —— 与 {@link paletteRowY} 同一条纪律。⚠️ 侧边栏那一列
 * 尤其不能写死：**第一项就落在第 0 行（顶部不留白）**，而写死行号的后果是「几何一改、点就
 * 点空了而断言照旧绿」。
 */
function sidebarGeo(count: number): ReturnType<typeof geometry> {
  return geometry({
    columns: COLUMNS,
    rows: ROWS,
    sidebarWidth: SIDEBAR_WIDTH,
    sessionCount: count,
    sessionsTop: 0,
    input: "",
    paletteCount: 0,
    window: [],
    windowCloseHint: true,
    menu: null,
  });
}

/**
 * 第 `index` 项的**会话名那一行**的 SGR 行号（**1-based**）
 * @description ⚠️ 两个偏移都必须有：**几何是 0-based、SGR 上报是 1-based**（少加这一位就是「点上边那一行」），
 * 而那一行的行号**已经含了项与项之间那一行**（`sidebarRows[index].y` 是几何给的那一份，故这里只加 1）。
 */
export function sidebarNameRow(count: number, index: number): number {
  const g = sidebarGeo(count);
  const rect = g.sidebarRows[index];
  if (rect === undefined) {
    throw new Error(`侧边栏没有第 ${String(index)} 项（可见 ${String(g.sidebarRows.length)} 项）`);
  }
  return rect.y + 1;
}

/** 第 `index` 项那一枚「✕」的 SGR 列号（**1-based**；期望值同样从 `sidebarCloseRows` 取） */
export function sidebarCloseCol(count: number, index: number): number {
  const slot = sidebarGeo(count).sidebarCloseRows[index];
  if (slot === null || slot === undefined) {
    throw new Error(`侧边栏第 ${String(index)} 项没有「✕」`);
  }
  return slot.x + 1;
}

/** 最后一项**之下**那一行侧边栏空白**的 SGR 行号（**1-based**）—— 「空白处右键新开」那一档要点的行 */
export function sidebarEmptyRow(count: number): number {
  const rows = sidebarGeo(count).sidebarRows;
  const last = rows[rows.length - 1];
  if (last === undefined) throw new Error("侧边栏一个会话都没有");
  return last.y + last.height + 1;
}

/** 命令表一共有几条（**问那一份表**，不抄一份数字 —— 抄的那份会随命令增删漂） */
export const PALETTE_TOTAL = COMMAND_SPECS.length;

/** 面板那一档的几何入参（**只有面板开着**，于是其余事实都是缺省） */
export function paletteInput(over: Partial<GeometryInput> = {}): GeometryInput {
  return {
    columns: COLUMNS,
    rows: ROWS,
    sidebarWidth: 22,
    sessionCount: 1,
    sessionsTop: 0,
    input: "",
    paletteCount: PALETTE_TOTAL,
    window: [],
    windowCloseHint: true,
    menu: null,
    ...over,
  };
}

/**
 * 某个词在那一行里的**显示列**（剥掉 ANSI 之后再量宽度）
 * @description ⚠️ 剥完之后的**字符下标**不是显示列 —— 侧边栏那一列有汉字，而一个汉字占两列。
 * 于是「`╭` 在第几列」那种判据按字符下标写会**偏**（而症状是「框的位置看着差不多」）。
 */
export function displayColumnOf(line: string, needle: string): number {
  const stripped = stripAnsi(line);
  const at = stripped.indexOf(needle);
  if (at < 0) throw new Error(`那一行里没有 ${needle}：${stripped}`);
  return widthOf(stripped.slice(0, at));
}

/**
 * `help` 那张表**独有**的一段（用法那几行）—— 判据「表跑没跑」的锚
 * @description ⚠️ 不能用**表头**（`命令    说明`）：面板开着时表头被顶出视口，
 * 而「顶出去了」与「表没跑」在屏上**长得一样**（实测踩过一次：那一条断言恒红）。
 */
export const HELP_TABLE_MARK = "看用法与形参";

/**
 * 面板第 `row` 行落在**第几个屏幕行**（**SGR 报告的 1-based 坐标**）
 * @description ⚠️ 从**几何**算而不写死屏幕行号：面板那几行是「贴着输入框」推出来的，而写死一个
 * 屏幕行号的后果是「几何一改，点就点空了而断言还绿」—— 那种假绿最难发现（它看起来一直是对的）。
 * ⚠️ 坐标是 **1-based**（终端上报就是那样，而几何层已经减过一遍）—— 少加这一位就是「点上边那一行」。
 */
export function paletteRowY(columns: number, rows: number, total: number, row: number): number {
  const g = geometry({ columns, rows, sidebarWidth: 22, sessionCount: 1, sessionsTop: 0, input: "", paletteCount: total, window: [], windowCloseHint: true, menu: null });
  const rect = g.paletteRows[row];
  if (rect === undefined) {
    throw new Error(`面板没有第 ${String(row)} 行（视口 ${String(g.paletteRows.length)} 行）`);
  }
  return rect.y + 1;
}

/**
 * 「最后一个会话关不掉」的那句瞬时消息（**从实现那边抄一份会漂**，故这里只认它那个开头）
 * @description ⚠️ 只认开头那一截：整句太长，而判据要的是「它说了话」这件事 —— 静默拒绝与「这句话改了
 * 措辞」在屏上分别是「什么都没有」与「有话」，前者才是要逮的那个。
 */
export const LAST_SESSION_REFUSAL = "至少留一个会话";

/**
 * `Ctrl+X` 与 `Ctrl+R` 那两键（`^X` = 0x18 / `^R` = 0x12）
 * @description ⚠️ **按码点造**而不在判据里写裸 C0 字符：后者在编辑器里不可见，于是「看不出哪里按了键」
 * 成了这一档最难查的问题；`0x18` / `0x12` 也比魔法数好认（它们是字母码 − `0x40`）。
 */
export const CTRL_X = String.fromCharCode(0x18);
/** `Ctrl+P`（`^P` = 0x10）—— 与 `sessions.test.ts` 那一份**刻意分开**：档间共用要两个以上档真用到 */
export const CTRL_P = String.fromCharCode(0x10);
export const CTRL_R = String.fromCharCode(0x12);
/** `Ctrl+D`（`^D` = 0x04）—— **弹窗里那一个**是永久删除（级联三张表） */
export const CTRL_D = String.fromCharCode(0x04);

/**
 * `↑` / `↓` / `Esc` / `Enter` / `Backspace`（⚠ ✅**全部按码点造**）
 * @description ⚠ `ESC [ A` 那三个字节里**头一个是 ESC**，在编辑器里不可见 ——
 * 「看不出哪里按了键」是这一族档最难查的问题。⚠ 而 `Esc` 键**不带 `[`**（那才是带前缀的那种）、
 * 写成 `ESC [` 会让 Ink 把它当成转义序列的开头而什么都不发生。
 */
export const UP = `${String.fromCharCode(0x1b)}[A`;
export const DOWN = `${String.fromCharCode(0x1b)}[B`;
export const ESC = String.fromCharCode(0x1b);
export const ENTER = String.fromCharCode(0x0d);
export const BACKSPACE = String.fromCharCode(0x7f);

/** 那次右键的落点（**SGR 的 1-based 坐标**：这几档的报告是 `(col = 6, row)`，几何那边是 `(5, row - 1)`） */
export const RIGHT_CLICK_COL = 6;

/**
 * 右键弹出的那个菜单的几何（⚠️ 与实现喂**同一组字段**：`x` / `y` 就是那次右键的落点，项就是那两项）
 * @description 期望值**从纯函数取**而不是写死屏幕行号 —— 菜单是**跟着落点走**的浮层，写死的话
 * 几何一改、点就点空了而断言照旧绿（与 `paletteRowY` 同一条纪律）。
 */
function menuGeo(row: number, items: readonly string[] = [MENU_DETACH, MENU_RENAME]): ReturnType<typeof geometry> {
  return geometry({
    columns: COLUMNS,
    rows: ROWS,
    sidebarWidth: SIDEBAR_WIDTH,
    sessionCount: 2,
    sessionsTop: 0,
    input: "",
    paletteCount: 0,
    window: [],
    windowCloseHint: true,
    menu: { x: RIGHT_CLICK_COL - 1, y: row - 1, items },
  });
}

/**
 * 菜单那一项的**可读前缀**（⚠ 窄屏上它可能被裁，故判据不许抄整句）
 * @description ⚠ 菜单卡宽按**最长那一项**算，而那一项若比其余的长就会裁出一道 `…`。
 * 于是「菜单开着」这个判据**不能**逐字断言那一项的全文 —— 抄全文的话「文案一改长」就整条红，
 * 而「菜单没开」与「菜单开了但那一项被裁」在屏上长得一样。判据取**前缀**（裁不掉那一段）。
 */
export function menuItemPrefix(label: string): string {
  return label.slice(0, 4);
}

/** 菜单里第 `item` 项的 SGR 落点（**1-based**；坐标从几何读；⚠️ 默认那份是**会话项**菜单的三项） */
export function menuItemPoint(
  row: number,
  item: number,
  items: readonly string[] = [MENU_DETACH, MENU_RENAME, MENU_NEW],
): [number, number] {
  const rect = menuGeo(row, items).menuRows[item];
  if (rect === undefined) throw new Error(`菜单没有第 ${String(item)} 项`);
  return [rect.x + 1, rect.y + 1];
}

/**
 * 往库里**手写**几个会话（带 `updated_at` 相对「现在」的天数），用来造「按天数分组」与「激活序」
 * @description ⚠️ 必须走**本包的写入面**（`saveSession`），而不是一句 SQL：那一列的形状与
 * 「`created_at` / `updated_at` 各是什么」是这个档要断言的东西，手写 SQL 等于自己给自己判分。
 * @param daysAgo `0` = 今天、`1` = 昨天（⚠️ 按**本地日历日**算，故与 `dayGroupLabel` 同一套判据）
 */
export function saveSessionSeed(file: string, id: string, name: string, daysAgo: number): void {
  const at = Date.now() - daysAgo * 86_400_000;
  saveSession(file, { id, name, createdAt: at, updatedAt: at });
}

/** 激活一个会话进侧边栏（⚠️ 走**本包的写入面**，而不是一句 SQL —— 激活序就是 `rowid`，而那正是要断言的东西） */
export function pinSessionSeed(file: string, id: string): void {
  pinSession(file, id, Date.now());
}

/**
 * 历史会话弹窗里**第 `at` 个可选会话**那一行的矩形（**从几何读**，不写死屏幕行号）
 * @description ⚠️ 这里给的是**零基的终端坐标**（调用方自己 +1 变 SGR 的 1-based），
 * 而 `historySlot` 喂的那串槽位**就是弹窗那一列**：分组标题行（`group`）、会话行（`row`）、
 * 以及末尾那个改名框（`input`）。⚠️ **判据是 `windowRows` 而不是 `windowSlots`** ——
 * 前者只含 `row` 槽，于是它的下标就是「第几个可选会话」而不是「第几行」。
 */
export function historySlot(sessions: number, at: number, renaming = false): { x: number; y: number } {
  const slots: WindowSlot[] = [
    { kind: "group" },
    ...Array.from({ length: sessions }, (): WindowSlot => ({ kind: "row" })),
    ...(renaming ? [{ kind: "input" as const }] : []),
  ];
  const g = geometry({
    columns: COLUMNS,
    rows: ROWS,
    sidebarWidth: SIDEBAR_WIDTH,
    sessionCount: sessions,
    sessionsTop: 0,
    input: "",
    paletteCount: 0,
    window: slots,
    windowCloseHint: !renaming,
    menu: null,
  });
  const rect = g.windowRows[at];
  if (rect === undefined) {
    throw new Error(`弹窗没有第 ${String(at)} 个可选会话（共 ${String(sessions)} 个）`);
  }
  return rect;
}

/**
 * 会话菜单那三项的**原文**（⚠️ 期望值从**实现的菜单**那份表取不到 —— 那是状态层的私有常量，
 * 而抄一份会随文案漂。判据那一侧只断言**行为**（「那一项移出侧边栏」），而坐标按这套文案算）
 * @description ⚠️ **三个名字分开导出**而不是一个数组：判据要**按项**引用（`toContain(那一项)`），
 * 而一个数组逼着判据抄下标（`items[0]`）—— 下标在菜单项增删时会悄悄指向另一项。
 */
export const MENU_DETACH = "从侧边栏移出";
export const MENU_RENAME = "重命名";
export const MENU_NEW = "新建会话";

/**
 * 那一帧里**侧边栏那一列**（逐行切出前 {@link SIDEBAR_WIDTH} 个显示列，ANSI 已剥）
 * @description ⚠️ 「侧边栏上有没有它」这种判据**必须**按列切：瞬时消息与命令回显都落在主区，而它们
 * 逐字包含会话名 —— 不切的话「藏起来了」与「屏上还有那个名字」在判据上分不开（实测踩过一次）。
 */
export function sidebarOf(output: string): readonly string[] {
  return stripAnsi(output)
    .split("\n")
    .map((line) => {
      let out = "";
      let shown = 0;
      for (const ch of line) {
        if (shown >= SIDEBAR_WIDTH) break;
        out += ch;
        shown += widthOf(ch);
      }
      return out;
    });
}

/**
 * 那一帧里所有**加粗**的片段
 * @description ⚠️ 逐字符扫而**不是**一条正则：判据里出现 ESC 字面量会触发本包的
 * `no-control-regex`，而给测试档开一条 `eslint-disable` 等于让那条纪律从此不再被看见
 * （与 {@link stripAnsi} 同一条纪律）。⚠️ 它答的是「**哪几段是加粗的**」而不是
 * 「有没有加粗」—— 插入符那一格也是加粗的，于是「开没开」在这类帧上恒为真。
 */
export function boldRuns(output: string): readonly string[] {
  const runs: string[] = [];
  const on = "\u001B[1m";
  const off = "\u001B[22m";
  let current: string | null = null;
  for (let i = 0; i < output.length; i += 1) {
    if (output.startsWith(on, i)) {
      current = "";
      i += on.length - 1;
      continue;
    }
    if (current !== null && output.startsWith(off, i)) {
      if (current !== "") runs.push(current);
      current = null;
      i += off.length - 1;
      continue;
    }
    if (current !== null) current += output[i];
  }
  return runs;
}

/** 把一个词敲进去（一个字符一个 chunk，与真终端的到达方式一致） */
export function typed(word: string): string[] {
  return [...word];
}
