/**
 * 经**真 Ink 输入通路**的那一档：终端协议报文不许变成输入行的内容
 *
 * **为什么这一档必须存在**（它不是 `tests/mouse.test.ts` 那些纯函数断言的重复）：
 * 本包的真 bug 出在**两个消费者之间**，纯函数档看不见它。同一份 stdin 字节被广播给两处：
 * - `@/services/terminal/mouse.ts` 的 `createMouseSource` —— 按 `parseSgr` 认出鼠标报告，派发成事件；
 * - Ink 自己的 `useInput` —— 把**未解析**的转义序列当文本交给 `AppState.tsx`，**并在交给之前
 *   顺手砍掉那个 ESC**（`ink/build/hooks/use-input.js`：`if (input.startsWith('\u001B'))
 *   input = input.slice(1)`）。
 *
 * 于是 `ESC[<35;64;32M` 到达输入层时是 `[<35;64;32M`：**一串全是可打印字符**，而
 * `AppState.tsx:printableOnly` 那道 C0 的闸在这里**已经失效**（唯一的 C0 字节被 Ink 拿走了）。
 * 结果是输入行里逐字长出协议报文 —— `?1003h` 开着时移动一次鼠标就是几十行那种。
 *
 * **判据直接取屏幕上那一帧的原始字节**，不去 ANSI：只断言「`[<` 一个字都不许出现」与
 * 「`❯ typed` 必须在」两件事，而任何一条 Ink 自己写出的转义序列里都不会含 `[<`
 * （它只写 `?2026h` / `2J` / `3J` / `H` / `?25l` / `?1000h` 那一族）。故不必为这一档
 * 再抄一份 `stripAnsi` —— 而抄一份正是两份判据的开端。
 *
 * **反向自检**：每一条断言都配一条**正向对照**（真敲的字必须出现在输入行上 / 那把「一个键位
 * 写了多少字节」的尺必须是真的）。⚠️ 少了它，「输入行是空的」会因「Ink 根本没渲染」而绿 ——
 * 而那恰恰是这一类界面最可能的失败形态。
 *
 * **顺带钉住的那件事**：移动鼠标**不该引起任何重绘**。⚠️ 这不是「顺手发现的」——
 * 认领掉协议报文之后 `useInput` 一个状态都不改，于是 React 不重渲染、Ink 不排帧，
 * 50 条移动报告往终端写 **0 字节**（实测 win32 / 100×28；一个真键位是 3.4 KB 的一次整帧）。
 * ⚠️ 修好之前那 50 条报告是 50 次整帧重画，而本包的布局恒等于 `rows` 高 ⇒ 每帧都是 fullscreen
 * ⇒ win32 上 Ink 走 `clearTerminal` + 整帧（实测约 5.9 KB/帧）—— 那才是「一动鼠标就卡」的真凶。
 * ⚠️ 这一档必须用默认的 interactive 模式：非 interactive 模式下一帧都不排，量出来恒为 0（假绿）。
 *
 * ⚠️ **这一档不证明鼠标那侧能用**：它证明的是「同一份字节**没有**被当成文本」。
 * 「终端真的会发 SGR 报告」「点击落点对不对」仍需一次真终端人工验收
 * （见 `packages/tui/AGENTS.md` 末尾那一节）。
 *
 * ## ⚠️ 本档**开着 `FORCE_COLOR`**（三处逼出来的，缺一不可）
 * @description
 * - hover 那几条要比**底色**，而无色终端里底色根本不存在 → 判据在无色档上恒红。
 * - ⚠️ 而开着它之后**只有「片段内部被切开」的那些判据**需要剥 ANSI（本档只有幽灵文本那一处：
 *   插入符那一格会把 `tatus` 前面的串切开）。片段**之间**多出来的转义序列不影响 `toContain`
 *   —— 实测开色之后本档只有那一条需要改，其余逐字成立。
 * - 顺带：**双刃**。它让本档第一次能端到端验「`move` 报告 → hover 状态 → 那一项换底色」
 *   这条链路，而此前 hover 只在 `tests/layout.test.ts` 里以 props 的形式验过（渲染那半）。
 *
 * ## 变异实测记录（这一轮新增的两条，每条都做过）
 * @description
 * - `move` 那个 case 改名成永不匹配的值 → 「指到侧边栏那一项」转红。
 * - hover **不跟着指针离开而清掉**（`now === null` 时原样返回旧值）→「划到主区回到列那一条」转红。
 * ⚠️ hover 那三条断言里最要紧的是**探测器**：第一版写成「剥掉 ANSI 之后找 `48;2;`」，
 * 于是它永远是 `null`，而症状是「hover 从来没生效过」—— 与「探测器坏了」**长得一样**。
 * 故 {@link bgBefore} 在**没剥**的那一行上扫（只有「找行」那一步用 {@link stripAnsi}）。
 * - 「改窗口大小」那一档：把 `@/hooks/useTerminalSize.ts` 的 `onResize` 改成开头就 `return`
 *   （当那个事件没来）⇒ 「拉宽拉高」与「拉窄到侧边栏画不出来」两条**都**转红（锚点分别从
 *   「120 列 / 第 35 行」退回「100 列 / 第 23 行」与从「第 1 列」退回「第 23 列」）。
 *   ⚠️ 而同族那一条「报上来一个**不可用**的尺寸」在这次变异下**照旧绿** —— 它判的是另一条分支，
 *   单独跑它什么也证明不了（这是它必须与上面那两条同属一档的原因）。
 * - 再把 `usable(stdout.columns) ?? initial.columns` 改成 `stdout.columns`（去掉那份兜底）⇒
 *   **只有**「不可用的尺寸回到快照」那一条转红（锚点的行号从 23 变成 21：几何被 `undefined` 毁了）。
 *
 * ⚠️ 上面那条「移动鼠标不该引起任何重绘」的判据**仍然成立**：hover 只在**换了一项**时
 * `setState`（同一个值原样返回 ⇒ React 跳过重渲染），而 `?1003h` 开着时一秒几百条报告
 * 绝大多数落在同一项上。
 *
 * ## 侧边栏那一列这一轮新增的九条（逐条实测，**九条全部转红**）
 * @description 跑法：先跑一遍基线档并断言它**全绿**（spawn 失败会长成「全部变异都红」那种假象，
 * 实测踩过一次），再逐条改源码 → 跑本档 → 复原 → 记下「哪些判据转红」。M10 / M11 是本轮
 * （模态门禁补齐）新加的两条，同样逐条实测过。
 *
 * | # | 变异 | 转红的判据 |
 * | --- | --- | --- |
 * | M1 | `use-mouse.ts`：滚轮那一条不再问「指针在不在侧边栏上」（恒 `false`） | 「滚轮在侧边栏上**翻会话清单**」 |
 * | M2 | `use-mouse.ts`：点会话项时**漏加** `g.sessionFirst` | 同上（点第一项切到会话 1，而它此刻不在屏上） |
 * | M3 | `use-mouse.ts`：`move` 的 hover **漏加** `g.sessionFirst` | 「滚过之后指到窗口里那一项 ⇒ 「✕」**露在那一行**上」 |
 * | M4 | `use-mouse.ts`：右键不再先判手柄那一列 | 「右键**手柄那一列**什么都不做」 |
 * | M5 | `use-mouse.ts`：右键空白处不再 `spawnSession()` | 「右键**空白处** = 新开一个会话」 |
 * | M6 | `use-mouse.ts`：左键不再先判那一枚「✕」（改成切过去） | 「点那一枚「✕」⇒ 关掉**那一项**」 |
 * | M7 | `use-mouse.ts`：模态那个判据改成 `false` | 「窗口是**模态**：背后那几行的点击全被吞掉」 |
 * | M8 | `AppState.tsx`：去掉「最后一个会话关不掉」那道闸 | 「**最后一个会话关不掉**」 |
 * | M9 | `AppState.tsx`：`revealSession` 改回 `index - fit + 1`（按**上一帧**那个可见项数往回推） | 「窄屏上连开几个会话：**刚建出来的那一个必须在屏上**」 |
 * | M10 | `use-mouse.ts`：`move` 分支的模态门禁删掉 | 「模态开着时**指针移过侧边栏不换 hover**」（实测多写 5013 字节 = 一整帧） |
 * | M11 | `use-mouse.ts`：`wheelUp`/`wheelDown` 的模态门禁删掉 | 「模态开着时**滚轮被吞掉**」（实测背后那张表滚了 3 行） |
 * | T1 | `use-mouse.ts`：`down` 里**菜单那一支整段删掉**（判据次序退到会话项之后） | 「右键某一项 ⇒ 弹出菜单」+「右键**空白处**」+「点它外面只关菜单」+「最后一个会话关不掉」+「菜单里的重命名」—— **五条同时转红**（点菜单里那一项会变成「切到它压着的会话」，菜单永远点不动） |
 * | T2 | `useHotkeys.ts`：`Ctrl+R` 什么都不做 | 「`Ctrl+R` 打开**同一个**框」 |
 * | T3 | `AppState.tsx`：`confirmRename` 只关框、不落名字 | 「输字 + `Enter` ⇒ 侧边栏上是新名字」+「改名落库」—— **两条同时转红** |
 * | T4 | `store/app-store.ts`：`visibleSessions` 不再过滤 | 「藏起来 ⇒ 侧边栏上**没有它**」 |
 * | T5 | `db.ts`：v1 → v2 那条 `ALTER TABLE sessions ADD COLUMN visible` 不跑 | `tests/sqlite.test.ts`「v1 库被 v2 代码打开」（**跨档**：它红的是驱动那一档） |
 *
 * ⚠️ **M7 逮到的是一条原本恒绿的判据**：改之前那条只断言「屏上有『未选控制面』」，而**切回会话 1
 * 之后会话 2 的第二行照样是那一句** —— 于是「窗口吞掉了点击」与「点击切了过去」在屏上完全一样。
 * 已改成断言**加粗的那一项**（会话 2 仍被选中）。同类形状在侧边栏那一列上还有一处：**项与项之间那一行**
 * 曾经被当过「点会话 1」，而那一档现在带一条**反向对照**（点那一行 vs 点它下面那一行，两者必须不同）。
 */

import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { App } from "@/AppState.js";
import { widthOf } from "@/lib/format.js";
import { LOGO } from "@/features/output/logo.js";
import { createMouseSource, type MouseEvent } from "@/services/terminal/mouse.js";
import { readSessions, setSessionVisible, writeLedger, writeProvider } from "@/services/config/index.js";
import {
  geometry,
  MIN_TERMINAL_COLUMNS,
  PALETTE_MAX_RATIO,
  SIDEBAR_WIDTH,
  type GeometryInput,
} from "@/lib/geometry.js";
import { COMMAND_SPECS } from "@/commands/parse.js";
import { PALETTE_ROWS } from "@/commands/palette.js";

const COLUMNS = 100;
const ROWS = 28;

/** `src/` 那一层的绝对路径（「不许有 `setInterval`」那一条按目录现列，不手写清单） */
const srcRoot = join(__dirname, "..", "src");

/** 探活窗口要一个**不动的**时刻源，否则「最近收到过报告」会随墙钟乱跳 */
const NOW = 1_700_000_000_000;

/** 一个空台账的路径（`readLedger` 对**不存在**的库返回空台账，故这里不必先建库） */
function emptyLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "swain-tui-input-")), "tui.db");
}

/**
 * 一个**有目标**的台账（hover 那几条要有一行可指，故不能拿空台账）
 * @description ⚠️ 端点指向一个**不存在的**端口：探活会失败，而那一格正好是「未知」——
 * hover 与连接状态是**两件独立的事**，不该被探活的结果连坐（`tests/layout.test.ts` 那几条
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
interface Mounted {
  readonly stdin: PassThrough & { isTTY: boolean };
  readonly mouseEvents: MouseEvent[];
  /** 截至此刻写进 stdout 的字节总数 */
  readonly bytes: () => number;
  readonly feed: (chunks: readonly string[]) => Promise<void>;
  /**
   * 终端改大小（**先改流上的字段，再发 `resize`** —— 顺序反了的话读到的是改之前的尺寸）
   * @description ⚠️ 那两个数**可以是 `undefined`**：`columns` / `rows` 本来就是 `tty.WriteStream`
   * 才有的字段，故「事件到了而字段没有」这个组合要能造 —— 应用必须**回到组合根那份快照**
   * （判据在 `@/hooks/useTerminalSize.ts`）。
   */
  readonly resize: (columns: number | undefined, rows: number | undefined) => Promise<void>;
  /** 收尾；**只在 `interactive: false` 时**返回屏上那一帧的原文 */
  readonly finish: () => Promise<string>;
}

/**
 * 起一次真渲染（假 TTY + 真 `App` + 真 `MouseSource`）
 * @description
 * `interactive: false` 时 Ink **不排增量帧**，而是在 `unmount()` 时把最后一帧一次性写出来，
 * 缓冲里于是恰好一份纯文本帧，不必去切 `log-update` 的光标移动序列（与 `layout.test.ts` 同理由）。
 * ⚠️ 而「鼠标移动引起多少重绘」那一档**必须**用默认的 interactive 模式 —— 那种模式下才谈得上
 * 「一帧写了多少字节」，非 interactive 模式下一帧都不排，量出来恒为 0（假绿）。
 *
 * ⚠️ `setEncoding` 刻意**不**接管：PassThrough 自带那个就够用（Ink 的输入解析器拿到的必须是
 * **字符串** —— 它按 `indexOf(escape)` / `slice` 干活，而 PassThrough 在 `read()` 之前给的是
 * Buffer）。⚠️ 早先在这里包过一层 `(encoding) => stdin.setEncoding(encoding)`，那是在
 * `Object.assign` **之后**回读同一个属性，于是无限递归（症状是 Ink 自己的错误边界打印
 * 「Maximum call stack size exceeded」，而每一条断言都看不到自己该看的那一帧）。
 */
