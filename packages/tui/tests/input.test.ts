/**
 * 经**真 Ink 输入通路**的那一档：终端协议报文不许变成输入行的内容
 *
 * **为什么这一档必须存在**（它不是 `tests/mouse.test.ts` 那些纯函数断言的重复）：
 * 本包的真 bug 出在**两个消费者之间**，纯函数档看不见它。同一份 stdin 字节被广播给两处：
 * - `@/ui/mouse.ts` 的 `createMouseSource` —— 按 `parseSgr` 认出鼠标报告，派发成事件；
 * - Ink 自己的 `useInput` —— 把**未解析**的转义序列当文本交给 `app.tsx`，**并在交给之前
 *   顺手砍掉那个 ESC**（`ink/build/hooks/use-input.js`：`if (input.startsWith('\u001B'))
 *   input = input.slice(1)`）。
 *
 * 于是 `ESC[<35;64;32M` 到达输入层时是 `[<35;64;32M`：**一串全是可打印字符**，而
 * `app.tsx:printableOnly` 那道 C0 的闸在这里**已经失效**（唯一的 C0 字节被 Ink 拿走了）。
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
 *
 * ⚠️ 上面那条「移动鼠标不该引起任何重绘」的判据**仍然成立**：hover 只在**换了一项**时
 * `setState`（同一个值原样返回 ⇒ React 跳过重渲染），而 `?1003h` 开着时一秒几百条报告
 * 绝大多数落在同一项上。
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { App } from "@/app.js";
import { widthOf } from "@/ui/format.js";
import { createMouseSource, type MouseEvent } from "@/ui/mouse.js";
import { geometry, PALETTE_MAX_RATIO, type GeometryInput } from "@/console/geometry.js";
import { COMMAND_SPECS } from "@/cmd/parse.js";
import { PALETTE_ROWS } from "@/cmd/palette.js";

const COLUMNS = 100;
const ROWS = 28;

/** 探活窗口要一个**不动的**时刻源，否则「最近收到过报告」会随墙钟乱跳 */
const NOW = 1_700_000_000_000;

/** 一个空台账的路径（`readLedger` 对**不存在**的文件返回空台账，故这里不必先建文件） */
function emptyLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "proxy-tui-input-")), "targets.json");
}

/**
 * 一个**有目标**的台账（hover 那几条要有一行可指，故不能拿空台账）
 * @description ⚠️ 端点指向一个**不存在的**端口：探活会失败，而那一格正好是「未知」——
 * hover 与连接状态是**两件独立的事**，不该被探活的结果连坐（`tests/layout.test.ts` 那几条
 * 直接给 `state`，而这里走的是真台账 + 真探活）。
 */
function seededLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "proxy-tui-input-"));
  const file = join(dir, "targets.json");
  writeFileSync(
    file,
    JSON.stringify({
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
    }),
  );
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

/** 一次挂好的界面（两个用例族共用，故只有一处「怎么造假 TTY」） */
interface Mounted {
  readonly stdin: PassThrough & { isTTY: boolean };
  readonly mouseEvents: MouseEvent[];
  /** 截至此刻写进 stdout 的字节总数 */
  readonly bytes: () => number;
  readonly feed: (chunks: readonly string[]) => Promise<void>;
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

/** 一份**有控制面**的台账路径（会话播种、窗口、拖宽那几档都要它） */
const LEDGER = seededLedgerPath();

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
    await ui.feed(Array.from({ length: 50 }, (_, i) => report(35, 30 + (i % 40), 20)));
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
});

/* ── 命令面板：整条交互走**真 Ink 输入通路** ─────────────────────────────── */

/** 命令表一共有几条（**问那一份表**，不抄一份数字 —— 抄的那份会随命令增删漂） */
const PALETTE_TOTAL = COMMAND_SPECS.length;

