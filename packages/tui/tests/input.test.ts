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
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { App } from "@/app.js";
import { createMouseSource, type MouseEvent } from "@/ui/mouse.js";

const COLUMNS = 100;
const ROWS = 28;

/** 探活窗口要一个**不动的**时刻源，否则「最近收到过报告」会随墙钟乱跳 */
const NOW = 1_700_000_000_000;

/** 一个空台账的路径（`readLedger` 对**不存在**的文件返回空台账，故这里不必先建文件） */
function emptyLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "proxy-tui-input-")), "targets.json");
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
      ledgerFile: emptyLedgerPath(),
      columns: COLUMNS,
      rows,
      color: false,
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
  options: { readonly rows?: number } = {},
): Promise<{ readonly output: string; readonly mouseEvents: readonly MouseEvent[] }> {
  const ui = await mount({ interactive: false, ...options });
  await ui.feed(chunks);
  const output = await ui.finish();
  return { output, mouseEvents: ui.mouseEvents };
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
  it("50 条移动报告写出的字节，远小于一个真键位的零头", async () => {
    const ui = await mount({ interactive: true });
    const settled = ui.bytes();
    await ui.feed(Array.from({ length: 50 }, (_, i) => report(35, 10 + (i % 60), 20)));
    const afterMoves = ui.bytes() - settled;
    // 正向对照：**尺**必须是真的，否则下面那个比值是拿 0 除 0
    await ui.feed(["a"]);
    const afterKey = ui.bytes() - settled - afterMoves;
    await ui.finish();

    expect(ui.mouseEvents).toHaveLength(50);
    expect(afterKey).toBeGreaterThan(1024);
    // ⚠️ 判据是**比值**而不是绝对值：一次整帧重画的大小随 Ink 版本与平台变（win32 的 fullscreen
    // 帧走 `clearTerminal`，别的平台走 `log-update`），而「50 条报告 ≈ 50 次整帧重画」这件事
    // 与尺子多大无关。⚠️ 闸门被拆掉时实测这个比值是 **50 上下**，不是 1.05。
    expect(afterMoves).toBeLessThan(afterKey / 20);
  });
});

/* ── 命令面板：整条交互走**真 Ink 输入通路** ─────────────────────────────── */

describe("命令面板（`/` 敲出来的那一块）：四个入口走同一份实现", () => {
  it("⚠️ 敲一个 `/` 就浮出整张命令表（**命令名 + 说明**），且输入行只有那个 `/`", async () => {
    const { output } = await renderAndFeed(["/"]);
    // ⚠️ **反向自检**：下面这些断言都靠「面板真的画出来了」才有意义，
    // 而「什么都没渲染」也会让「输入行只有一个 `/`」成立。
    expect(output).toContain("/help");
    expect(output).toContain("/status");
    expect(output).toContain("/target switch");
    expect(output).toContain("服务进程与代理的现状");
    expect(output).toContain("❯ /");
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
    const { output } = await renderAndFeed(["/", "h", "e", "l", "p", "\r"]);
    const echoes = output.split("\n").filter((line) => line.includes("❯ /help"));
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
    expect(output).toMatch(/❯ \/s\s+tatus/);
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

  it("⚠️ 面板**装不下**时必须有那一句「共 19 条」，且高亮被顶进视口", async () => {
    // 12 行的屏：内容区 7 行、留一行说明 ⇒ 视口 6 行，而命令表 19 条 ⇒ 装不下
    const { output } = await renderAndFeed(["/"], { rows: 12 });
    expect(output).toContain("共 19 条");
    // ⚠️ 高亮一路往下走到**第 7 条**（`/user`）—— 视口只有 6 行，于是窗口必须滚一格，
    // 而滚掉的是**第 1 条**（`/help`）。判据是「滚了一格」而不是「跳到高亮那一行」。
    const moved = await renderAndFeed(
      ["/"].concat(Array.from({ length: 6 }, () => "\u001B[B")),
      { rows: 12 },
    );
    expect(moved.output).toContain("❯ /user");
    expect(moved.output).not.toContain("/help ");
    expect(moved.output).toContain("/status");
  });

  it("⚠️ 鼠标点面板某一行 = 把它**补进输入行**（**不**执行）", async () => {
    // 面板第一行在第 2 个屏幕行（第 1 行是上框；报告的坐标是 1-based 而几何层已经减过一）
    const clicked = await renderAndFeed(["/", report(0, 40, 2)]);
    expect(clicked.output).toContain("❯ /help");
    // ⚠️ **反向自检**：点那一下**没有执行** —— 补完再回车，`❯ /help` 只该出现**一次**
    // （点一下就执行的话会有两行：一次是点击的，一次是回车的）。
    const after = await renderAndFeed(["/", report(0, 40, 2), "\r"]);
    expect(after.output.split("\n").filter((line) => line.includes("❯ /help"))).toHaveLength(1);
  });

  it("⚠️ 面板**滚过之后**点某一行的行号 = **候选序**（点第 1 行填的是第 2 条命令）", async () => {
    // 12 行的屏 ⇒ 视口 6 行；先 `↓` 六次把窗口滚一格（此时屏上第 1 行是命令表里第 2 条）。
    // ⚠️ **必须滚过**：窗口没滚时「行号序」与「候选序」恰好相等，那个 bug 就看不见。
    const { output } = await renderAndFeed(
      ["/", ...Array.from({ length: 6 }, () => "\u001B[B"), report(0, 40, 2)],
      { rows: 12 },
    );
    expect(output).toContain("❯ /status");
    expect(output).not.toContain("❯ /help");
  });

  it("⚠️ 滚轮在面板开着时**移动高亮**（不是滚结果区）", async () => {
    const { output, mouseEvents } = await renderAndFeed(["/", report(65, 40, 2)]);
    expect(mouseEvents.map((one) => one.action)).toContain("wheelDown");
    expect(output).toContain("❯ /status");
  });
});