async function mount(options: {
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
}): Promise<Mounted> {
  const rows = options.rows ?? ROWS;
  const stdout = fakeStdout(COLUMNS, rows);
  let raw = "";
  stdout.on("data", (chunk: Buffer) => {
    raw += chunk.toString("utf8");
  });
  const stdin = fakeStdin();
  Object.assign(stdin, { setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });

  // ⚠️ **真 MouseSource**，不是桩：本档要证明的是「同一份字节走了两条路」，故两条路都得是真的。
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
    }),
    {
      stdout: stdout as never,
      stdin: stdin as never,
      patchConsole: false,
      exitOnCtrlC: false,
      interactive: options.interactive,
      debug: options.debug ?? false,
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  return {
    stdin,
    mouseEvents,
    bytes: () => Buffer.byteLength(raw, "utf8"),
    feed: async (chunks) => {
      for (const chunk of chunks) {
        stdin.push(chunk);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    },
    finish: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
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
async function renderAndFeed(
  chunks: readonly string[],
  options: { readonly rows?: number; readonly color?: boolean; readonly ledgerFile?: string } = {},
): Promise<{ readonly output: string; readonly mouseEvents: readonly MouseEvent[] }> {
  const ui = await mount({ interactive: false, ...options });
  await ui.feed(chunks);
  const output = await ui.finish();
  return { output, mouseEvents: ui.mouseEvents };
}

/**
 * 去掉 CSI / SGR 序列（**逐字符扫**而不是一条正则）
 * @description ⚠️ 与 `tests/layout.test.ts` 同一条纪律：正则里的 `\u001B` 会把本包的
 * `no-control-regex` 触发，而给测试档开一条 `eslint-disable` 等于让这条纪律从此不再被看见。
 * ⚠️ 终止条件是「参数段之后的第一个字母」而**不是**任何字母 —— 按后者判会把正文吃掉。
 * @description 用途只有一个：判据要在**剥掉**转义序列之后读**片段内部**（本档开着
 * `FORCE_COLOR`，插入符那一格会把 `tatus` 前面的串切开）。片段**之间**多出来的转义序列
 * 不影响 `toContain`，故不必剥。
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
 * 一份**有控制面**的台账路径（会话播种、窗口、拖宽那几档都要它）
 * @description ⚠️ **每次一份新的**（而不是模块级那一份常量）：会话现在**落盘**了，共用一份库的话第二个
 * 用例再 `/new` 就会撞上 `s2` 这个 `id` ⇒ `saveSession` 抛 ⇒ 「新会话没存进台账」那句话落进**上一个**会话的桶，
 * 而症状是「另一个用例的断言红了」，与它自己毫无关系（实测踩过一次）。
 */
function ledger(): string {
  return seededLedgerPath();
}

/** 一条 SGR 鼠标报告（`column` / `row` 是终端的 1-based 坐标，与真终端一致） */
function report(button: number, column: number, row: number, release = false): string {
  return `\u001B[<${button};${column};${row}${release ? "m" : "M"}`;
}

describe("鼠标报告不许变成输入行的内容（真 Ink 通路）", () => {
  it("移动报告（`b = 35`，`?1003h` 开着时每帧都有）：一个字都不许进输入行", async () => {
    const { output, mouseEvents } = await renderAndFeed([
      report(35, 64, 32),
      report(35, 63, 32),
      report(35, 72, 30),
    ]);
    expect(output).not.toContain("[<");
    // 正向对照：同一份字节**确实**到了鼠标那一侧 —— 否则上面那条可能只是「谁都没收到」。
    expect(mouseEvents.length).toBe(3);
    expect(mouseEvents[0]).toMatchObject({ action: "move", x: 63, y: 31 });
  });

  it("按下 / 释放 / 拖动 / 滚轮四种报告形态同样一个字都不许进输入行", async () => {
    const { output, mouseEvents } = await renderAndFeed([
      report(0, 10, 5),
      report(0, 10, 5, true),
      report(32, 12, 6),
      report(64, 12, 6),
      report(65, 12, 6),
    ]);
    expect(output).not.toContain("[<");
    expect(mouseEvents.map((event) => event.action)).toEqual([
      "down",
      "up",
      "drag",
      "wheelUp",
      "wheelDown",
    ]);
  });

  it("**反向自检**：真敲的字必须出现在输入行上（否则上面两条只是「什么都没渲染」）", async () => {
    const { output, mouseEvents } = await renderAndFeed(["s", "t", "a", "t", "u", "s"]);
    expect(output).toContain("❯ status");
    expect(output).not.toContain("[<");
    expect(mouseEvents).toEqual([]);
  });

  it("报文与真输入混在同一段字节里时，只有真输入进输入行", async () => {
    const { output, mouseEvents } = await renderAndFeed([`${report(35, 5, 5)}ab${report(35, 6, 5)}`]);
    expect(output).toContain("❯ ab");
    expect(output).not.toContain("[<");
    expect(mouseEvents).toHaveLength(2);
  });

  it("用户自己敲的 `[` 与 `[<` 仍然打得进去（判据不许过宽）", async () => {
    const { output } = await renderAndFeed(["[", "<", "1", ";", "2", ";", "3", "M"]);
    expect(output).toContain("❯ [<1;2;3M");
  });

  it("输入行里的 C0 闸仍然在：一段**带换行的粘贴**不会把那截换行变成内容", async () => {
    // ⚠️ 走**括号粘贴**通道（`ESC[200~ … ESC[201~`）：Ink 的输入解析器把整段交给 `useInput`
    // 的**一次**回调，于是 `printableOnly` 面对的是「`a` + U+000D + `b`」这么一串。
    // ⚠️ 别用「敲一个 `\r`」代替：那是 `key.return`，本就该**提交命令**，与 C0 那一道闸无关
    // （实测那样断言会看到输入行被清空，而症状看起来像闸坏了）。
    const { output } = await renderAndFeed(["\u001B[200~a\rb\u001B[201~"]);
    expect(output).toContain("❯ ab");
    expect(output).not.toContain("不认识的命令");
  });
});

describe("鼠标移动**不引起重绘**（认领掉的那一道闸顺带省掉了整场重画）", () => {
  it("50 条移动报告在主区里写出的字节是 **0**（认领掉协议报文后 React 一个状态都不改）", async () => {
    const ui = await mount({ interactive: true });
    const settled = ui.bytes();
    // ⚠️ **列范围避开两处「移动真的会改状态」的地方**：侧边栏那几行（hover 换底色）与
    // 最右那一列（拖宽手柄自己换底色）。它们是**两条真实的通道**，把它们算进「移动引起的
    // 重绘」会让这条判据恒红 —— 而它护的是「认领掉协议报文之后不该有任何重绘」。
    // ⚠️ 起点从 {@link SIDEBAR_WIDTH} + 1 起算：那一列宽是**缺省值**，而写死的列号在它变宽之后
    // 就会落进侧边栏里，于是「移动不引起重绘」变成「移动改了 hover」。
    await ui.feed(Array.from({ length: 50 }, (_, i) => report(35, SIDEBAR_WIDTH + 1 + (i % 40), 20)));
    const afterMoves = ui.bytes() - settled;
    await ui.feed(["a"]);
    const afterKey = ui.bytes() - settled - afterMoves;
    await ui.finish();

    expect(ui.mouseEvents).toHaveLength(50);
    // 正向对照：**尺**必须是真的，否则「0」只是「什么都在写不出来」
    expect(afterKey).toBeGreaterThan(1024);
    expect(afterMoves).toBe(0);
  });

  it("50 条移动报告**在同一个会话项里来回划**也只写一次整帧（hover 只在换了一项时才 setState）", async () => {
    const ui = await mount({ interactive: true });
    const settled = ui.bytes();
    // ⚠️ 第 1 项占**两行**（0 与 1），而这三列都在它里面：于是 `hoveredId` 从「无」变一次
    // 「会话 1」之后就再也不变 —— React 跳过重渲染，屏上一个字节都不该多写。
    await ui.feed(Array.from({ length: 50 }, (_, i) => report(35, 4 + (i % 3), 2)));
    const afterMoves = ui.bytes() - settled;
    await ui.feed(["a"]);
    const afterKey = ui.bytes() - settled - afterMoves;
    await ui.finish();

    // ⚠️ 判据是「**至多一次整帧**」：一次 hover 变化 = 一次重绘，而它**已经发生过了**
    // （`afterMoves > 0` 就是那个证据）—— 于是 50 条报告里有 49 条一个字都不写。
    // 闸门被拆掉时这 50 条是 50 次整帧，而一个键位本身也就是一帧（实测 1.3 KB / 帧）。
    expect(afterMoves).toBeGreaterThan(0);
    expect(afterMoves).toBeLessThanOrEqual(afterKey);
  });

  /**
   * ⚠️ `src/` 里**一处 `setInterval` 都不许有**（动画 = 每 80ms 一整帧）
   *
   * @description 上面那两条是「不重绘」的**症状级**判据，而这一条按**源码**判同一个不变量：
   * 一旦有人挂上一个定时器驱动的动画（最可能的候选是 `@inkjs/ui` 的 `Spinner`，它无条件
   * `setInterval(…, 80)` 且**没有 `isActive`**），屏上就会每 80ms 排一帧，而本包的布局恒等于 `rows` 高
   * ⇒ 每帧都是 fullscreen。⚠️ **实测过**（win32 / 100×28 / 50 条移动报告）：空转时那 50 条报告写
   * **0 字节**，挂一个常驻 spinner 之后写 **1224 字节** —— 症状是「一动鼠标就卡」。
   *
   * @description ⚠️ **为什么不等上面那两条转红再改**：那要等到「屏上看着卡」才被发现，而这一条当场就红。
   * ⚠️ 锚点是 `setInterval` 这个 **API** 而不是某个符号名，故它既不恒真也不恒假（`src/` 今天真的是 0 处）。
   */
  it("⚠️ `src/` 里一处 `setInterval` 都没有（唯一的定时器是消息那一记 8 秒的 `setTimeout`）", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && readFileSync(full, "utf8").includes("setInterval")) {
          offenders.push(relative(srcRoot, full).split(sep).join("/"));
        }
      }
    };
    walk(srcRoot);
    expect(
      offenders,
      "本包有定时器驱动的动画：布局恒等于 rows 高 ⇒ 每一次定时器回调都是一整帧 fullscreen\n" +
        `（实测 1224 字节 / 50 条移动报告，而「不重绘」那一档是 0）：\n${offenders.join("\n")}\n\n` +
        "修法：动画只在「真的有东西在动」时挂载，且动画那一块自己算帧（不许拖整屏）。",
    ).toEqual([]);
  });
});

/* ── 呈现层：零外部组件库（判据是**依赖面**，不是「某个 import」） ──────────────── */

/** 只留**代码**（⚠️ 注释里提到 `useInput` 是在讲纪律，不是在挂订阅） */
function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\/.*$/gm, "");
}

/**
 * 本包 `package.json` 里的**依赖面**（⚠️ 读的是那个文件本身：判据是「装了什么」而不是「import 了什么」——
 * 装了而没引与引了而没装是两种不同的事，而只有前者能在引入之前就红）
 */
function dependencyNames(): readonly string[] {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
}

describe("呈现层：呈现层的词汇全部在 `src/components/`，零外部组件库", () => {
  it("⚠️ 依赖面里**没有组件库**（判据：Ink / React / string-width 之外没有别的呈现层依赖）", () => {
    // ⚠️ **白名单是「今天的依赖面」逐条列出来的**，不是「除 Ink 外都不许有」——
    // 后者会把「加一个纯函数库」也判成违规，于是下一个人会去改断言而不是改依赖
    expect(dependencyNames().toSorted()).toEqual([
      "@types/node",
      "@types/react",
      "@typescript-eslint/eslint-plugin",
      "@typescript-eslint/parser",
      "esbuild",
      "eslint",
      "ink",
      "react",
      "string-width",
      "typescript",
      "vitest",
    ]);
  });

  it("⚠️ 探测器认得出依赖名（否则上面那条是「读不到 `package.json` → 空数组」的假绿）", () => {
    expect(dependencyNames()).toContain("ink");
    expect(dependencyNames().length).toBeGreaterThan(5);
  });

  it("⚠️ **`src/` 里没有一处 `@inkjs/ui`**（它的 spinner 会把「不重绘」那一档从 0 字节变成 1224 字节）", () => {
    const users: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && readFileSync(full, "utf8").includes("@inkjs/ui")) {
          users.push(relative(srcRoot, full).split(sep).join("/"));
        }
      }
    };
    walk(srcRoot);
    // ⚠️ **反向自检**：`ink` 本身**确实**在依赖面里（否则上面那条是「本包压根不用 Ink」）
    expect(dependencyNames()).toContain("ink");
    expect(
      users,
      `本包引了 @inkjs/ui：\n${users.join("\n")}\n\n` +
        "理由见 `packages/tui/AGENTS.md`「零外部组件库」一节：`Spinner` 常驻重绘、`TextInput` 的\n" +
        "光标硬绕开 `@/theme`、`useTextInput` 不接管 `Esc`（与「改名框就是输入行」冲突）、`Select`\n" +
        "自带几何，而 `Modal` / `Dialog` / `Table` / `KeyValue` / `Tabs` / `Toast` 那个库**根本没有**。",
    ).toEqual([]);
  });

  it("⚠️ **只有一处 `useInput`**（第二个收键者会抢键：改名框的 `Esc` 就不归它了）", () => {
    const owners: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && /\buseInput\s*\(/.test(codeOf(readFileSync(full, "utf8")))) {
          owners.push(relative(srcRoot, full).split(sep).join("/"));
        }
      }
    };
    walk(srcRoot);
    // ⚠️ **正向对照**：收键的那一处**确实**挂了 `useInput`（否则上面那条是「探测器认不出这个词」）
    expect(codeOf(readFileSync(join(srcRoot, "hooks", "useHotkeys.ts"), "utf8"))).toContain("useInput(");
    expect(owners, `收键的地方不止一处：\n${owners.join("\n")}`).toEqual(["hooks/useHotkeys.ts"]);
  });
});

/**
 * 侧边栏那几档的几何（⚠️ `paletteCount: 0` —— 清单那几档的面板**永远**没开，否则「输入行以 `/` 开头」
 * 会在屏上多出一块与本档无关的东西）
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
    window: false,
    windowRows: 0,
    windowNote: false,
    menu: null,
  });
}

/**
 * 第 `index` 项的**会话名那一行**的 SGR 行号（**1-based**）
 * @description ⚠️ 两个偏移都必须有：**几何是 0-based、SGR 上报是 1-based**（少加这一位就是「点上边那一行」），
 * 而那一行的行号**已经含了项与项之间那一行**（`sidebarRows[index].y` 是几何给的那一份，故这里只加 1）。
 */
function sidebarNameRow(count: number, index: number): number {
  const g = sidebarGeo(count);
  const rect = g.sidebarRows[index];
  if (rect === undefined) {
    throw new Error(`侧边栏没有第 ${String(index)} 项（可见 ${String(g.sidebarRows.length)} 项）`);
  }
  return rect.y + 1;
}

/** 第 `index` 项那一枚「✕」的 SGR 列号（**1-based**；期望值同样从 `sidebarCloseRows` 取） */
function sidebarCloseCol(count: number, index: number): number {
  const slot = sidebarGeo(count).sidebarCloseRows[index];
  if (slot === null || slot === undefined) {
    throw new Error(`侧边栏第 ${String(index)} 项没有「✕」`);
  }
  return slot.x + 1;
}

/** 最后一项**之下**那一行侧边栏空白**的 SGR 行号（**1-based**）—— 「空白处右键新开」那一档要点的行 */
function sidebarEmptyRow(count: number): number {
  const rows = sidebarGeo(count).sidebarRows;
  const last = rows[rows.length - 1];
  if (last === undefined) throw new Error("侧边栏一个会话都没有");
  return last.y + last.height + 1;
}