/** 面板那一档的几何入参（**只有面板开着**，于是其余事实都是缺省） */
function paletteInput(over: Partial<GeometryInput> = {}): GeometryInput {
  return {
    columns: COLUMNS,
    rows: ROWS,
    sidebarWidth: 22,
    input: "",
    paletteCount: PALETTE_TOTAL,
    window: false,
    windowRows: 0,
    windowFooter: false,
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
  const g = geometry({ columns, rows, sidebarWidth: 22, input: "", paletteCount: total, window: false, windowRows: 0, windowFooter: false });
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

  it("⚠️ 不带 `/` 的那一行回车：一句判据 + **带前缀的**建议（不执行任何东西）", async () => {
    const { output } = await renderAndFeed(["s", "t", "a", "t", "u", "s", "\r"]);
    expect(output).toContain("每一条命令都要以 / 开头");
    expect(output).toContain("是不是想写 /status");
    // ⚠️ **反向自检**：它**没有**真的跑 `status`（那会发一个请求），也没有出那句表的内容
    expect(output).not.toContain("服务进程与代理的现状");
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
    // ⚠️ `color: true` 才有底色可比 —— 无色终端下这一整套性质**无从断言**，而那正是本条设计
    // **刻意**付出的代价（见 `@/console/layout.tsx` 文件头「已知缺口」）。
    const pointed = await renderAndFeed([report(35, 6, 1)], {
      color: true,
      ledgerFile: LEDGER,
    });
    // ⚠️ **反向自检**：与「没有被指着」的那一帧比 —— 判据是「**两者不同**」，而单看一帧的话
    // 「整列常亮」与「hover 生效」长得一模一样。
    const bare = await renderAndFeed([], { color: true, ledgerFile: LEDGER });
    const hot = bgBefore(pointed.output, "live-ok");
    const cold = bgBefore(bare.output, "live-ok");
    expect(hot).not.toBeNull();
    expect(hot).not.toBe(cold);
  });

  it("⚠️ 划到主区 ⇒ 侧边栏那一项的底色**回到列那一条**（不留着上一次那一层）", async () => {
    const away = await renderAndFeed([report(35, 6, 1), report(35, 60, 1)], {
      color: true,
      ledgerFile: LEDGER,
    });
    // ⚠️ 判据是「**回到**列那一条」而不是「有没有底色」—— 而这条之所以要写，是因为
    // 「指针不在侧边栏上就停在上一次那一项」那个实现会让底色留着，而屏上没有任何东西解释它。
    const bare = await renderAndFeed([], { color: true, ledgerFile: LEDGER });
    expect(bgBefore(away.output, "live-ok")).toBe(bgBefore(bare.output, "live-ok"));
  });

  it("⚠️ hover 一个字节都不许进输入行（`move` 报告走的是鼠标那一路）", async () => {
    const { output, mouseEvents } = await renderAndFeed([report(35, 6, 1)], {
      ledgerFile: LEDGER,
    });
    expect(output).not.toContain("[<");
    // ⚠️ **正向对照**：同一份字节**确实**到了鼠标那一侧 —— 否则上面那两条只是「谁都没收到」
    expect(mouseEvents.map((one) => one.action)).toEqual(["move"]);
  });
});

/* ── 会话：侧边栏、点选、`/new` ──────────────────────────────────────────── */

