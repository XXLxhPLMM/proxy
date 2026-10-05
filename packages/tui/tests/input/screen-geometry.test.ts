/**
 * 屏上那几块跟着几何走的表面：`/managers` 那个模态窗口、拖宽手柄、终端改尺寸
 * @description 三者的落点一律从 `@/lib/geometry` 读，而 Ink 重排的是它手里那**上一帧** —— 应用必须自己排一帧新的。
 * ⚠️ 共用的不变量与那张变异表见 `AGENTS.md`。
 */

import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { COLUMNS, ROWS, boldRuns, displayColumnOf, ledger, mount, paletteInput, renderAndFeed, report, sidebarNameRow, stripAnsi, typed } from "./_shared.js";
import { widthOf } from "@/lib/format.js";
import { geometry, MIN_TERMINAL_COLUMNS, SIDEBAR_WIDTH } from "@/lib/geometry.js";

/**
 * 那一行里 `needle` 之前的**显示宽度**（`indexOf` 返 -1 时给 `Infinity`，于是「不在这一行」与
 * 「在这一行但很靠后」分得开 —— 而这里要的正是那个区分）
 */
function colBefore(line: string, needle: string): number {
  const at = line.indexOf(needle);
  return at < 0 ? Number.POSITIVE_INFINITY : widthOf(line.slice(0, at));
}

/**
 * 表里那一行当前**有没有落在视口内**，以及它前面垫了几格空白
 * @description 判据落在这个函数上，而不是「字节数变了」：它随 `top` 变，而「写了一帧」与它无关
 * —— `clampTop` 被钉死时表**一格都没滚**，Ink 照样写出一整帧，只量字节数会恒绿。
 */
function rowAnchor(raw: string, marker: string): { pad: number; tail: string } | null {
  for (const line of stripAnsi(raw).split("\n")) {
    const col = colBefore(line, marker);
    if (col < Number.POSITIVE_INFINITY) {
      return { pad: col, tail: line.slice(line.indexOf(marker)).trimEnd() };
    }
  }
  return null;
}