/* ── 命令面板：整条交互走**真 Ink 输入通路** ─────────────────────────────── */

/** 命令表一共有几条（**问那一份表**，不抄一份数字 —— 抄的那份会随命令增删漂） */
const PALETTE_TOTAL = COMMAND_SPECS.length;

/** 面板那一档的几何入参（**只有面板开着**，于是其余事实都是缺省） */
function paletteInput(over: Partial<GeometryInput> = {}): GeometryInput {
  return {
    columns: COLUMNS,
    rows: ROWS,
    sidebarWidth: 22,
    sessionCount: 1,
    sessionsTop: 0,
    input: "",
    paletteCount: PALETTE_TOTAL,
    window: false,
    windowRows: 0,
    windowNote: false,
    menu: null,
    ...over,
  };
}

/**
 * 某个词在那一行里的**显示列**（剥掉 ANSI 之后再量宽度）
 * @description ⚠️ 剥完之后的**字符下标**不是显示列 —— 侧边栏那一列有汉字，而一个汉字占两列。
 * 于是「`╭` 在第几列」那种判据按字符下标写会**偏**（而症状是「框的位置看着差不多」）。
 */
function displayColumnOf(line: string, needle: string): number {
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
const HELP_TABLE_MARK = "看用法与形参";

/**
 * 面板第 `row` 行落在**第几个屏幕行**（**SGR 报告的 1-based 坐标**）
 * @description ⚠️ 从**几何**算而不写死屏幕行号：面板那几行是「贴着输入框」推出来的，而写死一个
 * 屏幕行号的后果是「几何一改，点就点空了而断言还绿」—— 那种假绿最难发现（它看起来一直是对的）。
 * ⚠️ 坐标是 **1-based**（终端上报就是那样，而几何层已经减过一遍）—— 少加这一位就是「点上边那一行」。
 */
function paletteRowY(columns: number, rows: number, total: number, row: number): number {
  const g = geometry({ columns, rows, sidebarWidth: 22, sessionCount: 1, sessionsTop: 0, input: "", paletteCount: total, window: false, windowRows: 0, windowNote: false, menu: null });
  const rect = g.paletteRows[row];
  if (rect === undefined) {
    throw new Error(`面板没有第 ${String(row)} 行（视口 ${String(g.paletteRows.length)} 行）`);
  }
  return rect.y + 1;
}

describe("命令面板（`/` 敲出来的那一块）：四个入口走同一份实现", () => {
  it("⚠️ 敲一个 `/` 就浮出命令面板（**命令名 + 说明**），且输入行只有那个 `/`", async () => {
    const { output } = await renderAndFeed(["/"]);
    // ⚠️ **反向自检**：下面这些断言都靠「面板真的画出来了」才有意义，
    // 而「什么都没渲染」也会让「输入行只有一个 `/`」成立。
    expect(output).toContain("/help");
    expect(output).toContain("/status");
    expect(output).toContain("服务进程与代理的现状");
    expect(output).toContain("❯ /");
    // ⚠️ 面板**至多内容行的 40%**，故表尾那些**看不见**而面板**说清一共多少条** ——
    // 静默少显示十几条而屏上零解释，就是「台账里就这几个」那种骗人的形态。
    const g = geometry(paletteInput());
    expect(output).toContain(`共 ${String(PALETTE_TOTAL)} 条`);
    expect(output).not.toContain("/target switch");
    expect(g.paletteRows.length + 1).toBeLessThanOrEqual(
      Math.floor(g.output!.height * PALETTE_MAX_RATIO),
    );
    // ⚠️ **底部那一行不再列命令**（它是用户点名要删掉的那条提示栏）
    expect(output).not.toContain("Tab 补全：");
  });

  it("⚠️ 敲完整条命令后面板**仍然**开着（判据只有「以 `/` 开头」这一条）", async () => {
    // ⚠️ 「敲完一个词就关」那种实现会让 `/status` 这一帧的屏上什么都没有 ——
    // 而操作者正在看的就是「我这条命令对不对」，面板正是回答那个问题的。
    const { output } = await renderAndFeed(["/", "s", "t", "a", "t", "u", "s"]);
    expect(output).toContain("/help");
    expect(output).toContain("❯ /status");
  });

  it("`↓` 把高亮那一行**写进输入行**，而回车跑的就是输入行上那一串", async () => {
    // `/` 的高亮是表里第一行（`/help`），`↓` 一次到 `/status`；回车之后输入行被清掉，
    // 故判据只能看**回显那一行** —— 那正是「你刚才跑了什么」在会话列表里的样子。
    const { output } = await renderAndFeed(["/", "\u001B[B", "\r"]);
    expect(output).toContain("❯ /status");
    // ⚠️ **反向自检**：它**真的**跑了 `/status`（空台账 ⇒ 需要控制面 ⇒ 一句「先在左边选一个」）
    expect(output).toContain("先在左边选一个控制面");
    // ⚠️ 而**不是**表里第一行 `/help` 的输出 —— 那正是「`↓` 没写进输入行」的形状
    expect(output).not.toContain("列出命令，或给一条命令看用法");
  });

  it("⚠️ 面板开着时 `↑`/`↓` **不切目标**（它们归面板）", async () => {
    // 台账为空时切目标会说出「台账里还没有控制面」；面板开着时按 `↓` 不该出现那句。
    const { output } = await renderAndFeed(["/", "\u001B[B"]);
    expect(output).not.toContain("台账里只有 1 个控制面");
    expect(output).toContain("❯ /status");
  });

  it("⚠️ 面板关着（输入行是空的）时 `↑`/`↓` 仍然切目标（键位表不许有第二种解释）", async () => {
    const { output } = await renderAndFeed(["\u001B[B"]);
    // 空台账 ⇒ 切目标那一支一句话都没有可切，而**面板也不该开**
    expect(output).not.toContain("/help");
  });

  it("`Tab` 接受高亮那一行（**不**提交），而 `Esc` 关掉面板", async () => {
    const accepted = await renderAndFeed(["/", "s", "\t"]);
    expect(accepted.output).toContain("❯ /status");
    const closed = await renderAndFeed(["/", "\u001B"]);
    expect(closed.output).not.toContain("/help");
  });

  it("⚠️ 不带 `/` 的那一行回车：那是**一句普通聊天消息**（不是命令，也不是解析失败）", async () => {
    // ⚠️ **这一档的判据换过**：R5 起「不以 `/` 开头的那一行」是普通聊天消息（走模型），
    // 而**不是**一次解析失败 —— 旧断言问的是「它说了『每一条命令都要以 / 开头』吗」。
    // 换掉的理由与新判据：那句话本身**只**对命令成立，而屏上必须能分清「我敲的」与「我命令的」。
    const { output } = await renderAndFeed(["s", "t", "a", "t", "u", "s", "\r"]);
    // ⚠️ 那句话**原样**进了结果区（走 `user` 那一档的 `❯ ` 行），而**没有**被当成命令跑
    expect(output).toContain("❯ status");
    expect(output).not.toContain("每一条命令都要以 / 开头");
    // ⚠️ **反向自检**：它**没有**真的跑 `status`（那会发一个请求），也没有出那句表的内容
    expect(output).not.toContain("服务进程与代理的现状");
    // ⚠️ 而**没配 provider** 时它明确说了为什么没执行，而不是崩掉或静默
    expect(output).toContain("还没配模型 provider");
  });

  it("⚠️ 真的**没有 provider** 时那句话留在屏上，一句判据跟着（不许崩、不许静默）", async () => {
    // ⚠️ **反向自检**（同一个探针在「配了 provider」那一档里必须找得到别的说法）：
    // 空台账 ⇒ provider 也没配 ⇒ 这一圈一个请求都不发
    const { output } = await renderAndFeed(["查", "一", "下", "\r"]);
    expect(output).toContain("❯ 查一下");
    expect(output).toContain("还没配模型 provider");
    expect(output).toContain("/provider set");
  });

  it("⚠️ 命令回显**只出现一次**，且凭据是掩码（不是明文）", async () => {
    // 这一条钉的是两件事：①`submit` 不再回显（曾与 `exec` 的回显并存，每条显示两遍）
    // ②`submit` 曾回显**原文**，于是 `/target add … T0KEN` 在结果区里留了一行明文 token。
    // ⚠️ 用 `/help help` 而不是 `/help`：后者输出 20 多行，回显**被滚出视口**了 ——
    // 于是「回显出现两次」与「回显一次也没出现」在这里**长得一样**，那条断言就成了恒假的探针
    // （症状与「实现坏了」无法区分）。⚠️ 也不能用 `/help nope`：题名走 `readTopic`（**值的域在解析层收**），
    // 那是一次**解析失败**，而解析失败的那条路**根本没有回显** —— 判据会 0 条通过。
    const { output } = await renderAndFeed([
      "/",
      "h",
      "e",
      "l",
      "p",
      " ",
      "h",
      "e",
      "l",
      "p",
      "\r",
    ]);
    const echoes = output.split("\n").filter((line) => line.includes("❯ /help help"));
    expect(echoes).toHaveLength(1);
  });

  it("⚠️ 解析失败时**输入行被清掉**（面板随之关，判据看得见）", async () => {
    const { output } = await renderAndFeed(["/", "z", "z", "z", "\r"]);
    expect(output).toContain("不认识的命令");
    // ⚠️ 反面：留着输入行的话面板会**盖住**刚贴上去的判据 —— 那一帧操作者一个字都看不见。
    // ⚠️ 判据是「**面板的一行**不见了」，不能写 `/help` 三个字：判据那句话自己就写着
    // 「不认识的命令（/help 可以看全部命令）」，于是那条断言会恒红。
    expect(output).not.toContain("服务进程与代理的现状");
    expect(output).not.toContain("列出命令，或给一条命令看用法");
  });

  it("⚠️ 幽灵文本 = **按 Tab 会插进来什么**（与 Tab 同一个出口）", async () => {
    // ⚠️ 只敲 `/s`、**不按** Tab：输入行那儿的插入符是一格反底色块（`CaretLine` 画的），
    // 后面跟着一截暗色 —— 那截就是幽灵，而整行读作 `/status`。
    // ⚠️ 判据写成正则而不是 `toContain("❯ /status")`：插入符那一格在纯文本里是**空格**，
    // 于是那一行逐字是 `❯ /s tatus`。
    const { output } = await renderAndFeed(["/", "s"]);
    // ⚠️ 判据落在**剥掉 ANSI 之后**的那一行上：本档开着 `FORCE_COLOR`（hover 那几条要比底色，
    // 而无色终端里底色根本不存在），它会在 `tatus` 前面插进来插入符那一格的转义序列，
    // 不剥的话 `\s+` 匹配不到它 —— 而症状是「幽灵文本没了」。
    expect(stripAnsi(output)).toMatch(/❯ \/s\s+tatus/);
    // ⚠️ 敲的东西表里没有 ⇒ **没有**幽灵（编一个出来就是在诱导一条不存在的命令）
    const none = await renderAndFeed(["/", "z", "z"]);
    expect(none.output).toContain("❯ /zz");
    expect(none.output).not.toContain("❯ /zzz");
  });

  it("⚠️ 底部状态行**不再**写着「用 target add … 加一个」", async () => {
    // 这一句是用户点名删掉的那条「提示栏」：它在底部**一直**挂着，而答案由命令面板给出。
    // ⚠️ 判据锚在**那一整句**上而不是 `target add` 三个字 —— 面板里印着 `/target add`。
    const { output } = await renderAndFeed(["/"]);
    expect(output).not.toContain("台账里还没有控制面");
  });

  it("⚠️ 面板**装不下**时必须有那一句「共 N 条」，且**高亮那一行始终可见**", async () => {
    const g = geometry(paletteInput());
    // ⚠️ 视口几行**问几何**，不写死：面板高度是「至多内容行 40%」推出来的，而屏一矮它就变。
    const view = g.paletteViewportRows;
    expect(view).toBeGreaterThan(0);
    expect(view).toBeLessThan(PALETTE_TOTAL);
    const { output } = await renderAndFeed(["/"], { rows: ROWS });
    expect(output).toContain(`共 ${String(PALETTE_TOTAL)} 条`);
    // ⚠️ **反向自检**：装不下的那些**确实没画**（静默少显示十几条而屏上零解释，就是骗人）
    expect(output).not.toContain(PALETTE_ROWS[PALETTE_TOTAL - 1]!.path);
    // ⚠️ 往下走 `view + 2` 步 ⇒ 窗口**一定**滚过一格（而滚掉的是第 1 条）
    const at = view + 2;
    const row = PALETTE_ROWS[at]!;
    const moved = await renderAndFeed(
      ["/"].concat(Array.from({ length: at }, () => "\u001B[B")),
      { rows: ROWS },
    );
    expect(moved.output).toContain(`❯ ${row.path}`);
    expect(moved.output).not.toContain(`${PALETTE_ROWS[0]!.path} `);
    // ⚠️ **核心判据：高亮那一行在屏上看得见**（`▍` 与它同行）—— 窗口滚动的全部意义就在这一条：
    // 高亮跑出视口时操作者看得见「面板在动」，却看不见「现在选中的是哪一条」。
    expect(moved.output).toContain(`▍ ${row.path}`);
  });

  it("⚠️ 鼠标点面板某一行 = 把它**补进输入行**（**不**执行）", async () => {
    // ⚠️ 判据锚在那张表**独有**的用法那几行上（{@link HELP_TABLE_MARK}），而**不是**表头 ——
    // 也不能用「`/status` 的说明」之类面板上**本来就有**的字符串（面板列的是全表）。
    // ⚠️ 坐标**从几何读**，不写死屏幕行号 —— 面板那几行是「贴着输入框」算出来的，
    // 写死的话几何一改就变成「点了个空白处而断言碰巧还绿」。
    const y = paletteRowY(COLUMNS, ROWS, PALETTE_TOTAL, 0);
    const clicked = await renderAndFeed(["/", report(0, 40, y)]);
    expect(clicked.output).toContain("❯ /help");
    // ⚠️ **反向自检**：点那一下**没有执行** —— 结果区里还没有 help 的那张表。
    // ⚠️ 判据**不能用**「`/status` 的说明」之类面板上**本来就有**的字符串（面板列全表，
    // 说明跟着命令名一起在屏上），也不能用「回显只出现一次」：`/help` 输出 20 多行会把回显
    // **滚出视口**，于是「点一下就执行」与「点了没执行」在这里**长得一样**（实测踩过一次：
    // 0 条通过）。唯一只由那张表给出的东西是它的**表头**。
    expect(clicked.output).not.toContain(HELP_TABLE_MARK);
    // 补完再回车，表才出现 —— 这一条是「点 = 补进行内，回车 = 执行」的另一半
    const after = await renderAndFeed(["/", report(0, 40, y), "\r"]);
    expect(after.output).toContain(HELP_TABLE_MARK);
  });

  it("⚠️ 面板**滚过之后**点某一行的行号 = **候选序**（点第 1 行填的不是第 1 条命令）", async () => {
    // ⚠️ **必须滚过**：窗口没滚时「行号序」与「候选序」恰好相等，那个 bug 就看不见。
    // 按 `view + 1` 步走 ⇒ 高亮在 `view` 号位，窗口**恰好**滚一格，屏上第 1 行是候选 `view - 1 + 1` 号。
    const view = geometry(paletteInput()).paletteViewportRows;
    const at = view + 1;
    const onScreen = PALETTE_ROWS[at - view + 1]!;
    expect(onScreen.path).not.toBe(PALETTE_ROWS[0]!.path);
    const { output } = await renderAndFeed(
      [
        "/",
        ...Array.from({ length: at }, () => "\u001B[B"),
        report(0, 40, paletteRowY(COLUMNS, ROWS, PALETTE_TOTAL, 0)),
      ],
      { rows: ROWS },
    );
    expect(output).toContain(`❯ ${onScreen.path}`);
    // ⚠️ 而**不是**命令表里第一条（那个 bug 的形状：拿「行号」当「候选序」）
    expect(output).not.toContain(`❯ ${PALETTE_ROWS[0]!.path}`);
  });

  it("⚠️ 滚轮在面板开着时**移动高亮**（不是滚结果区）", async () => {
    const { output, mouseEvents } = await renderAndFeed([
      "/",
      report(65, 40, paletteRowY(COLUMNS, ROWS, PALETTE_TOTAL, 0)),
    ]);
    expect(mouseEvents.map((one) => one.action)).toContain("wheelDown");
    expect(output).toContain("❯ /status");
  });
});

/* ── hover：`move` 报告换掉那一项的底色 ─────────────────────────────────── */

describe("hover：`move` 报告换掉那一项的底色（指针位置那一层通道）", () => {
  /**
   * 那一行上**名字之前**最后一个生效的背景色（`r/g/b`）
   * @description ⚠️ 只认 `48;2;r;g;b`（背景）而**不**认 `38;2;…`（前景），且问的是「**哪一个**
   * 底色」而不是「开没开」—— 侧边栏**整列**都有 `surface` 那一条底色，于是「开没开」在这一列上
   * 恒为真，一个「hover 从来没生效过」的实现照样通过。
   */
  /**
   * `name` 之前最后一个**背景色**的 SGR 参数（`null` = 一个都没有）
   * @description ⚠️ 问的是「**哪一个**底色」而不是「开没开」—— 侧边栏**整列**都有
   * `surface` 那一条底色，于是「开没开」在这一列上恒为真，一个「hover 从来没生效过」的
   * 实现照样通过。
   * @description ⚠️ **在没剥 ANSI 的那一行上找**：剥完再找 `48;2;` 的话那个探测永远是 `null`，
   * 而症状是「hover 没生效」—— 与「探测器坏了」**长得一样**（实测踩过一次）。
   */
  function bgBefore(output: string, name: string): string | null {
    const line = output.split("\n").find((one) => stripAnsi(one).includes(name));
    if (line === undefined) throw new Error(`侧边栏里没有 ${name}`);
    const head = line.slice(0, line.indexOf(name));
    let found: string | null = null;
    let i = 0;
    while (i < head.length) {
      if (head[i] !== "\u001B") {
        i += 1;
        continue;
      }
      const bracket = head.indexOf("[", i);
      if (bracket === -1 || bracket > i + 2) {
        i += 1;
        continue;
      }
      let end = bracket + 1;
      while (end < head.length && !/[A-Za-z]/u.test(head[end] as string)) end += 1;
      const params = head.slice(bracket + 1, end);
      if (params.startsWith("48;2;")) found = params;
      i = end < head.length ? end + 1 : head.length;
    }
    return found;
  }


  it("⚠️ 指到侧边栏那一项 ⇒ 它的底色**换成 hover 那一档**（与列那一条不同）", async () => {
    // ⚠️ `color: true` 才有底色可比 —— 无色终端下底色退成 `undefined`（侧边栏与主区长得一模一样），
    // 这一整套性质**无从断言**，而那正是本条设计**刻意**付出的代价（`src/theme/palette.ts` 的 `NO_COLOR` 那一档）。
    // ⚠️ **行号从 {@link sidebarNameRow} 取**，不写死 `1`：清单每项两行、项间一行，写死的后果是
    // 「几何一改、点就点空了而这条断言照旧绿」（它曾经正是那样恒绿的）。
    const pointed = await renderAndFeed([report(35, 6, sidebarNameRow(1, 0))], {
      color: true,
      ledgerFile: ledger(),
    });
    // ⚠️ **反向自检**：与「没有被指着」的那一帧比 —— 判据是「**两者不同**」，而单看一帧的话
    // 「整列常亮」与「hover 生效」长得一模一样。
    const bare = await renderAndFeed([], { color: true, ledgerFile: ledger() });
    const hot = bgBefore(pointed.output, "live-ok");
    const cold = bgBefore(bare.output, "live-ok");
    expect(hot).not.toBeNull();
    expect(hot).not.toBe(cold);
  });

  it("⚠️ 划到主区 ⇒ 侧边栏那一项的底色**回到列那一条**（不留着上一次那一层）", async () => {
    const away = await renderAndFeed(
      [report(35, 6, sidebarNameRow(1, 0)), report(35, 60, sidebarNameRow(1, 0))],
      {
        color: true,
        ledgerFile: ledger(),
      },
    );
    // ⚠️ 判据是「**回到**列那一条」而不是「有没有底色」—— 而这条之所以要写，是因为
    // 「指针不在侧边栏上就停在上一次那一项」那个实现会让底色留着，而屏上没有任何东西解释它。
    const bare = await renderAndFeed([], { color: true, ledgerFile: ledger() });
    expect(bgBefore(away.output, "live-ok")).toBe(bgBefore(bare.output, "live-ok"));
  });

  it("⚠️ hover 一个字节都不许进输入行（`move` 报告走的是鼠标那一路）", async () => {
    const { output, mouseEvents } = await renderAndFeed([report(35, 6, sidebarNameRow(1, 0))], {
      ledgerFile: ledger(),
    });
    expect(output).not.toContain("[<");
    // ⚠️ **正向对照**：同一份字节**确实**到了鼠标那一侧 —— 否则上面那两条只是「谁都没收到」
    expect(mouseEvents.map((one) => one.action)).toEqual(["move"]);
  });
});

/* ── 会话：侧边栏、点选、`/new` ──────────────────────────────────────────── */

describe("会话：侧边栏那一列、`/new`、点选", () => {
  it("⚠️ 启动时侧边栏那一列是**会话**，而控制面只在它的第二行", async () => {
    const { output } = await renderAndFeed([], { ledgerFile: ledger() });
    expect(output).toContain("会话 1");
    // 台账里那个 `selected` 被播种给第一个会话 ⇒ 第二行是**它的名字**
    expect(output).toContain("live-ok");
    // ⚠️ 而**控制面那一列不在侧边栏**：只有一个会话项（两行）
    expect(output).not.toContain("会话 2");
  });

  it("⚠️ `/new` 新开一个会话并切过去（侧边栏多一项，而当前那一项换了）", async () => {
    const { output } = await renderAndFeed([...typed("/new"), "\r"], { ledgerFile: ledger() });
    expect(output).toContain("会话 2");
    // ⚠️ 「切过去了」由**加粗**回答（颜色之外的通道）：判据不写死那串转义序列的具体字节，
    // 只要求「加粗的那一段里含 `会话 2`」
    expect(boldRuns(output).some((run) => run.includes("会话 2"))).toBe(true);
    // ⚠️ **反向自检**：新会话**从「未选控制面」开始**，不继承当前那个 ——
    // 继承的话「新会话是干净的」这件事在屏上一点区别都没有
    expect(output).toContain("未选控制面");
    // ⚠️ 「一个字节都不留」刻意**不在这一帧上判**：切过去之后屏上是**会话 2**，而 `/new` 的痕迹
    // （若有）落在**会话 1** 那一桶里 —— 在这一帧上判它，判的是另一个会话的桶。下一条切回去判。
  });

  it("⚠️ `/new` 在结果区**一个字节都不留**（连回显也没有：切回原会话，那一桶还是空的）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), "\r"]);
    await ui.feed([report(0, 6, sidebarNameRow(2, 0))]);
    const output = await ui.finish();
    // ⚠️ 判据锚在**空桶的形状**上：空桶画的是引导屏那块标记（`AppState.tsx` 的 `showLogo={!flat.any}`，
    // 而 `log.ts:flatten` 的 `any` 就是「桶里有行」），故锚取**素材的第一行艺术字** —— 它只有引导屏
    // 画出来时**才**在屏上，而 `/new` 留了痕就会把它顶掉。
    // ⚠️ 锚**不是**「`/new` 那一串」也不是「刚才那句文案」：帮助表里本来就有 `/new` 这一行（判它不在
    // 屏上永远为真），而执行层已经不给那句话了 —— 两个都是恒绿。
    // ⚠️ 而这一条**会被咬住**：`./exec/echo.ts:leavesTrace` 一旦把 `/new` 说成留痕，`/new` 那一行回显
    // 就落进**会话 1** 的桶里、引导屏被顶掉 ⇒ 这里红。
    expect(output).toContain(LOGO[0]!.text);
    // ⚠️ **反向自检**（本档的纪律：每一条都要配一条对照）：同一个探针在「桶里有行」时必须**找不到**
    // 它 —— 否则上面那条只是「引导屏恰好在屏上」，与 `/new` 一点关系都没有。
    const filled = await renderAndFeed([...typed("/status"), "\r"], { ledgerFile: ledger() });
    expect(filled.output).not.toContain(LOGO[0]!.text);
  });

  it("⚠️ 每个会话有**自己的输出**：切回上一个会话，看得见它自己的结果、看不见另一个的", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/help"), "\r", ...typed("/new"), "\r"]);
    // ⚠️ 会话 2 里跑一条**要控制面**的命令：新会话没有目标 ⇒ 那一桶里落的是「先在左边选一个控制面」，
    // 而这句**只在会话 2 的桶里**。⚠️ 两侧都要：只断言「切回去还看得见 `/help`」的话，两个会话共用
    // 一个桶也能绿（那一趟只有 `/help` 与 `/new`，两者落进同一个桶看起来完全一样）。
    await ui.feed([...typed("/status"), "\r"]);
    // 切回会话 1（点它那一项的第一行）⇒ 它自己的 `/help` 那张表还在
    await ui.feed([report(0, 6, sidebarNameRow(2, 0))]);
    const output = await ui.finish();
    expect(output).toContain(HELP_TABLE_MARK);
    expect(output).not.toContain("先在左边选一个控制面");
  });

  it("⚠️ 点侧边栏那一项 = 切到那个会话（**每项两行**，点第一行与第二行是同一个）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), "\r"]);
    // ⚠️ 点**第二行**（它连的那个控制面那一行）：判据必须是「点整项」而不是「点第一行」——
    // 点第一行会与「点第二行不是同一个会话」这个 bug 长得一样
    await ui.feed([report(0, 6, sidebarNameRow(2, 0) + 1)]);
    const output = await ui.finish();
    // 切回会话 1 ⇒ 它的第二行是 `live-ok`，而「当前」那一项换了高亮
    expect(output).toContain("live-ok");
  });
});