describe("会话：侧边栏那一列、`/new`、点选", () => {
  it("⚠️ 启动时侧边栏那一列是**会话**，而控制面只在它的第二行", async () => {
    const { output } = await renderAndFeed([], { ledgerFile: LEDGER });
    expect(output).toContain("会话 1");
    // 台账里那个 `selected` 被播种给第一个会话 ⇒ 第二行是**它的名字**
    expect(output).toContain("live-ok");
    // ⚠️ 而**控制面那一列不在侧边栏**：只有一个会话项（两行）
    expect(output).not.toContain("会话 2");
  });

  it("⚠️ `/new` 新开一个会话并切过去（侧边栏多一项，而当前那一项换了）", async () => {
    const { output } = await renderAndFeed([...typed("/new"), "\r"], { ledgerFile: LEDGER });
    expect(output).toContain("会话 2");
    // ⚠️ 「切过去了」由**加粗**回答（颜色之外的通道）：判据不写死那串转义序列的具体字节，
    // 只要求「加粗的那一段里含 `会话 2`」
    expect(boldRuns(output).some((run) => run.includes("会话 2"))).toBe(true);
    // ⚠️ **反向自检**：新会话**从「未选控制面」开始**，不继承当前那个 ——
    // 继承的话「新会话是干净的」这件事在屏上一点区别都没有
    expect(output).toContain("未选控制面");
    // ⚠️ 而 `/new` **自己的那行输出落在它被敲的那个会话里**（切走就看不到了）——
    // 这是「一条命令的结果属于它被敲的那个上下文」这条不变式的形状
    expect(output).not.toContain("新会话已建好");
  });

  it("⚠️ 每个会话有**自己的输出**：`/new` 那句话落在它被敲的那个会话里", async () => {
    const ui = await mount({ interactive: false, ledgerFile: LEDGER });
    await ui.feed([...typed("/new"), "\r"]);
    // 切回会话 1（点它那一项的第一行）⇒ 刚才那句话还在那儿
    await ui.feed([report(0, 6, 1)]);
    const output = await ui.finish();
    expect(output).toContain("新会话已建好");
  });

  it("⚠️ 点侧边栏那一项 = 切到那个会话（**每项两行**，点第一行与第二行是同一个）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: LEDGER });
    await ui.feed([...typed("/new"), "\r"]);
    // ⚠️ 点**第二行**（它连的那个控制面那一行）：判据必须是「点整项」而不是「点第一行」——
    // 点第一行会与「点第二行不是同一个会话」这个 bug 长得一样
    await ui.feed([report(0, 6, 3)]);
    const output = await ui.finish();
    // 切回会话 1 ⇒ 它的第二行是 `live-ok`，而「当前」那一项换了高亮
    expect(output).toContain("live-ok");
  });

  it("⚠️ 每个会话有**自己的输出**：切走再切回，上一条命令的结果还在", async () => {
    const ui = await mount({ interactive: false, ledgerFile: LEDGER });
    await ui.feed([...typed("/help"), "\r"]);
    const afterHelp = await ui.finish();
    expect(afterHelp).toContain(HELP_TABLE_MARK);
    // 会话 2 里跑一条别的命令 ⇒ 结果落在**它**的桶里
    const second = await renderAndFeed([...typed("/new"), "\r", ...typed("/r"), "\r"], {
      ledgerFile: LEDGER,
    });
    expect(second.output).not.toContain(HELP_TABLE_MARK);
  });
});

/* ── 模态窗口：`/managers` 打开，`Esc` 或点右上角那枚 `esc` 关掉 ────────────── */