/** 结果区**可见行**的逐条内容（去掉 SGR 与首尾空白） */
function visibleRows(raw: string): string[] {
  return stripAnsi(raw)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

describe("模态窗口（`/targets`）：Esc 与那枚 esc **是同一条路**", () => {
  // ⚠️ 零兼容：那条命令改名了（`/managers` → `/targets`）而**不留旧名** ——
  // 判据整条改掉而不是加一条「旧的也能开」，否则两个名字会各自漂
  const OPEN = ["/", "t", "a", "r", "g", "e", "t", "s", "\r"];

  it("⚠️ `/targets` 浮出一个窗口：逐行给出**链接**与超时，右上角一枚 `esc`", async () => {
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
    const g = geometry({ ...paletteInput(), window: [{ kind: "row" }] });
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
    const g = geometry({ ...paletteInput(), window: [{ kind: "row" }] });
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

  it("⚠️ 台账为空时窗口**仍然开**，并说清怎么加一个（`/targets` 不是一个什么都没发生的动作）", async () => {
    const { output } = await renderAndFeed(OPEN);
    expect(output).toContain("控制面（0）");
    // ⚠️ **指引指向弹窗里那一族键**（`Ctrl+A`），而不再是某一条已被删掉的命令
    expect(output).toContain("Ctrl+A");
  });

  // ⚠️ 下面两条守的是**滚轮与悬停**那一半：`down` 早就门禁了，而 `wheelUp` / `wheelDown` /
  // `move` 三条路原先**从不查 `windowKind`** —— 症状是「模态开着时背后那一层照滚照亮」，
  // 而操作者看着一个被遮罩压着的面板，以为滚轮坏了。
  // ⚠️ 判据是**同一份报告的 A/B**：关窗时它确实生效（A ⇒ 尺是真的），开着窗时它一格都不动。
  // ⚠️⚠️ **两次必须在同一次挂载里量**：这一档原先起三次 `renderAndFeed`（各一帧）再比字节，
  // 而三次挂载的时序各不相同 ⇒「两次读到同一帧」这个观测里混进了「挂载时序不同」这个
  // 与被测行为无关的变量，7 个档并发时它就偶发（实测约 1/12）。改成同一次挂载后，
  // 顺带换成与下面 hover 那条**同一个判据**（门禁在 ⇒ React 一个状态都不改 ⇒ 零字节）。
  it("⚠️ 模态开着时**滚轮被吞掉**（背后那一层一格都不动），而关掉窗时同一份报告会滚", async () => {
    const wheel = report(64, 60, 6);
    const ui = await mount({ interactive: true, rows: 16, ledgerFile: ledger() });
    await ui.feed([...typed("/help"), "\r"]);
    // ⚠️ **正向对照（尺是真的）**：关窗时那一滚**确实**写了一整帧 —— `help` 那张表在 16 行的屏上
    // 装不下，而 `clampTop` 允许往下滚 ⇒ 判据落在真会动的档上（表 21 行而视口 10 行）
    const beforeScroll = ui.bytes();
    await ui.feed([wheel]);
    expect(ui.bytes() - beforeScroll).toBeGreaterThan(1024);
    // ⚠️ 尺在**这一次挂载**上已经校准过了（上面那滚就是正的），所以下面这个 0 不可能
    // 是「延迟没到、帧还没写」造成的 —— 同一挂载里同样的喂法，正的那滚当场就被量到了
    await ui.feed([...OPEN]);
    const opened = ui.snapshot();
    const settled = ui.bytes();
    await ui.feed([wheel]);
    const afterWheel = ui.bytes() - settled;
    expect(opened).toContain("控制面（1）");
    expect(afterWheel).toBe(0);
    // ⚠️ 而滚轮**之后**窗口仍在屏上：门禁吞掉的是滚轮，不是整个模态
    expect(ui.snapshot()).toContain("控制面（1）");
    await ui.finish();
  });

  // ⚠️⚠️ 正向对照**必须量「内容真的变了」而不是「写了一帧」**：只量字节数的话，
  // 「滚了但一格都没动」与「滚了而且动了」同样会写出一帧 ⇒ `clampTop` 被钉死也照样绿
  // （实测：把 `clampTop` 改成 `return max`，本目录 16 条全绿，而表**一格都没滚**）。
  // 判据落在 help 表的**第一条可见行**上：它随 `top` 变，而「写了一帧」这件事与它无关。
  it("⚠️ **正向对照**：关窗时那一滚**真的把表滚动了**（不是「写了一帧」就算滚）", async () => {
    const ui = await mount({ interactive: true, rows: 16, ledgerFile: ledger() });
    await ui.feed([...typed("/help"), "\r"]);
    // ⚠️ **反向自检**：探针看得见 help 表，否则下面两条在「什么都没渲染」下**恒成立**
    const before = rowAnchor(ui.snapshot(), "/help");
    expect(before).not.toBeNull();
    const rowsBefore = visibleRows(ui.snapshot());
    await ui.feed([report(64, 60, 6)]);
    // ⚠️ 断言落在**可见行的内容**上，而不是「写了一帧」：`clampTop` 被钉死时表一格都没滚，
    // 而 Ink 照样写出一整帧 —— 只量字节数那种判据在那个实现下**恒绿**。
    expect(visibleRows(ui.snapshot())).not.toEqual(rowsBefore);
    await ui.finish();
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
    const chip = geometry({ ...paletteInput(), window: [{ kind: "row" }] }).windowClose!;
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
 * 那一帧的**几何锚点**：输入区上边框那一行的显示列 / 行号 / 整行宽
 * @description ⚠️ 三个数**全部从 {@link geometry} 取**，不写死 —— 写死的后果是「几何一改、断言还绿」
 * 那种假绿（与 `_shared.ts` 里 `paletteRowY` 同一条纪律）。⚠️ 宽度那一项量的是**整行**（含左边那 23 列侧边栏
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
    window: [],
    windowCloseHint: true,
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
    // 它锁的是**兜底那一句**，与同档那两条互补；变异记录写在 `AGENTS.md`。
  });
});