/* ── 侧边栏那一列：滚轮翻清单、「✕」关掉那一项、右键弹出的那个菜单 ──────────── */

/**
 * 「最后一个会话关不掉」的那句瞬时消息（**从实现那边抄一份会漂**，故这里只认它那个开头）
 * @description ⚠️ 只认开头那一截：整句太长，而判据要的是「它说了话」这件事 —— 静默拒绝与「这句话改了
 * 措辞」在屏上分别是「什么都没有」与「有话」，前者才是要逮的那个。
 */
const LAST_SESSION_REFUSAL = "至少留一个会话";

/**
 * `Ctrl+X` 与 `Ctrl+R` 那两键（`^X` = 0x18 / `^R` = 0x12）
 * @description ⚠️ **按码点造**而不在判据里写裸 C0 字符：后者在编辑器里不可见，于是「看不出哪里按了键」
 * 成了这一档最难查的问题；`0x18` / `0x12` 也比魔法数好认（它们是字母码 − `0x40`）。
 */
const CTRL_X = String.fromCharCode(0x18);
const CTRL_R = String.fromCharCode(0x12);

/** 侧边栏那一列的**窄屏**档：4 个会话在 7 行里放不下 3 个 ⇒ 有溢出、可见窗口 2 项 */
const SHORT_ROWS = 7;

/** 那次右键的落点（**SGR 的 1-based 坐标**：本档的报告是 `(col = 6, row)`，几何那边是 `(5, row - 1)`） */
const RIGHT_CLICK_COL = 6;

/**
 * 右键弹出的那个菜单的几何（⚠️ 与实现喂**同一组字段**：`x` / `y` 就是那次右键的落点，项就是那两项）
 * @description 期望值**从纯函数取**而不是写死屏幕行号 —— 菜单是**跟着落点走**的浮层，写死的话
 * 几何一改、点就点空了而断言照旧绿（与 `paletteRowY` 同一条纪律）。
 */
function menuGeo(row: number, items: readonly string[] = ["删除会话", "重命名"]): ReturnType<typeof geometry> {
  return geometry({
    columns: COLUMNS,
    rows: ROWS,
    sidebarWidth: SIDEBAR_WIDTH,
    sessionCount: 2,
    sessionsTop: 0,
    input: "",
    paletteCount: 0,
    window: false,
    windowRows: 0,
    windowNote: false,
    menu: { x: RIGHT_CLICK_COL - 1, y: row - 1, items },
  });
}

/** 菜单里第 `item` 项的 SGR 落点（**1-based**；坐标从几何读；⚠️ 默认那份是**会话项**菜单的三项） */
function menuItemPoint(
  row: number,
  item: number,
  items: readonly string[] = ["删除会话", "重命名", "新建会话"],
): [number, number] {
  const rect = menuGeo(row, items).menuRows[item];
  if (rect === undefined) throw new Error(`菜单没有第 ${String(item)} 项`);
  return [rect.x + 1, rect.y + 1];
}