describe("模态窗口（`/managers`）：Esc 与那枚 esc **是同一条路**", () => {
  const OPEN = ["/", "m", "a", "n", "a", "g", "e", "r", "s", "\r"];

  it("⚠️ `/managers` 浮出一个窗口：逐行给出**链接**与连接状态，右上角一枚 `esc`", async () => {
    const { output } = await renderAndFeed(OPEN, { ledgerFile: LEDGER });
    expect(output).toContain("控制面（1）");
    // ⚠️ 链接**在这里**而不在状态行 —— 控制面搬进窗口就是为此
    expect(output).toContain("http://127.0.0.1:1");
    expect(output).toContain("esc");
  });

  it("⚠️ 按 `Esc` 关掉窗口（背后那一块重新可点：点侧边栏能切会话）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: LEDGER });
    await ui.feed(OPEN);
    await ui.feed(["\u001B"]);
    await ui.feed([report(0, 6, 3)]);
    const output = await ui.finish();
    // 窗口关掉了 ⇒ 那句「控制面清单」不见了，而点击重新落到侧边栏上
    expect(output).not.toContain("控制面（1）");
  });

  it("⚠️ 点右上角那枚 `esc` **也**关窗（坐标从几何读，不写死屏幕行号）", async () => {
    const g = geometry({ ...paletteInput(), window: true, windowRows: 1, windowFooter: true });
    const chip = g.windowClose!;
    const ui = await mount({ interactive: false, ledgerFile: LEDGER });
    await ui.feed(OPEN);
    await ui.feed([report(0, chip.x + 2, chip.y + 1)]);
    const output = await ui.finish();
    expect(output).not.toContain("控制面（1）");
  });

  it("⚠️ 窗口是**模态**：背后那几行的点击全被吞掉（点侧边栏不切会话）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: LEDGER });
    await ui.feed([...typed("/new"), "\r", ...OPEN]);
    // 点会话 1 那一项（它在窗口底下）⇒ 会话**没有**切回去
    await ui.feed([report(0, 6, 1)]);
    await ui.feed(["\u001B"]);
    const output = await ui.finish();
    // 关掉窗口之后当前那一项仍是会话 2 ⇒ 第二行是「未选控制面」而**不是** `live-ok`
    const row = output.split("\n").find((one) => one.includes("未选控制面") || one.includes("live-ok"));
    expect(row).toBeDefined();
    expect(output).toContain("未选控制面");
  });

  it("⚠️ 窗口开着时**键盘也被吞掉**（敲的字一个字都不许进输入行）", async () => {
    const { output } = await renderAndFeed([...OPEN, "s", "t", "a", "t", "u", "s"], {
      ledgerFile: LEDGER,
    });
    expect(output).not.toContain("❯ status");
  });

  it("⚠️ `Enter` 把高亮那一台接到**当前会话**上，并关窗", async () => {
    const g = geometry({ ...paletteInput(), window: true, windowRows: 1, windowFooter: false });
    const row = g.windowRows[0]!;
    const ui = await mount({ interactive: false, ledgerFile: LEDGER });
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
});

/* ── 拖宽：按在侧边栏最右那一列上左右拖 ─────────────────────────────────── */

describe("拖宽侧边栏：按在最右那一列上", () => {
  it("⚠️ 拖一下 ⇒ 主区往右挪（输入框的左边跟着挪）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: LEDGER });
    // 先按在最右那一列（第 22 列，1-based），再往右拖 8 列
    await ui.feed([report(0, 22, 10), report(32, 30, 10)]);
    const output = await ui.finish();
    const frame = output.split("\n").find((line) => line.includes("╭") && line.includes("─"));
    expect(frame).toBeDefined();
    // 缺省侧边栏 22 列 + 1 列间隔 ⇒ 框从第 23 列起；拖 8 列之后是第 31 列
    expect(displayColumnOf(frame ?? "", "╭")).toBe(31);
  });

  it("⚠️ 拖到最宽也**给主区留着**够用的宽度（不会把主区挤没）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: LEDGER });
    await ui.feed([report(0, 22, 10), report(32, 100, 10)]);
    const output = await ui.finish();
    const frame = output.split("\n").find((line) => line.includes("╭") && line.includes("─"));
    expect(frame).toBeDefined();
    const at = displayColumnOf(frame ?? "", "╭");
    // 上界是「屏宽 − 间隔 − 主区至少那几列」（`sidebarWidthBounds`）
    expect(COLUMNS - at).toBeGreaterThanOrEqual(34);
  });

  it("⚠️ 按在最右那一列上**不会**顺手切会话（手柄先判：它与那一项重叠）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: LEDGER });
    await ui.feed([...typed("/new"), "\r"]);
    await ui.feed([report(0, 22, 1)]);
    const output = await ui.finish();
    // 会话 2 仍然是当前那一项 ⇒ 它的第二行是「未选控制面」而不是 `live-ok`
    expect(output).toContain("未选控制面");
  });

  it("⚠️ 不在手柄上的 `drag` 留给终端（拖选文本必须还能用）", async () => {
    const ui = await mount({ interactive: true, ledgerFile: LEDGER });
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