describe("侧边栏清单：滚动、「✕」、右键弹出的那个菜单", () => {
  it("⚠️ **两项之间**那一行点不动，而它上面那一行点得动（判据是「两者不同」，不是「点了没反应」）", async () => {
    // ⚠️ **两趟都要**：单看「点空白没反应」的话，「那一格根本不属于任何一项」与「点击被正确地忽略了」
    // 在屏上完全一样 —— 而「点了真的一项也没反应」那个实现会照样绿。
    // ⚠️ 量的是**项与项之间那一行**（顶部不再有留白，故第 1 行是第 0 项的控制面那一行，仍属于它）
    const gapRow = sidebarNameRow(2, 1) - 1;
    const onGap = await mount({ interactive: false, ledgerFile: ledger() });
    await onGap.feed([...typed("/new"), "\r", report(0, 6, gapRow)]);
    const held = await onGap.finish();
    expect(boldRuns(held).some((run) => run.includes("会话 2"))).toBe(true);

    const onItem = await mount({ interactive: false, ledgerFile: ledger() });
    await onItem.feed([...typed("/new"), "\r", report(0, 6, sidebarNameRow(2, 0))]);
    const moved = await onItem.finish();
    expect(boldRuns(moved).some((run) => run.includes("会话 1"))).toBe(true);
    expect(boldRuns(moved).some((run) => run.includes("会话 2"))).toBe(false);
  });

  it("⚠️ 滚轮在侧边栏上**翻会话清单**，而点第一项切到的是**窗口里那一项**（`sessionFirst` 的回归）", async () => {
    const ui = await mount({ interactive: false, rows: SHORT_ROWS, ledgerFile: ledger() });
    for (let i = 0; i < 3; i += 1) await ui.feed([...typed("/new"), "\r"]);
    // ⚠️ 滚**够多次**让窗口夹到底（几何把 `sessionFirst` 夹进 `[0, count - viewport]`，而
    // `scrollSessions` 自己不夹上界）—— 于是期望值与「滚之前窗口停在哪」无关。
    await ui.feed(Array.from({ length: 5 }, () => report(65, 6, 3)));
    // 点窗口里**第一项**那一行（行号从几何取）：期望切到的是**会话 3**而不是清单里的第 0 项
    await ui.feed([report(0, 6, sidebarNameRow(4, 0))]);
    const output = await ui.finish();
    // ⚠️ 先证**窗口真的滚了**：会话 1 已经不在屏上 —— 否则下面那条会在「没滚」的实现上通过
    expect(output).not.toContain("会话 1");
    expect(output).toContain("会话 3");
    // ⚠️ **核心判据**：点第一项切到的是会话 3。漏加 `g.sessionFirst` 的实现会切到会话 1 ——
    // 而那一项此刻**不在屏上**，于是屏上看起来「什么都没发生」，正是这个 bug 的形状。
    expect(boldRuns(output).some((run) => run.includes("会话 3"))).toBe(true);
  });

  it("⚠️ 窄屏上连开几个会话：**刚建出来的那一个必须在屏上**（装不下从假变真那一帧也不许丢）", async () => {
    // ⚠️ 这一条钉的是「加一项会让**可见项数在同一帧里变少一格**」（装不下从假变真 ⇒ 那一行说明占掉
    // 一行）：按**上一帧**那个可见项数往回推的窗口，会刚好把刚建的那一项留在屏外 ——
    // 症状是「新会话建好了」，而侧边栏上根本没有它。
    const { output } = await renderAndFeed(
      [...typed("/new"), "\r", ...typed("/new"), "\r", ...typed("/new"), "\r"],
      { rows: SHORT_ROWS, ledgerFile: ledger() },
    );
    expect(output).toContain("会话 4");
    // ⚠️ **反向自检**：屏上装不下（那一行说明出现了），故上面那条不是「全都装得下」白挑的
    expect(output).toContain("共 4");
  });

  it("⚠️ 指到那一项 ⇒ 那一项上**露出**一枚「✕」，而没指着的那些项上一个都没有", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), "\r", ...typed("/new"), "\r"]);
    await ui.feed([report(35, 6, sidebarNameRow(3, 0))]);
    const output = await ui.finish();
    // ⚠️ **反向自检**：三行里**只有一行**有它，而那一行是**悬停那一项的名字那一行**（不是控制面那一行）
    const marks = output
      .split("\n")
      .map((line, at) => (stripAnsi(line).includes("✕") ? at : -1))
      .filter((at) => at >= 0);
    expect(marks).toEqual([sidebarNameRow(3, 0) - 1]);
    // ⚠️ 而**没有悬停**的那一帧一个都没有：那一枚是**状态**画出来的，不是常驻的
    const cold = await renderAndFeed([...typed("/new"), "\r"], { ledgerFile: ledger() });
    expect(cold.output).not.toContain("✕");
  });

  it("⚠️ 滚过之后指到窗口里那一项 ⇒ 「✕」**露在那一行**上（hover 那一路也加 `sessionFirst`）", async () => {
    const ui = await mount({ interactive: false, rows: SHORT_ROWS, ledgerFile: ledger() });
    for (let i = 0; i < 3; i += 1) await ui.feed([...typed("/new"), "\r"]);
    await ui.feed(Array.from({ length: 5 }, () => report(65, 6, 3)));
    await ui.feed([report(35, 6, sidebarNameRow(4, 0))]);
    const output = await ui.finish();
    // ⚠️ **判据是「那一枚露出来了」**：漏加 `g.sessionFirst` 的实现会算出清单里第 0 项的 id，
    // 而那一项此刻**不在可见窗口内** —— 呈现层按 id 匹配，于是**一个都匹配不上**，
    // 症状是「滚过之后 hover 彻底不生效」（底色与按钮一起消失）。
    expect(output).not.toContain("会话 1");
    expect(output).toContain("✕");
    // ⚠️ **反向自检**：没指着的同一帧一个都没有（证明这一枚是**指出来**的，不是滚出来的）
    const cold = await mount({ interactive: false, rows: SHORT_ROWS, ledgerFile: ledger() });
    for (let i = 0; i < 3; i += 1) await cold.feed([...typed("/new"), "\r"]);
    await cold.feed(Array.from({ length: 5 }, () => report(65, 6, 3)));
    expect(await cold.finish()).not.toContain("✕");
  });

  it("⚠️ 点那一枚「✕」⇒ 关掉**那一项**，而当前那一项不动（点名字仍然是「切过去」）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), "\r", ...typed("/new"), "\r"]);
    // 先指到会话 1（那一枚只在悬停时画出来），再点它的**列**（从几何取，与画出来的是同一个矩形）
    await ui.feed([
      report(35, 6, sidebarNameRow(3, 0)),
      report(0, sidebarCloseCol(3, 0), sidebarNameRow(3, 0)),
    ]);
    const output = await ui.finish();
    expect(output).not.toContain("会话 1");
    expect(output).toContain("会话 2");
    // ⚠️ **不是当前那一项** ⇒ 当前那一项不动（这一条才是「关掉的是那一项」与「关掉当前会话」的区别）
    expect(boldRuns(output).some((run) => run.includes("会话 3"))).toBe(true);
  });

  it("⚠️ 右键某一项 ⇒ 弹出菜单（**不是**直接关掉它），而点「删除会话」才真的关", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), "\r", ...typed("/new"), "\r"]);
    const row = sidebarNameRow(3, 0);
    // 右键第一项（会话 1）⇒ 菜单出现，而清单**一个都没少**（右键不直接动手）
    await ui.feed([report(2, RIGHT_CLICK_COL, row)]);
    const opened = await ui.finish();
    expect(opened).toContain("删除会话");
    expect(opened).toContain("重命名");
    // ⚠️ **第三项是「新建会话」**（需求要的三项）：清单被填满时空白处那一路整个没了，
    // 而删除与改名都还在 —— 三个动作不许有两个与清单密度绑在一起
    expect(opened).toContain("新建会话");
    // ⚠️ 而菜单**压住了它自己弹出来的那一项**（菜单是浮层）：下面两项照旧看得见
    expect(opened).toContain("会话 2");
    expect(opened).toContain("会话 3");

    // 而点菜单里第一项才真的关掉它（坐标从几何读）
    const two = await mount({ interactive: false, ledgerFile: ledger() });
    await two.feed([...typed("/new"), "\r", ...typed("/new"), "\r"]);
    await two.feed([report(2, RIGHT_CLICK_COL, row)]);
    const [x, y] = menuItemPoint(row, 0);
    await two.feed([report(0, x, y)]);
    const output = await two.finish();
    expect(output).not.toContain("会话 1");
    expect(output).toContain("会话 2");
    expect(output).not.toContain("删除会话");
    // ⚠️ **不是当前那一项** ⇒ 当前那一项不动（这一条才是「关掉的是那一项」与「关掉当前会话」的区别）
    expect(boldRuns(output).some((run) => run.includes("会话 3"))).toBe(true);

    // ⚠️ 而菜单里那第三项（`menuItemPoint(row, 2)`）= 新开一个会话，与空白处那一份同一个入口
    const three = await mount({ interactive: false, ledgerFile: ledger() });
    await three.feed([...typed("/new"), "\r", ...typed("/new"), "\r"]);
    await three.feed([report(2, RIGHT_CLICK_COL, row)]);
    const [nx, ny] = menuItemPoint(row, 2);
    await three.feed([report(0, nx, ny)]);
    const grown = await three.finish();
    // ⚠️ **正向对照**：起手那三个都还在（点它不是「关掉那一项」），而多出来的是**第四个**
    expect(grown).toContain("会话 4");
    expect(boldRuns(grown).some((run) => run.includes("会话 4"))).toBe(true);
  });

  it("⚠️ 右键**空白处** ⇒ 「新建会话」那一份菜单；点它 = `/new` 那个入口", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    // 最后一项之下那一行（行号从几何取：那一项的下缘再往下）⇒ 空白处那一份，**只有一项**
    const empty = sidebarEmptyRow(1);
    await ui.feed([report(2, RIGHT_CLICK_COL, empty)]);
    const opened = await ui.finish();
    expect(opened).toContain("新建会话");
    expect(opened).not.toContain("删除会话");

    // 而点它 = 新开一个会话，与 `/new` 同一个入口（发号只有一处 ⇒ 名字是「会话 2」）
    const two = await mount({ interactive: false, ledgerFile: ledger() });
    await two.feed([report(2, RIGHT_CLICK_COL, empty)]);
    const [x, y] = menuItemPoint(empty, 0, ["新建会话"]);
    await two.feed([report(0, x, y)]);
    const output = await two.finish();
    expect(output).toContain("会话 2");
    expect(boldRuns(output).some((run) => run.includes("会话 2"))).toBe(true);
  });

  it("⚠️ 菜单：**点它外面只关菜单**（不顺手把底下那一层也点掉），而 `Esc` 也关", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), "\r"]);
    const row = sidebarNameRow(2, 0);
    await ui.feed([report(2, RIGHT_CLICK_COL, row), report(0, 60, sidebarNameRow(2, 1))]);
    const closed = await ui.finish();
    expect(closed).not.toContain("删除会话");
    // ⚠️ **核心判据**：点主区那一行**没有**顺手切会话（关菜单 ≠ 点它底下的东西）
    expect(boldRuns(closed).some((run) => run.includes("会话 2"))).toBe(true);

    const esc = await mount({ interactive: false, ledgerFile: ledger() });
    await esc.feed([...typed("/new"), "\r", report(2, RIGHT_CLICK_COL, row), "\u001B"]);
    expect(await esc.finish()).not.toContain("删除会话");
  });

  it("⚠️ 菜单也能**纯键盘**走完：`↓` 换高亮、`Enter` 选中、`Esc` 收掉（右键到不了应用的终端上只剩它）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), "\r", ...typed("/new"), "\r"]);
    const row = sidebarNameRow(3, 0);
    await ui.feed([report(2, RIGHT_CLICK_COL, row)]);
    // ⚠️ `↓` 把高亮从「删除会话」挪到「重命名」—— 判据是**记号那一行**（第一行没有 `▍` 了）
    await ui.feed(["\u001B[B"]);
    const moved = await mount({ interactive: false, ledgerFile: ledger() });
    await moved.feed([...typed("/new"), "\r", ...typed("/new"), "\r", report(2, RIGHT_CLICK_COL, row), "\u001B[B"]);
    const highlighted = await moved.finish();
    expect(highlighted).toContain("▍ 重命名");
    expect(highlighted).toContain("删除会话");
    // 而 `Enter` 选中**高亮**那一项 = 打开改名框（此时输入行里装的是那个名字）
    await ui.feed(["\r"]);
    expect(await ui.finish()).toContain("改名：Enter 确认");
  });

  it("⚠️ 右键**手柄那一列**什么都不做（它是「拖宽」，不是一项也不是空白）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), "\r"]);
    // 那一列是侧边栏**最右一列**（`sidebarHandle.x`，1-based +1）
    const handleCol = geometry({
      columns: COLUMNS,
      rows: ROWS,
      sidebarWidth: SIDEBAR_WIDTH,
      sessionCount: 2,
      sessionsTop: 0,
      input: "",
      paletteCount: 0,
      window: false,
      windowRows: 0,
      windowNote: false,
      menu: null,
    }).sidebarHandle!.x + 1;
    await ui.feed([report(2, handleCol, sidebarNameRow(2, 1))]);
    const output = await ui.finish();
    // ⚠️ **两侧都不许发生**：既没弹出菜单（凭空在拖宽那一列上弹一个），也没关掉（那一列与每一项**重叠**）
    expect(output).not.toContain("删除会话");
    expect(output).not.toContain("会话 3");
    expect(output).toContain("会话 1");
    expect(output).toContain("会话 2");
  });

  it("⚠️ **最后一个会话关不掉**：菜单里点「删除会话」给一句瞬时消息，而清单一个字都不变", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    const row = sidebarNameRow(1, 0);
    await ui.feed([report(2, RIGHT_CLICK_COL, row)]);
    const [x, y] = menuItemPoint(row, 0);
    await ui.feed([report(0, x, y)]);
    const output = await ui.finish();
    // ⚠️ **反向自检**：菜单**确实**开过（屏上有那两项）—— 不然「点它没反应」与「菜单压根没开」同形
    expect(output).not.toContain("删除会话");
    expect(output).toContain(LAST_SESSION_REFUSAL);
    expect(output).toContain("会话 1");
    expect(output).not.toContain("会话 2");
  });

  it("⚠️ `Ctrl+X` 关掉**当前**会话（鼠标那一路之外的第二条路）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), "\r"]);
    // ⚠️ `^X` 是 0x18，而 Ink 把 Ctrl 组合的 `key.ctrl` 置位、`pressed` 仍是那个控制字符
    await ui.feed([CTRL_X]);
    const output = await ui.finish();
    expect(output).not.toContain("会话 2");
    expect(output).toContain("会话 1");
    // ⚠️ 关掉当前那个之后切到它**上一个**（留在一个已经不存在的会话上，症状是「输入区还在、命令跑进
    // 一个看不见的会话里」）
    expect(boldRuns(output).some((run) => run.includes("会话 1"))).toBe(true);
  });
});

/* ── 改名框：`/rename`、`Ctrl+R` 与菜单里的「重命名」是**同一个**框 ────────────── */

/** 改名框开着时输入区那一行说的话（只认开头那一截，理由同 {@link LAST_SESSION_REFUSAL}） */
const RENAME_HINT = "改名：Enter 确认";

describe("改名框：打开 → 输字 → 确认 / 取消，**全程键盘**（右键到不了的终端上只留这一条）", () => {
  it("⚠️ `/rename` 打开那个框，框里装的是**它现在的名字**、提示符换成那一枚", async () => {
    const { output } = await renderAndFeed([...typed("/rename"), "\r"], { ledgerFile: ledger() });
    expect(output).toContain(RENAME_HINT);
    // ⚠️ **框里就是当前名字**（不是空串）：改名是「编辑」，而从空串起的话「不改」与「清空」同形
    expect(output).toContain("✎ 会话 1");
    // ⚠️ 而命令面板**不许**被名字里的 `/` 唤起来（那一格里装的是会话名）
    expect(output).not.toContain("列出命令，或给一条命令看用法");
  });

  it("⚠️ 输字 + `Enter` ⇒ 侧边栏上是新名字，而**会话自己的输入行一个字都没丢**", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    // 先在输入行上留半句命令，再按 `Ctrl+R` 开改名框（改名**不碰**输入行，故那半句必须还在）
    await ui.feed([...typed("/sta")]);
    await ui.feed([CTRL_R, "\u007F", "\u007F", "\u007F", "\u007F"]);
    const output = await ui.finish();
    // ⚠️ **反向自检**：框开着（提示那一行在），而输入行上装的是会话名而不是 `/sta`
    expect(output).toContain(RENAME_HINT);
    expect(output).not.toContain("/sta");

    const done = await mount({ interactive: false, ledgerFile: ledger() });
    await done.feed([...typed("/sta"), CTRL_R, "\u007F", "\u007F", "\u007F", "\u007F"]);
    await done.feed(typed("改名了"));
    await done.feed(["\r"]);
    const renamed = await done.finish();
    expect(renamed).toContain("改名了");
    expect(renamed).not.toContain("会话 1");
    // ⚠️ 而改完名之后那一行**回到它自己的半句命令**（不是空的，也不是名字）
    expect(renamed).toContain("/sta");
  });

  it("⚠️ `Esc` 取消 ⇒ 名字没变，而**那个框不见了**", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/rename"), "\r", ...typed("改名了"), "\u001B"]);
    const output = await ui.finish();
    expect(output).not.toContain(RENAME_HINT);
    expect(output).toContain("会话 1");
    expect(output).not.toContain("改名了");
  });

  it("⚠️ `Ctrl+R` 打开**同一个**框（而不是又一个实现）", async () => {
    const { output } = await renderAndFeed([CTRL_R], { ledgerFile: ledger() });
    expect(output).toContain(RENAME_HINT);
    expect(output).toContain("✎ 会话 1");
  });

  it("⚠️ 菜单里的「重命名」打开的也是**同一个**框（作用于那一项，不是当前那一项）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), "\r"]);
    // 右键**第一个**会话（不是当前那个）⇒ 菜单 ⇒ 「重命名」⇒ 框里是**它**的名字
    const row = sidebarNameRow(2, 0);
    await ui.feed([report(2, RIGHT_CLICK_COL, row)]);
    const [x, y] = menuItemPoint(row, 1);
    await ui.feed([report(0, x, y)]);
    expect(await ui.finish()).toContain("✎ 会话 1");
  });

  it("⚠️ 改名框开着时**面板与快捷键都不归它**（`/` 不唤面板、`Ctrl+X` 不删会话）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), "\r", ...typed("/rename"), "\r", "/", CTRL_X]);
    const output = await ui.finish();
    // ⚠️ 敲进去的 `/` 进了**名字**（名字末尾多一个斜杠），而面板没开、当前会话没被删掉
    expect(output).not.toContain("列出命令，或给一条命令看用法");
    expect(output).toContain("会话 1");
    expect(output).toContain("会话 2");
  });

  it("⚠️ 空名字**不认**（框不关，而屏上说了为什么）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/rename"), "\r"]);
    // ⚠️ 「会话 1」四个码元 ⇒ 退格四次才真的空了（少一次就还剩一个字）
    await ui.feed(["\u007F", "\u007F", "\u007F", "\u007F"]);
    await ui.feed(["\r"]);
    const output = await ui.finish();
    expect(output).toContain("名字不能是空的");
    // ⚠️ 而**框还开着**（它没关），屏上仍然说得清「此刻在改名」
    expect(output).toContain(RENAME_HINT);
  });
});

/* ── `/session hide|show`：把会话从侧边栏里藏起来 / 放回来 ──────────────────── */

/** `/session hide|show` 的那一行（⚠️ **名字里有空格要加引号** —— 分词按空白切，不加引号会被判「多给了参数」） */
const hide = (name: string): string[] => [...typed(`/session hide "${name}"`)];
const show = (name: string): string[] => [...typed(`/session show "${name}"`)];

/**
 * 那一帧里**侧边栏那一列**（逐行切出前 {@link SIDEBAR_WIDTH} 个显示列，ANSI 已剥）
 * @description ⚠️ 「侧边栏上有没有它」这种判据**必须**按列切：瞬时消息与命令回显都落在主区，而它们
 * 逐字包含会话名 —— 不切的话「藏起来了」与「屏上还有那个名字」在判据上分不开（实测踩过一次）。
 */
function sidebarOf(output: string): readonly string[] {
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

describe("`/session hide|show`：侧边栏只显示**显示得出来的**那些", () => {
  it("⚠️ 藏起来 ⇒ 侧边栏上**没有它**，而它仍然是个会话（切回去还在）", async () => {
    // ⚠️ 连开两个：藏的必须是**非当前**那一个（藏当前那一个是明确拒绝的，见下一档）
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), "\r", ...typed("/new"), "\r"]);
    await ui.feed([...hide("会话 2"), "\r"]);
    const hidden = sidebarOf(await ui.finish()).join("\n");
    expect(hidden).not.toContain("会话 2");
    expect(hidden).toContain("会话 1");
    expect(hidden).toContain("会话 3");

    // ⚠️ **反向自检**：它**没有被删掉** —— `↑` 切回去时那一项还在（隐藏只是不占侧边栏那一列）
    const back = await mount({ interactive: false, ledgerFile: ledger() });
    await back.feed([
      ...typed("/new"),
      "\r",
      ...typed("/new"),
      "\r",
      ...hide("会话 2"),
      "\r",
      "\u001B[A",
    ]);
    expect(await back.finish()).toContain("会话 2");
  });

  it("⚠️ 放回来 ⇒ 又出现在侧边栏上（同一个会话，不是新建一个）", async () => {
    const hidden = await mount({ interactive: false, ledgerFile: ledger() });
    await hidden.feed([...typed("/new"), "\r", ...typed("/new"), "\r", ...hide("会话 2"), "\r"]);
    const gone = sidebarOf(await hidden.finish()).join("\n");
    // ⚠️ **反向自检**：那一帧**真的有字** —— 非交互档只在 `unmount()` 时写帧，空帧会让上面那条恒真
    expect(gone).toContain("会话 1");
    expect(gone).not.toContain("会话 2");

    // ⚠️ **两趟挂载**而不是「一挂到底」：`finish()` 会 `unmount()`，之后喂的键一个都不进应用，
    // 而「非交互档中途读帧」读到的永远是空串（Ink 只在卸载那一刻写帧）
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), "\r", ...typed("/new"), "\r", ...hide("会话 2"), "\r"]);
    await ui.feed([...show("会话 2"), "\r"]);
    const shown = sidebarOf(await ui.finish()).join("\n");
    expect(shown).toContain("会话 2");
    expect(shown).toContain("live-ok");
  });

  it("⚠️ **当前会话不许藏**（藏了侧边栏上就没有一行说得清「我现在打给谁」）", async () => {
    const { output } = await renderAndFeed([...hide("会话 1"), "\r"], { ledgerFile: ledger() });
    expect(output).toContain("当前会话不能藏");
    expect(output).toContain("会话 1");
  });

  it("⚠️ 没有叫那个名字的会话 ⇒ 说清是谁不认识（而不是静默什么都不发生）", async () => {
    const { output } = await renderAndFeed([...show("查无此人"), "\r"], { ledgerFile: ledger() });
    expect(output).toContain("查无此人");
    expect(output).toContain("会话 1");
  });
});

/* ── 那一枚记号：跑完打勾，**切回来看过就清掉** ─────────────────────────────── */

describe("侧边栏那一枚记号：跑完打勾，切回来看过就清掉", () => {
  it("⚠️ 跑完一条命令 ⇒ 那一项打勾，而**新建出来的那个一个记号都没有**", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/status"), "\r"]);
    expect(stripAnsi(await ui.finish())).toContain("✔ 会话 1");

    // ⚠️ **反向自检**：`/new` 是**在会话 1 里跑的命令** ⇒ 它打完勾，而**新建出来的**那个一个记号都没有
    // （判据是「勾只出现一次」：两个都打勾的实现会让这条恒红，而一个都不打的实现红在前一条上）
    const two = await mount({ interactive: false, ledgerFile: ledger() });
    await two.feed([...typed("/new"), "\r"]);
    const after = stripAnsi(await two.finish());
    expect(after).toContain("✔ 会话 1");
    expect(after).toContain("会话 2");
    expect(after.split("✔")).toHaveLength(2);
  });

  it("⚠️ 切回来看过 ⇒ 那一枚记号**清掉**（它是「你还没看」而不是「它跑过了」）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    // ⚠️ `/new` 与 `/status` 都跑在**会话 1** 里（`/new` 建完会切到会话 2，故 `/status` 落在会话 2）
    await ui.feed([...typed("/new"), "\r", ...typed("/status"), "\r"]);
    expect(stripAnsi(await ui.finish())).toContain("✔ 会话 1");
    // 切回会话 1（`↑`）⇒ 看过 ⇒ **它自己**那一枚清掉；会话 2 的那一枚**留着**（还没看过它）
    const back = await mount({ interactive: false, ledgerFile: ledger() });
    await back.feed([...typed("/new"), "\r", ...typed("/status"), "\r", "\u001B[A"]);
    const seen = stripAnsi(await back.finish());
    expect(seen).not.toContain("✔ 会话 1");
    expect(seen).toContain("✔ 会话 2");
  });
});

/* ── 落盘：建 / 改名 / 显隐 / 关，四件事都进 SQLite ──────────────────────────── */

describe("会话落盘：建、改名、显隐、关，四件事都真的进了 SQLite", () => {
  it("⚠️ 起步那一个**已经在库里**，而 `/new` 追加一行、`Ctrl+X` 把它删掉", async () => {
    const file = ledger();
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed([...typed("/new"), "\r"]);
    await ui.finish();
    // ⚠️ 判据读的是**库里那份**（`readSessions` 另开一次读），而不是内存里那份清单
    expect(readSessions(file).map((one) => one.name)).toEqual(["会话 1", "会话 2"]);

    // ⚠️ **判读盘的那两次都在 `finish()` 之前**：`finish()` 会 `unmount()`，之后喂的键一个都不进应用
    // （而这一档要在**同一个进程**里建一个再关一个：另起一次挂载的话**它会先恢复那两个**，
    //  `Ctrl+X` 关掉的是刚建出来的那一个而不是别的）
    const two = await mount({ interactive: false, ledgerFile: file });
    await two.feed([...typed("/new"), "\r"]);
    // ⚠️ **第二次挂载起手就是两个会话**（启动恢复），故 `/new` 建出来的是**第三个**
    expect(readSessions(file).map((one) => one.name)).toEqual(["会话 1", "会话 2", "会话 3"]);
    await two.feed([CTRL_X]);
    // 而 `Ctrl+X` 关掉**当前**那一个（刚建出来的第三个）⇒ 回到两个
    expect(readSessions(file).map((one) => one.name)).toEqual(["会话 1", "会话 2"]);
    await two.finish();
  });

  it("⚠️ 改名落库，而 `created_at` **不动**（「这个会话有多老」与「叫什么」是两件事）", async () => {
    const file = ledger();
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed([...typed("/rename"), "\r"]);
    // ⚠️ 「会话 1」四个码元 ⇒ 退格**四次**才清空（少一次就还剩一个字，而那个字会进新名字里）
    await ui.feed(["\u007F", "\u007F", "\u007F", "\u007F"]);
    await ui.feed(typed("改名了"));
    await ui.feed(["\r"]);
    await ui.finish();
    const rows = readSessions(file);
    expect(rows.map((one) => one.name)).toEqual(["改名了"]);
    expect(rows[0]?.createdAt).toBeGreaterThan(0);
  });

  it("⚠️ 显隐落库（而 `updated_at` 不动 ——「藏起来」不是「又动了一次」）", async () => {
    const file = ledger();
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed([...typed("/new"), "\r", ...typed("/new"), "\r", ...hide("会话 2"), "\r"]);
    await ui.finish();
    const rows = readSessions(file);
    expect(rows.map((one) => one.visible)).toEqual([true, false, true]);
    expect(rows[1]?.updatedAt).toBe(rows[1]?.createdAt);
  });
});

/* ── 启动恢复：库里那几个就是屏上那几个，而发号**接着库里往下数** ────────────── */

/**
 * 会话启动恢复那一档（`@/AppState.tsx` 的恢复 effect + `@/store` 的 `sessionSeqOf`）
 *
 * @description 落盘是 R3 接的，而**读回来**是这一轮补的：写进去而不读回来，用户每开一次程序就丢一遍
 * 会话清单（而改名与显隐都真的落过盘 ⇒ 台账里攒着一堆屏上从不该出现的名字）。
 * ⚠️ 这一档全部**换挂载**而不是「一挂到底」：`finish()` 会 `unmount()`，之后喂的键一个都不进应用，
 * 而「重开」这件事只能靠另一次挂载造出来。
 * ⚠️ 判据一律读 {@link sidebarOf}（按列切出侧边栏那一列）：瞬时消息与命令回显都落在主区，而它们逐字
 * 包含会话名 —— 不切列的话「恢复出来的那三个」与「屏上还有那个名字」在判据上分不开。
 */
describe("会话启动恢复：库里那几个 → 屏上那几个，而新会话接着库里往下发号", () => {
  it("⚠️ 写 3 个、关掉**第一个** ⇒ 重开屏上是剩下那两个，而 `/new` 拿到的是**会话 4**", async () => {
    const file = ledger();
    const first = await mount({ interactive: false, ledgerFile: file });
    await first.feed([...typed("/new"), "\r", ...typed("/new"), "\r"]);
    // ⚠️ **先把 `s1` 关掉**，于是库里第一行**不是** `s1` —— 这是「当前会话由恢复决定」唯一露得出来
    // 的形状：起手那个 `activeId = "s1"` 在这儿**指着一个不存在的会话**（而 `Layout` 与命中测试读的
    // 正是那个原始值，故症状是「侧边栏上一行都没加粗」）
    await first.feed(["\u001B[A", "\u001B[A", CTRL_X]);
    await first.finish();
    expect(readSessions(file).map((one) => one.name)).toEqual(["会话 2", "会话 3"]);

    const again = await mount({ interactive: false, ledgerFile: file });
    const raw = await again.finish();
    const sidebar = sidebarOf(raw).join("\n");
    expect(sidebar).toContain("会话 2");
    expect(sidebar).toContain("会话 3");
    // ⚠️ **反向自检**：关掉的那一个没回来，而一个都没多造（凭空起一个 ⇒ 每开一次程序多一个）
    expect(sidebar).not.toContain("会话 1");
    expect(sidebar).not.toContain("会话 4");
    // ⚠️ 而**恢复出来的第一个是当前那一个**（加粗是颜色之外的通道；落点判据与 `sidebarOf` 互不替代）
    expect(boldRuns(raw).some((run) => run.includes("会话 2"))).toBe(true);
    expect(boldRuns(raw).some((run) => run.includes("会话 3"))).toBe(false);

    // ⚠️ **核心判据：序号按读回来的最大下标抬起来了** —— 不抬的话 `/new` 插一个库里已有的 `id`，
    // 而插入撞主键是一次「会话说出去了却存不进来」的事故：屏上多一项、库里还是那两行。
    const third = await mount({ interactive: false, ledgerFile: file });
    await third.feed([...typed("/new"), "\r"]);
    const frame = sidebarOf(await third.finish()).join("\n");
    expect(readSessions(file).map((one) => one.name)).toEqual(["会话 2", "会话 3", "会话 4"]);
    expect(frame).toContain("会话 4");
    // ⚠️ **反向自检**：撞 id 的症状就是屏上那一句「没存进台账」，而它只在写失败时出现
    expect(frame).not.toContain("没存进台账");
  });

  it("⚠️ 藏过的那一个重开后**仍藏着**、而它**仍然存在**（`/session show` 放得回来）", async () => {
    const file = ledger();
    const first = await mount({ interactive: false, ledgerFile: file });
    await first.feed([...typed("/new"), "\r", ...typed("/new"), "\r", ...hide("会话 2"), "\r"]);
    await first.finish();
    expect(readSessions(file).map((one) => one.visible)).toEqual([true, false, true]);

    const again = await mount({ interactive: false, ledgerFile: file });
    const sidebar = sidebarOf(await again.finish()).join("\n");
    // ⚠️ 隐藏**不等于**丢弃：它不占侧边栏那一行，可它还得在库里（丢了就再也放不回来）
    expect(sidebar).not.toContain("会话 2");
    expect(sidebar).toContain("会话 1");
    expect(sidebar).toContain("会话 3");
    expect(readSessions(file).map((one) => one.name)).toEqual(["会话 1", "会话 2", "会话 3"]);

    // ⚠️ 而它**放得回来**：那一条命令找得到它 ⇒ 它在恢复之后那份清单里，而不是只剩库里一行
    const back = await mount({ interactive: false, ledgerFile: file });
    await back.feed([...show("会话 2"), "\r"]);
    expect(sidebarOf(await back.finish()).join("\n")).toContain("会话 2");
    expect(readSessions(file).map((one) => one.visible)).toEqual([true, true, true]);
  });

  it("⚠️ 库里一个都没有（首次启动，文件都还不存在）⇒ 造**起步那一个**，而它是 `s1`", async () => {
    const file = emptyLedgerPath();
    // ⚠️ `readSessions` 对**不存在的**库返回空清单且不建库 —— 故这一条钉的是「真的还没有那个文件」
    expect(readSessions(file)).toEqual([]);
    const ui = await mount({ interactive: false, ledgerFile: file });
    const sidebar = sidebarOf(await ui.finish()).join("\n");
    expect(sidebar).toContain("会话 1");
    // ⚠️ **反向自检**：它落进了库里（否则下一次启动恢复读到空清单，这个会话就凭空消失了）
    expect(readSessions(file).map((one) => one.id)).toEqual(["s1"]);
    // ⚠️ 而**只**有那一行（起步那一个不落成两行）
    expect(readSessions(file)).toHaveLength(1);
  });
});

/* ── 侧边栏**永远**有一行：两条同族不变量（关掉的那道闸 + 恢复时的补行） ──────── */

describe("侧边栏永远有一行：关掉与恢复**共用同一条**不变量", () => {
  it("⚠️ **藏到只剩一行时关不掉那一行**（判据是**显示得出来的那几行**，不是清单总数）", async () => {
    // ⚠️ **这就是 R5 修的那个数据丢失**：3 个会话、藏起 2 个之后侧边栏上只有 1 行，
    // 而旧闸门数的是 `sessions.length`（3 > 1）⇒ 关掉那一行 ⇒ 侧边栏空掉、库里那一行也被删了。
    const file = ledger();
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed([...typed("/new"), "\r", ...typed("/new"), "\r"]);
    // ⚠️ **先把当前那个挪到会话 2**（`/new` 两次之后当前是会话 3，而「当前会话不许藏」）
    await ui.feed(["\u001B[A"]);
    await ui.feed([...hide("会话 1"), "\r", ...hide("会话 3"), "\r"]);
    expect(readSessions(file).map((one) => one.visible)).toEqual([false, true, false]);

    // ⚠️ 关**当前**那一行（会话 2 是唯一显示得出来的，而它也是当前那一个）
    await ui.feed([CTRL_X]);
    const raw = await ui.finish();
    const sidebar = sidebarOf(raw).join("\n");
    // ⚠️ **核心判据**：库里那一行**一个字都没变**（旧闸门在这里会把它删掉）
    expect(readSessions(file).map((one) => one.name)).toEqual(["会话 1", "会话 2", "会话 3"]);
    // ⚠️ 而屏上说了为什么（静默拒绝与「这句话改了措辞」在屏上分别是「什么都没有」与「有话」）
    expect(raw).toContain(LAST_SESSION_REFUSAL);
    // ⚠️ **反向自检**：那一行**还在侧边栏上**（关掉了的话这里会空）
    expect(sidebar).toContain("会话 2");
  });

  it("⚠️ 藏到只剩一行时从**菜单**里关也关不掉（那一条是同一个入口）", async () => {
    // ⚠️ `Ctrl+X` 与菜单里的「删除会话」是**同一个 `closeSession`**：只守键盘那一路的话，
    // 鼠标那一路就是一个绕过闸门的洞
    const file = ledger();
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed([...typed("/new"), "\r", ...typed("/new"), "\r"]);
    await ui.feed(["\u001B[A"]);
    await ui.feed([...hide("会话 1"), "\r", ...hide("会话 3"), "\r"]);
    expect(readSessions(file).map((one) => one.visible)).toEqual([false, true, false]);
    const row = sidebarNameRow(1, 0);
    await ui.feed([report(2, RIGHT_CLICK_COL, row)]);
    const [x, y] = menuItemPoint(row, 0);
    await ui.feed([report(0, x, y)]);
    const output = await ui.finish();
    expect(readSessions(file).map((one) => one.name)).toEqual(["会话 1", "会话 2", "会话 3"]);
    expect(output).toContain(LAST_SESSION_REFUSAL);
  });

  it("⚠️ **全隐藏的库重开后侧边栏仍有一行**（恢复时会补出第一行）", async () => {
    // ⚠️ **R4 落地之后才出现的那个洞**：`visible` 落盘了，而恢复**照搬** `visible` ——
    // 于是一个「每一行都被藏起来」的库恢复出**零行**侧边栏：键位全都活着，而没有任何东西
    // 说得清「我现在打给谁」。这条比「关掉唯一那一行」更要命，因为它连一句判据都没有。
    const file = ledger();
    const first = await mount({ interactive: false, ledgerFile: file });
    await first.feed([...typed("/new"), "\r", ...typed("/new"), "\r"]);
    // ⚠️ 用底层那一格把**每一行**都标成藏着（`/session hide` 拒绝藏当前那一个，
    // 而「全隐藏」这个状态只有手改库才造得出来 —— 正是「库被人手改过」那一档）
    for (const id of ["s1", "s2", "s3"]) setSessionVisible(file, id, false);
    await first.finish();
    expect(readSessions(file).every((one) => !one.visible)).toBe(true);

    const again = await mount({ interactive: false, ledgerFile: file });
    const raw = await again.finish();
    const sidebar = sidebarOf(raw).join("\n");
    // ⚠️ **核心判据**：补出来的**第一行**在屏上，而它是当前那一个（加粗是颜色之外的通道）
    expect(sidebar).toContain("会话 1");
    expect(boldRuns(raw).some((run) => run.includes("会话 1"))).toBe(true);
    // ⚠️ 而另外两个**仍然藏着**（补一行 ≠ 全部放出来）
    expect(sidebar).not.toContain("会话 2");
    expect(sidebar).not.toContain("会话 3");
    // ⚠️ **一个字节都没写回去**：这一趟仍是纯读（不写回 ⇒ 下一次启动走的是同一条路，幂等）
    expect(readSessions(file).every((one) => !one.visible)).toBe(true);
  });
});

/* ── 模态窗口：`/managers` 打开，`Esc` 或点右上角那枚 `esc` 关掉 ────────────── */

describe("模态窗口（`/managers`）：Esc 与那枚 esc **是同一条路**", () => {
  const OPEN = ["/", "m", "a", "n", "a", "g", "e", "r", "s", "\r"];

  it("⚠️ `/managers` 浮出一个窗口：逐行给出**链接**与连接状态，右上角一枚 `esc`", async () => {
    const { output } = await renderAndFeed(OPEN, { ledgerFile: ledger() });
    expect(output).toContain("控制面（1）");
    // ⚠️ 链接**在这里**而不在状态行 —— 控制面搬进窗口就是为此
    expect(output).toContain("http://127.0.0.1:1");
    expect(output).toContain("esc");
  });

  it("⚠️ 按 `Esc` 关掉窗口（背后那一块重新可点：点侧边栏能切会话）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed(OPEN);
    await ui.feed(["\u001B"]);
    await ui.feed([report(0, 6, 3)]);
    const output = await ui.finish();
    // 窗口关掉了 ⇒ 它那块（标题带台数的那一行）不见了，而点击重新落到侧边栏上
    expect(output).not.toContain("控制面（1）");
  });

  it("⚠️ 点右上角那枚 `esc` **也**关窗（坐标从几何读，不写死屏幕行号）", async () => {
    const g = geometry({ ...paletteInput(), window: true, windowRows: 1, windowNote: false });
    const chip = g.windowClose!;
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed(OPEN);
    await ui.feed([report(0, chip.x + 2, chip.y + 1)]);
    const output = await ui.finish();
    expect(output).not.toContain("控制面（1）");
  });

  it("⚠️ 窗口是**模态**：背后那几行的点击全被吞掉（点侧边栏不切会话）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), "\r", ...OPEN]);
    // ⚠️ **必须点在真的一项上**（`sidebarNameRow` 而不是屏顶那一行）：点在项间空行上时这一条**恒绿** ——
    // 那一下本来就不切会话，于是「窗口吞掉了点击」与「那一格根本不属于任何一项」在屏上完全一样。
    await ui.feed([report(0, 6, sidebarNameRow(2, 0))]);
    // 点会话 1 那一项（它在窗口底下）⇒ 会话**没有**切回去
    await ui.feed(["\u001B"]);
    const output = await ui.finish();
    expect(output).not.toContain("控制面（1）");
    // ⚠️ **判据是「当前那一项仍然是会话 2」**而不是「屏上有『未选控制面』」：切回会话 1 之后，
    // 会话 2 的**第二行**照样是那一句 —— 于是只看那一句的话，「窗口吞掉了点击」与「点击切了过去」
    // 在屏上完全一样（实测这条恒绿过一次）。
    const bold = boldRuns(output);
    expect(bold.some((run) => run.includes("会话 2"))).toBe(true);
    expect(bold.some((run) => run.includes("会话 1"))).toBe(false);
  });

  it("⚠️ 窗口开着时**键盘也被吞掉**（敲的字一个字都不许进输入行）", async () => {
    const { output } = await renderAndFeed([...OPEN, "s", "t", "a", "t", "u", "s"], {
      ledgerFile: ledger(),
    });
    expect(output).not.toContain("❯ status");
  });

  it("⚠️ `Enter` 把高亮那一台接到**当前会话**上，并关窗", async () => {
    const g = geometry({ ...paletteInput(), window: true, windowRows: 1, windowNote: false });
    const row = g.windowRows[0]!;
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), "\r", ...OPEN]);
    await ui.feed([report(0, row.x + 3, row.y + 1)]);
    await ui.feed(["\r"]);
    const output = await ui.finish();
    expect(output).not.toContain("控制面（1）");
    // 新会话的第二行从「未选控制面」变成了那一台的名字
    expect(output).toContain("live-ok");
  });

  it("⚠️ 台账为空时窗口**仍然开**，并说清怎么加一个（`/managers` 不是一个什么都没发生的动作）", async () => {
    const { output } = await renderAndFeed(OPEN);
    expect(output).toContain("控制面（0）");
    expect(output).toContain("target add");
  });

  // ⚠️ 下面两条守的是**滚轮与悬停**那一半：`down` 早就门禁了，而 `wheelUp` / `wheelDown` /
  // `move` 三条路原先**从不查 `windowKind`** —— 症状是「模态开着时背后那一层照滚照亮」，
  // 而操作者看着一个被遮罩压着的面板，以为滚轮坏了。
  // ⚠️ 判据是**同一份报告的 A/B**：关窗时它确实生效（A ⇒ 尺是真的），开着窗时它一格都不动。
  it("⚠️ 模态开着时**滚轮被吞掉**（背后那一层一格都不动），而关掉窗时同一份报告会滚", async () => {
    const rows = 16;
    const wheel = report(64, 60, 6);
    const options = { rows, ledgerFile: ledger() };
    const scrolled = await renderAndFeed([...typed("/help"), "\r", wheel], options);
    const still = await renderAndFeed([...typed("/help"), "\r", ...OPEN], options);
    const held = await renderAndFeed([...typed("/help"), "\r", ...OPEN, wheel], options);
    // ⚠️ **正向对照（尺是真的）**：关窗时那一滚**确实**动了 —— `help` 那张表在 16 行的屏上装不下，
    // 而 `clampTop` 允许往下滚 ⇒ 判据落在真会动的档上（表 21 行而视口 10 行）
    expect(scrolled.output).not.toBe(still.output);
    // 而模态开着时那一滚**逐字节相同**（不是「看起来没动」：背后那一层一格都不许动）
    expect(held.output).toBe(still.output);
    expect(held.output).toContain("控制面（1）");
  });

  it("⚠️ 模态开着时**指针移过侧边栏不换 hover**（悬停那一路也归门禁，字节数是判据）", async () => {
    const ui = await mount({ interactive: true, color: true, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), "\r"]);
    // ⚠️ **尺是真的**：关窗时同一条 `move` 报告**确实**换掉悬停并写了一整帧
    const before = ui.bytes();
    await ui.feed([report(35, 6, sidebarNameRow(2, 0))]);
    const hoverFrame = ui.bytes() - before;
    await ui.feed([report(35, 6, sidebarNameRow(2, 1))]);
    expect(hoverFrame).toBeGreaterThan(1024);
    await ui.feed(OPEN);
    const settled = ui.bytes();
    const chip = geometry({ ...paletteInput(), window: true, windowRows: 1 }).windowClose!;
    // 而窗口开着时指回**第一项**、再指到右上角那枚 `esc` 上：门禁在 ⇒ `hoveredId` 不变且那一枚
    // **没有悬停态** ⇒ React 一个状态都不改 ⇒ 零字节（⚠️ 那一枚的矩形从几何读，不写死屏幕列号）
    await ui.feed([report(35, 6, sidebarNameRow(2, 0)), report(35, chip.x + 1, chip.y + 1)]);
    const afterHover = ui.bytes() - settled;
    await ui.finish();
    expect(ui.mouseEvents.map((one) => one.action)).toContain("move");
    expect(afterHover).toBe(0);
  });
});

/* ── 拖宽：按在侧边栏最右那一列上左右拖 ─────────────────────────────────── */

describe("拖宽侧边栏：按在最右那一列上", () => {
  /** 拖宽手柄那一列的 SGR 列号（**1-based**；从缺省宽度算，故侧边栏变宽时它跟着走） */
  const HANDLE_COL = SIDEBAR_WIDTH;

  it("⚠️ 拖一下 ⇒ 主区往右挪（输入框的左边跟着挪）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    // 先按在最右那一列（第 {@link HANDLE_COL} 列，1-based），再往右拖 8 列
    await ui.feed([report(0, HANDLE_COL, 10), report(32, HANDLE_COL + 8, 10)]);
    const output = await ui.finish();
    const frame = output.split("\n").find((line) => line.includes("╭") && line.includes("─"));
    expect(frame).toBeDefined();
    // 缺省侧边栏宽 + 1 列间隔 ⇒ 框从第 33 列起；拖 8 列之后是第 41 列
    expect(displayColumnOf(frame ?? "", "╭")).toBe(HANDLE_COL + 1 + 8);
  });

  it("⚠️ 拖到最宽也**给主区留着**够用的宽度（不会把主区挤没）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([report(0, HANDLE_COL, 10), report(32, 100, 10)]);
    const output = await ui.finish();
    const frame = output.split("\n").find((line) => line.includes("╭") && line.includes("─"));
    expect(frame).toBeDefined();
    const at = displayColumnOf(frame ?? "", "╭");
    // 上界是「屏宽 − 间隔 − 主区至少那几列」（`sidebarWidthBounds`）
    expect(COLUMNS - at).toBeGreaterThanOrEqual(34);
  });

  it("⚠️ 按在最右那一列上**不会**顺手切会话（手柄先判：它与那一项重叠）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), "\r"]);
    await ui.feed([report(0, HANDLE_COL, 1)]);
    const output = await ui.finish();
    // 会话 2 仍然是当前那一项 ⇒ 它的第二行是「未选控制面」而不是 `live-ok`
    expect(output).toContain("未选控制面");
  });

  it("⚠️ 不在手柄上的 `drag` 留给终端（拖选文本必须还能用）", async () => {
    const ui = await mount({ interactive: true, ledgerFile: ledger() });
    const settled = ui.bytes();
    // 在主区里按着拖：那一路**不许**改任何状态
    await ui.feed([report(0, 60, 10), report(32, 66, 10)]);
    const after = ui.bytes() - settled;
    await ui.feed(["a"]);
    await ui.finish();
    expect(ui.mouseEvents.map((one) => one.action)).toEqual(["down", "drag"]);
    // 而那次 `down` 在主区 ⇒ 它本来就是「什么都不做」
    expect(after).toBeLessThan(1000);
  });
});

/**
 * 那一帧里所有**加粗**的片段
 * @description ⚠️ 逐字符扫而**不是**一条正则：判据里出现 ESC 字面量会触发本包的
 * `no-control-regex`，而给测试档开一条 `eslint-disable` 等于让那条纪律从此不再被看见
 * （与 {@link stripAnsi} 同一条纪律）。⚠️ 它答的是「**哪几段是加粗的**」而不是
 * 「有没有加粗」—— 插入符那一格也是加粗的，于是「开没开」在这类帧上恒为真。
 */
function boldRuns(output: string): readonly string[] {
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
function typed(word: string): string[] {
  return [...word];
}

/* ── 改窗口大小：Ink 自己重排的是**上一帧**，应用必须按新的高宽重排一帧新的 ─────── */

/**
 * 那一帧的**几何锚点**：输入区上边框那一行的显示列 / 行号 / 整行宽
 * @description ⚠️ 三个数**全部从 {@link geometry} 取**，不写死 —— 写死的后果是「几何一改、断言还绿」
 * 那种假绿（与 {@link paletteRowY} 同一条纪律）。⚠️ 宽度那一项量的是**整行**（含左边那 23 列侧边栏
 * 与间隔列），而它恰好等于 `g.columns`：Ink 把每一行补齐到根盒子的宽度，本包又保证没有一行超宽。
 */
function anchorOf(frame: readonly string[]): {
  readonly column: number;
  readonly row: number;
  readonly width: number;
} {
  const row = frame.findIndex(
    (one) => stripAnsi(one).includes("╭") && stripAnsi(one).includes("─"),
  );
  if (row < 0) {
    throw new Error(`这一帧里没有输入区的上边框：${JSON.stringify(frame.join("\n").slice(-240))}`);
  }
  const border = frame[row] as string;
  return { column: displayColumnOf(border, "╭"), row, width: widthOf(stripAnsi(border)) };
}

/** 某个尺寸下几何说输入区的上边框落在哪（**期望值**从纯函数取，不从实现取） */
function anchorAt(columns: number, rows: number): {
  readonly column: number;
  readonly row: number;
  readonly width: number;
} {
  const g = geometry({
    columns,
    rows,
    sidebarWidth: SIDEBAR_WIDTH,
    sessionCount: 1,
    sessionsTop: 0,
    input: "",
    paletteCount: 0,
    window: false,
    windowRows: 0,
    windowNote: false,
    menu: null,
  });
  return { column: g.input!.x, row: g.input!.y, width: g.input!.x + g.input!.width };
}

/**
 * 字节流里**末尾那一帧**（debug 档每一帧都是整帧写出来的，故从尾数行就切得出来）
 * @description ⚠️ 切的是**剥掉 ANSI 之后**的文本行。⚠️ 而帧与帧之间**不补换行**（实测 ink 7.1.1），
 * 于是一帧的末行与下一帧的首行粘在同一个物理行上 —— 故**末帧**按 `slice(-rows)` 切、**首帧**按
 * `slice(0, rows)` 切，两头都恰好是**整帧**，那处粘行只在肉眼看日志时存在。
 */
function lastFrame(raw: string, rows: number): readonly string[] {
  return stripAnsi(raw).split("\n").slice(-rows);
}

/** {@link lastFrame} 的首帧那一头（挂载那一帧，形状是**初始快照**那份） */
function firstFrame(raw: string, rows: number): readonly string[] {
  return stripAnsi(raw).split("\n").slice(0, rows);
}

describe("改窗口大小：应用按新的高宽重排（Ink 自己重排的是上一帧，它修不好）", () => {
  const WIDE = 120;
  const TALL = 40;

  it("⚠️ 拉宽拉高 ⇒ 末尾那一帧落在几何说的新位置，而**首帧**仍是初始快照那个位置", async () => {
    const ui = await mount({ interactive: true, debug: true, ledgerFile: ledger() });
    await ui.resize(WIDE, TALL);
    const raw = await ui.finish();

    // ⚠️ **正向对照**：首帧（挂载那一帧）是**初始快照**那个尺寸 —— 它证明尺是真的，也证明那不是
    // 「什么都没渲染」（空屏量不出锚点：那一行上根本没有 `╭`）。
    expect(anchorOf(firstFrame(raw, ROWS))).toEqual(anchorAt(COLUMNS, ROWS));
    // ⚠️ 而末尾那一帧（**resize 之后**重排的那一帧）已经按新尺寸重排过
    expect(anchorOf(lastFrame(raw, TALL))).toEqual(anchorAt(WIDE, TALL));
    // ⚠️ 两个期望值**不是同一个数**：否则「末尾那一帧其实还是初始那一帧」会与上面那条一起绿
    expect(anchorAt(WIDE, TALL)).not.toEqual(anchorAt(COLUMNS, ROWS));
  });

  it("⚠️ 拉窄到侧边栏画不出来 ⇒ 那一帧**真的**没有侧边栏（宽度过 `MIN_TERMINAL_COLUMNS`）", async () => {
    // ⚠️ 这一档才是用户看得见的那个 bug：宽度**变窄**时 Ink 先 `log.clear()`（清屏），再把它手里那
    // 一份**旧布局**整帧重画上去 —— 没有订阅 `resize` 时屏上就停在这一帧，永不修复。
    const narrow = MIN_TERMINAL_COLUMNS - 10;
    const ui = await mount({ interactive: true, debug: true, ledgerFile: ledger() });
    await ui.resize(narrow, ROWS);
    const raw = await ui.finish();

    const frame = lastFrame(raw, ROWS);
    expect(anchorOf(frame)).toEqual(anchorAt(narrow, ROWS));
    // ⚠️ 侧边栏整个让位：`会话 1` 只画在侧边栏上，而引导屏那句话里没有它
    expect(frame.join("\n")).not.toContain("会话 1");
    // ⚠️ 而首帧里它在 —— 于是上面那条不是「这一档压根没画会话」造成的
    expect(firstFrame(raw, ROWS).join("\n")).toContain("会话 1");
  });

  it("⚠️ resize 报上来一个**不可用**的尺寸 ⇒ 回到组合根那份快照（不是 0，也不是 `undefined`）", async () => {
    const ui = await mount({ interactive: true, debug: true, ledgerFile: ledger() });
    // ⚠️ `columns` / `rows` 是 `tty.WriteStream` 才有的字段，故「事件到了而字段没有」这个组合要能造：
    // 几何层拿到 `undefined` 是整屏 `NaN`、拿到 0 是画不出主区 —— 而那两条都不是「组合根说过的话」。
    await ui.resize(undefined, undefined);
    const raw = await ui.finish();
    expect(anchorOf(lastFrame(raw, ROWS))).toEqual(anchorAt(COLUMNS, ROWS));
    // ⚠️ 这一条在「事件根本没被消费」的实现下**也**绿（两种情况下屏上都是初始快照那一帧）——
    // 它锁的是**兜底那一句**，与同档那两条互补；变异记录写在本文件文件头。
  });
});

/* ── 一句聊天消息走模型：助手那一句必须指向**真的在屏上**的那几行 ────────────── */

/** 两个控制面 + 一个配好的 provider（⚠️ `/batch all` 要 N ≥ 2 才验得出「N 份结果」与那一句汇总） */
function chatLedger(): string {
  const file = join(mkdtempSync(join(tmpdir(), "swain-tui-input-")), "tui.db");
  writeLedger(file, {
    version: 1,
    selected: "prod",
    targets: [
      { id: "prod", name: "prod", baseUrl: "http://127.0.0.1:1", token: "t0ken", timeoutMs: 200 },
      { id: "stage", name: "stage", baseUrl: "http://127.0.0.1:2", token: "t0ken", timeoutMs: 200 },
    ],
  });
  writeProvider(file, { baseUrl: "https://provider.invalid/v1", model: "m", apiKey: "sk-x" });
  return file;
}

/** 六份名单全空的一份 acl 响应体（三组 × 白/黑 ⇒ `aclRows` 落成一句「六份名单都是空的」） */
const EMPTY_ACL = {
  acl: {
    clientIp: { whitelist: [], blacklist: [] },
    target: { whitelist: [], blacklist: [] },
    upstream: { whitelist: [], blacklist: [] },
  },
};

/**
 * 模型那一头假答一条 `/batch`，控制面那一头假答一份空 acl
 * @description ⚠️ **按 URL 分流**而不是「第一个请求给模型」：本包有**两个**拨号点，而探活也在发请求
 * （`clientFor` 造客户端那一档），故「按次数猜」在探活先跑时会整个错位。
 */
function stubTwoDialPoints(): () => void {
  const stub = vi.fn(async (input: unknown) => {
    const url = String(input);
    const body = url.includes("/chat/completions")
      ? { choices: [{ message: { content: "/batch all /acl" } }] }
      : EMPTY_ACL;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
  vi.stubGlobal("fetch", stub);
  return (): void => {
    vi.unstubAllGlobals();
  };
}

describe("一句聊天消息 → 模型挑 `/batch`：屏上顺序与那一句话对得上事实", () => {
  it("⚠️ 用户消息 → **助手那一句** → N 份结果 + 汇总（那一句说「下面」，而结果真的在下面）", async () => {
    const restore = stubTwoDialPoints();
    try {
      const ui = await mount({ interactive: false, ledgerFile: chatLedger() });
      await ui.feed([...typed("把名单发给所有控制面"), "\r"]);
      // ⚠️ 这一圈要**往返 + 扇出**（fetch → exec → applyEffect → fanOut → push），而 `feed` 的等待量按一个键算
      await new Promise((resolve) => setTimeout(resolve, 500));
      const output = stripAnsi(await ui.finish());

      /** 屏上那一句话的位置（⚠️ 找不到就直接红并报出缺哪一句 —— 顺序断言在缺件时会给出假绿） */
      const at = (needle: string): number => {
        const where = output.indexOf(needle);
        expect(where, `屏上没有「${needle}」`).toBeGreaterThanOrEqual(0);
        return where;
      };
      const marks = [
        at("❯ 把名单发给所有控制面"),
        at("在下面几行"),
        at("prod · /acl"),
        at("stage · /acl"),
        at("2 台全部成功"),
      ];
      // ⚠️ **逐段递增**才是判据：只断言「四句都在」的话，顺序整个反过来也照样绿
      expect(marks).toEqual([...marks].sort((a, b) => a - b));
      // ⚠️ 而**助手那一行本身**不许转述对面返回的数据（对面这一档给的是「六份名单都是空的」；
      // 那一行里它一个字都不许有 —— 而它作为 N 份结果**逐台**出现在下面是对的）
      const assistantLine = output.split("\n").find((one) => one.includes("在下面几行")) ?? "";
      expect(assistantLine).not.toContain("六份名单");
      // ⚠️ **正向对照**：那份数据确实在屏上（否则上面那条是「对面根本没答上」造成的假绿）
      expect(output).toContain("六份名单都是空的");
    } finally {
      restore();
    }
  });
});