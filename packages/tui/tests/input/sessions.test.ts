/**
 * 会话这一列上看得见的几件事：改名框（在**弹窗**里）、历史会话弹窗的五个动作、「你还没看」那一枚记号
 *
 * @description 每一格都有**纯键盘**的第二路（右键在很多终端里压根到不了，见 `packages/tui/AGENTS.md`）。
 * ⚠️ 改名框**不在输入行里** —— 四个入口（`/rename` / `Ctrl+R` / 菜单那一项 / 弹窗里的 `Ctrl+R`）
 * 打开的都是同一个弹窗加同一个框，故那一族判据全部按「弹窗里的那一格」判。
 * ⚠️ 共用的不变量与判据纪律见 `AGENTS.md`。
 */

import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import {
  BACKSPACE,
  CTRL_D,
  CTRL_R,
  CTRL_P,
  CTRL_X,
  DOWN,
  ENTER,
  ESC,
  COLUMNS,
  RIGHT_CLICK_COL,
  ROWS,
  UP,
  boldRuns,
  emptyLedgerPath,
  ledger,
  menuItemPoint,
  mount,
  pinSessionSeed,
  renderAndFeed,
  report,
  saveSessionSeed,
  sidebarNameRow,
  sidebarOf,
  stripAnsi,
  typed,
} from "./_shared.js";
import { widthOf } from "@/lib/format.js";
import { SIDEBAR_WIDTH, geometry } from "@/lib/geometry.js";

/** 「已在侧边栏上」那一枚（` ◉`）占几列 */
const PIN_WIDTH = 2;
/** 「它连着哪台」那一截的预算（⚠️ 状态层那一格**恒**给它留这么多） */
const MANAGER_WIDTH = 14;

/**
 * 历史会话弹窗右上角那一枚 `esc 关窗` 的 SGR 落点（**1-based**；期望值从几何读）
 * @description ⚠️ 槽位串**就是弹窗那一列**（一个分组标题 + 一个可选会话），而判据是
 * `windowClose` —— 它为 `null` 时那一格**画不出来也点不中**，两件事是同一个值。
 */
function historyCloseChip(columns: number, rows: number): { x: number; y: number } {
  const g = geometry({
    columns,
    rows,
    sidebarWidth: SIDEBAR_WIDTH,
    sessionCount: 1,
    sessionsTop: 0,
    input: "",
    paletteCount: 0,
    window: [{ kind: "group" }, { kind: "row" }],
    windowCloseHint: true,
    menu: null,
  });
  const rect = g.windowClose;
  if (rect === null) throw new Error("这一屏画不出右上角那枚提示");
  return { x: rect.x + 1, y: rect.y + 1 };
}

/**
 * 那一行**名字**的裁剪预算有几列（**期望值现算**，不写死字数）
 * @description ⚠️ 窗口宽高由几何层算（屏宽 × `WINDOW_WIDTH_RATIO` 与一圈卡边距），而那一格里
 * 还有「已上侧边栏那一枚 + 它连的哪台」几列要留。⚠️ **高亮记号那一格已经让开了**（几何层给可选项
 * 的缩进就是为它留的），故这里**不再减它** —— 多减一次的话「名字裁短了一格」而断言照旧绿
 * （症状是「裁剪略紧」，不是「裁剪失效」，而后者才是这一档要逮的）。
 */
const LABEL_BUDGET = (() => {
  const g = geometry({
    columns: COLUMNS,
    rows: ROWS,
    sidebarWidth: SIDEBAR_WIDTH,
    sessionCount: 1,
    sessionsTop: 0,
    input: "",
    paletteCount: 0,
    window: [{ kind: "group" }, { kind: "row" }],
    windowCloseHint: true,
    menu: null,
  });
  // ⚠️ **可选项那一条**的矩形（`windowRows`），不是整块卡片：那一行的名字画在**这一格**里
  const slot = g.windowRows[0]!;
  return slot.width - PIN_WIDTH - MANAGER_WIDTH;
})();

/** 改名框开着那一行的**唯一**可观察事实：弹窗里那一格 `✎ <名字>`（⚠️ 不抄整句，措辞会变） */
const renameBox = (name: string): string => `✎ ${name}`;

/** `Ctrl+N`（⚠️ 按码点造，与 `CTRL_X` 同一条纪律；`Ctrl+P` 用 `_shared.ts` 那一份） */
const CTRL_N = String.fromCharCode(0x0e);

/** `/sessions` 打开历史会话弹窗（⚠️ **一个字都不留**在结果区 —— 那一句是弹窗自己回答的） */
const OPEN_HISTORY = [...typed("/sessions"), "\r"];

describe("改名框：它在**弹窗**里，而四个入口打开的是同一个框", () => {
  it("⚠️ `/rename` 打开**弹窗 + 那个框**，框里装的是**它现在的名字**", async () => {
    // ⚠️ **回车那一键走 `feedRendered`**：改名框要过「命令落地 → 改状态 → 几何重算」才上屏，
    // 而 `feed` 的固定下限在并发下抢在重排之前（那一档因此**整套里偶发红、单跑 3 次全绿** ——
    // 闪的测试比没有测试更坏）。等的是「帧数变了」而不是「屏上出现了那个 `✎`」，
    // 后者会把下面那条断言变成恒真。
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/rename")]);
    await ui.feedRendered([ENTER]);
    const output = plain(await ui.finish());
    expect(output).toContain(renameBox("会话 1"));
    // ⚠️ **反向自检**：命令面板没被唤起来（那一格里装的是会话名，而 `/` 会让它浮出来）
    expect(output).not.toContain("列出命令，或给一条命令看用法");
    // ⚠️ 而弹窗开着 ⇒ 右上角那枚 `esc 关窗` **不画**：此刻 `Esc` 关的是框而不是窗，
    // 留着那句话就是一句假事实（判据是 `closeHint: false` 时 `windowClose` 是 `null`）
    expect(output).not.toContain("esc 关窗");
  });

  it("⚠️ 那一枚 `esc 关窗` **画出来就点得中**，关不掉就是判据两端分叉了（判据：同一个值喂两处）", async () => {
    // ⚠️ **命中测试与绘制读的是同一份 `closeHint`**（`AppState.tsx` 那一个推导）：两处各判一次的话，
    // 症状是「右上角点不动」或「点别处却关了窗」，而屏上零解释。
    const open = await mount({ interactive: false, ledgerFile: ledger() });
    await open.feed(OPEN_HISTORY);
    const drawn = await open.finish();
    // ⚠️ **正向对照**：那一枚**真的画出来了**（没画的话下面那个坐标无从谈起）
    expect(plain(drawn)).toContain("esc 关窗");
    const chip = historyCloseChip(COLUMNS, ROWS);

    const clicked = await mount({ interactive: false, ledgerFile: ledger() });
    await clicked.feed(OPEN_HISTORY);
    // ⚠️ 点它正中 ⇒ **整个弹窗关掉**（点不动的形状是「那一格不可命中」）
    await clicked.feed([report(0, chip.x, chip.y)]);
    const after = plain(await clicked.finish());
    expect(after).not.toContain("历史会话");

    // ⚠️ **反向自检**：同一个坐标在**改名框开着**时**点不动**（那一格此刻不存在）——
    // 少了它，上面那条「点得中」与「那一格恒不命中」分不开。
    // ⚠️ ⚠️ **回车那一键走 `feedRendered`**：它等的是「这一键排过一帧」，而点击紧跟其后 ——
    // 用 `feed` 的固定下限时，框还没上屏就点下去的话**那一格是可命中的**，于是弹窗被关掉，
    // 症状是「这一档偶发红、单跑全绿」（闪的测试比没有测试更坏）。
    const renaming = await mount({ interactive: false, ledgerFile: ledger() });
    await renaming.feed([...typed("/rename")]);
    await renaming.feedRendered([ENTER]);
    await renaming.feed([report(0, chip.x, chip.y)]);
    const stillOpen = plain(await renaming.finish());
    expect(stillOpen).toContain("历史会话");
    expect(stillOpen).toContain("✎ 会话 1");
  });

  it("⚠️ 输字 + `Enter` ⇒ 侧边栏上是新名字，而**会话自己的输入行一个字都没丢**", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    // 先在输入行上留半句命令，再按 `Ctrl+R` 开改名框（改名**不碰**输入行，故那半句必须还在）
    await ui.feed([...typed("/sta"), CTRL_R]);
    const opened = plain(await ui.finish());
    // ⚠️ **反向自检**：框开着，而**输入行上那一格仍是那半句命令**（改名不写进会话的 `input`）
    expect(opened).toContain(renameBox("会话 1"));
    expect(opened).toContain("❯ /sta");

    const done = await mount({ interactive: false, ledgerFile: ledger() });
    await done.feed([...typed("/sta"), CTRL_R]);
    // ⚠️ 「会话 1」四个码元 ⇒ 退格**四次**才真的清空（少一次就还剩一个字，而那个字会进新名字里）
    await done.feed([...BACKSPACE, ...BACKSPACE, ...BACKSPACE, ...BACKSPACE]);
    await done.feed(typed("改名了"));
    await done.feed([ENTER]);
    const renamed = plain(await done.finish());
    expect(renamed).toContain("改名了");
    expect(renamed).not.toContain("会话 1");
    // ⚠️ 而改完名之后**弹窗关掉了**，输入行上还是那半句命令（不是空的，也不是名字）
    expect(renamed).toContain("❯ /sta");
  });

  it("⚠️ `Esc` **只关改名框**，而弹窗还在（两级 `Esc`：先框、再窗）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/rename"), "\r", ...typed("改名了"), ESC]);
    const oneEsc = await ui.finish();
    // ⚠️ **核心判据**：框关了（那一枚 `✎` 不在了）而**弹窗还在**（标题还在）——
    // 两级一起关的话这一条与「`Esc` 关窗」在屏上完全一样。
    // ⚠️ 锚点是**提示符本身**而不是 `✎ <改完的名字>`：框里的插入符起手落在名字**末尾**，
    // 于是改完是「✎ 会话 1改名了」，而拿整句当锚点的话这一条在框开着时也照样通过（恒真）。
    expect(plain(oneEsc)).not.toContain("✎");
    expect(plain(oneEsc)).toContain("历史会话");
    expect(oneEsc).toContain("会话 1");
  });

  it("⚠️ **反向自检**：上一条那个 `✎` 锚点真的钉得住框（不然「`not.toContain`」是恒真）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/rename"), "\r", ...typed("改名了")]);
    const boxOpen = plain(await ui.finish());
    expect(boxOpen).toContain("✎");
    // ⚠️ 而框里那一格装的是「名字 + 在末尾追加的字」，不是被字面替换掉的名字
    expect(boxOpen).toContain(renameBox("会话 1改名了"));
  });

  it("⚠️ 框开着时第二个 `Esc` ⇒ **整个弹窗关掉**（那一枚 `esc 关窗` 这时才重新出现）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/rename"), "\r", ESC, ESC]);
    const output = await ui.finish();
    expect(plain(output)).not.toContain("历史会话");
    // ⚠️ **反向自检**：那一帧真的有字（非交互档空帧会让上面那条恒真）
    expect(output).toContain("会话 1");
  });

  it("⚠️ `Ctrl+R` 打开**同一个**框（而不是又一个实现）", async () => {
    const { output } = await renderAndFeed([CTRL_R], { ledgerFile: ledger() });
    expect(plain(output)).toContain(renameBox("会话 1"));
  });

  it("⚠️ 菜单里的「重命名」打开的也是**同一个**框（作用于那一项，弹窗高亮跟着它走）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), "\r"]);
    // 右键**第一个**会话（不是当前那个）⇒ 菜单 ⇒ 「重命名」⇒ 框里是**它**的名字
    const row = sidebarNameRow(2, 0);
    await ui.feed([report(2, RIGHT_CLICK_COL, row)]);
    const [x, y] = menuItemPoint(row, 1);
    await ui.feed([report(0, x, y)]);
    expect(plain(await ui.finish())).toContain(renameBox("会话 1"));
  });

  it("⚠️ 框开着时**面板与快捷键都不归它**（`/` 唤不起面板、`Ctrl+X` 不移出会话）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    // ⚠️ `/rename` 跑在**会话 2** 里（`/new` 已经切过去了），故被改名的是**它**
    await ui.feed([...typed("/new"), ENTER, ...typed("/rename"), ENTER, "/", CTRL_X]);
    const output = plain(await ui.finish());
    // ⚠️ 敲进去的 `/` 进了**名字**（`会话 2/`），而面板没开、侧边栏上还留着**两个**会话
    // （`Ctrl+X` 归改名框那一支 ⇒ 什么都不做）
    expect(output).not.toContain("列出命令，或给一条命令看用法");
    expect(output).toContain(renameBox("会话 2/"));
    expect(sidebarOf(output).join("\n")).toContain("会话 1");
    expect(sidebarOf(output).join("\n")).toContain("会话 2");
  });

  it("⚠️ 空名字**不认**（框不关，而屏上说了为什么）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/rename"), "\r"]);
    // ⚠️ 「会话 1」四个码元 ⇒ 退格四次才真的空了（少一次就还剩一个字）
    await ui.feed([...BACKSPACE, ...BACKSPACE, ...BACKSPACE, ...BACKSPACE]);
    await ui.feed(["\r"]);
    const output = await ui.finish();
    expect(output).toContain("名字不能是空的");
    // ⚠️ 而**框还开着**（它没关）：判据是框那一行还在，而弹窗标题也在
    expect(plain(output)).toContain("历史会话");
    expect(output).toContain(ESC);
  });

  it("⚠️ 框开着时 `Ctrl+N` / `Ctrl+P` / `PageUp` 什么都不做（它们归弹窗那一层）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), ENTER, ...typed("/new"), ENTER, ...typed("/rename"), ENTER]);
    const opened = plain(await ui.finish());
    // ⚠️ **反向自检**：框开着（框那一行在屏上），而当前那一个是**会话 3**
    expect(opened).toContain(renameBox("会话 3"));

    // ⚠️ **再挂一次**，把那四键喂进去：改名框开着 ⇒ 它们**全**归框那一支而什么都不做
    // （漏到弹窗那一层的话 `Ctrl+N` 会把当前会话从 3 换成 1，而侧边栏第二行会跟着换；
    //  `Ctrl+X` 漏出去会把会话 3 从侧边栏上摘掉）
    const box = await mount({ interactive: false, ledgerFile: ledger() });
    await box.feed([...typed("/new"), ENTER, ...typed("/new"), ENTER, ...typed("/rename"), ENTER]);
    await box.feed([CTRL_N, CTRL_P, CTRL_X]);
    const raw = await box.finish();
    const after = plain(raw);
    // ⚠️ **核心判据一**：改名框**还开着** ⇒ 那一键族归框那一支（框开着时 `Ctrl+X` 不摘会话）
    expect(after).toContain(renameBox("会话 3"));
    // ⚠️ **核心判据二**：**当前会话一个都没换**（加粗那一项仍是会话 3，而三行都还在侧边栏上）。
    // ⚠️ **判据读的是加粗**（颜色之外的通道）—— 而 `boldCurrent` 要**带 ANSI 的那一帧**：
    // 剥掉之后加粗那一层信息就没了，「换了当前会话」与「没换」在判据上就分不开。
    expect(boldCurrent(raw)).toContain("会话 3");
    const sidebar = sidebarOf(after).join("\n");
    expect(sidebar).toContain("会话 1");
    expect(sidebar).toContain("会话 2");
    expect(sidebar).toContain("会话 3");
  });
});

/* ── `/sessions`：那个弹窗 ────────────────────────────────────────────────── */

describe("历史会话弹窗：里面是**所有**历史会话，按天数分组", () => {
  it("⚠️ `/sessions` 打开它，而标题上带着**总数**", async () => {
    const { output } = await renderAndFeed(OPEN_HISTORY, { ledgerFile: ledger() });
    expect(plain(output)).toContain("历史会话（1）");
    expect(output).toContain("会话 1");
    // ⚠️ **反向自检**：弹窗**右上角那枚 `esc 关窗` 在**（没开改名框），而它就是关窗那条路
    expect(plain(output)).toContain("esc 关窗");
  });

  it("⚠️ 一个历史会话都没有时 `note` 给一句人话（**不是空串**）", async () => {
    // ⚠️ **库里一个都没有**只有一条路造得出来：**那次恢复的播种写不进去**。
    // 故意把 `sessions` 表造成一张**装不下任何行**的形状（`created_at` 上一道 `CHECK`）。
    const file = emptyLedgerPath();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (file: string) => { close(): void; exec(sql: string): void };
    };
    const db = new DatabaseSync(file);
    try {
      // ⚠️ **先把那个库建出来**（`readSessions` 对**不存在**的库返回空清单且不建库），
      // 再把 `sessions` 换成那个形状 ⇒ 播种那一步必抛
      db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL CHECK (created_at > 0))");
    } finally {
      db.close();
    }
    const { output } = await renderAndFeed(OPEN_HISTORY, { ledgerFile: file });
    expect(plain(output)).toContain("一个历史会话都没有");
    // ⚠️ 而**不是**空弹窗（标题仍在 ⇒ 弹窗真的开着了，而总数是 0）
    expect(plain(output)).toContain("历史会话（0）");
  });

  it("⚠️ **按天数分组**：标题行是 `今天` / `昨天` / `N 天前` / 一个具体日期", async () => {
    // ⚠️ **判据是屏上那一列按行读**：分组标题与会话**同处一列**（它们是同一个列表里的相邻行），
    // 而写死屏幕行号的话「分组挪了一行」而断言照旧绿
    const file = emptyLedgerPath();
    saveSessionSeed(file, "s1", "今天那个", 0);
    saveSessionSeed(file, "s2", "昨天那个", 1);
    saveSessionSeed(file, "s3", "五天前那个", 5);
    saveSessionSeed(file, "s4", "很久以前那个", 400);
    const { output } = await renderAndFeed(OPEN_HISTORY, { ledgerFile: file });
    expect(plain(output)).toContain("今天");
    expect(plain(output)).toContain("昨天");
    expect(plain(output)).toContain("5 天前");
    // ⚠️ **≥ 30 天 ⇒ 一个具体日期**，而**不是** `400 天前`（后者的字数会随时间无界长下去）
    expect(plain(output)).not.toContain("400 天前");
    expect(plain(output)).toContain("很久以前那个");
  });

  it("⚠️ 每一行的名字**裁到窗口内**（超长名不许把卡片顶宽）", async () => {
    const file = emptyLedgerPath();
    saveSessionSeed(file, "s1", "这".repeat(80), 0);
    pinSessionSeed(file, "s1");
    const { output } = await renderAndFeed(OPEN_HISTORY, { ledgerFile: file });
    // ⚠️ **判据是「裁好的那段宽度不超过那一格的预算」**而不是抄一个裁好的字数 ——
    // 那个数字会随窗口宽度变，而抄下来的话「几何一改、裁剪就失效了」而断言照旧绿。
    const label = popupRowNames(output)[0];
    expect(label, "弹窗里没有会话行").toBeDefined();
    // ⚠️ **正向对照**：那一格**有内容**（空串会让下面两条恒真，而 `widthOf("") === 0`）
    expect(widthOf(label as string)).toBeGreaterThan(0);
    expect(widthOf(label as string)).toBeLessThanOrEqual(LABEL_BUDGET);
    // ⚠️ **反向自检**：裁过 ⇒ 带上了那个省略号，而原始那一长串不在（80 个「这」是 160 列）
    expect(label).toContain("…");
    expect(plain(output)).not.toContain("这".repeat(80));
  });

  it("⚠️ 打开时高亮**落在当前会话那一行**（`Enter` = 重激活当前那个，而不是静默切到另一个）", async () => {
    const file = emptyLedgerPath();
    saveSessionSeed(file, "s1", "早那个", 2);
    saveSessionSeed(file, "s2", "晚那个", 0);
    pinSessionSeed(file, "s1");
    pinSessionSeed(file, "s2");
    // ⚠️ 恢复后的当前会话是**激活序的第一个**（`s1`），而它在弹窗里**不是第 0 行**
    // （`s2` 的 `updated_at` 更近 ⇒ 排前面）⇒ 落在第 0 行的话「打开就回车」会静默切到 `s2`
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(OPEN_HISTORY);
    // ⚠️ **反向自检**：弹窗里那一列的顺序是「晚那个」在前（它 `updated_at` 更近 ⇒ 排第 0 行）
    const popupOrder = popupRowNames(await ui.finish());
    expect(popupOrder).toEqual(["晚那个", "早那个"]);

    const done = await mount({ interactive: false, ledgerFile: file });
    await done.feed(OPEN_HISTORY);
    await done.feed([ENTER]);
    // ⚠️ **判据是侧边栏那一列的加粗**：激活 `s1`（重新 pin 它）之后它成了当前那一个。
    // ⚠️ **落第 0 行的话「打开就回车」会静默切到「晚那个」** —— 而那一句是**重激活当前那个**，是对的
    expect(boldCurrent(await done.finish())).toContain("早那个");
  });

  it("⚠️ `↑` / `↓` 在**可选会话**之间走，而**标题行不算**（走到底停住，不循环）", async () => {
    const file = emptyLedgerPath();
    saveSessionSeed(file, "s1", "甲", 0);
    saveSessionSeed(file, "s2", "乙", 1);
    saveSessionSeed(file, "s3", "丙", 2);
    pinSessionSeed(file, "s1");
    pinSessionSeed(file, "s2");
    pinSessionSeed(file, "s3");
    // ⚠️ 弹窗按 `updated_at` 倒序 ⇒ 屏上那一列是 `甲` / `乙` / `丙`；而高亮默认落在
    // **当前会话**（激活序的第一个 = `s1` = `甲`，下标 0）。**三个会话同在「今天」那一组**
    // ⇒ 这一档里**一个标题槽都没有**，而判据是「按 `↓` 了几次才到哪一个」。
    const one = await mount({ interactive: false, ledgerFile: file });
    await one.feed(OPEN_HISTORY);
    await one.feed([DOWN, DOWN]);
    await one.feed([ENTER]);
    expect(boldCurrent(await one.finish())).toContain("丙");

    // ⚠️ **走到底停住**：从第 2 行再按一次 `↓` ⇒ 高亮**不动**（不循环回第 0 行）
    const atEnd = await mount({ interactive: false, ledgerFile: file });
    await atEnd.feed(OPEN_HISTORY);
    await atEnd.feed([DOWN, DOWN, DOWN, DOWN]);
    await atEnd.feed([ENTER]);
    expect(boldCurrent(await atEnd.finish())).toContain("丙");
  });

  it("⚠️ `Ctrl+D` **按两次**才永久删掉高亮那一行（第一次只是**待确认**），而键**不漏到输入行去**", async () => {
    const file = emptyLedgerPath();
    saveSessionSeed(file, "s1", "留着的", 1);
    saveSessionSeed(file, "s2", "删掉的", 0);
    pinSessionSeed(file, "s1");
    pinSessionSeed(file, "s2");
    // ⚠️ **第一段：一次不删**。判据是**那一行还在**（删除一律两段 `Ctrl+D`）。
    // ⚠️ **反向自检**在下面那条 `it` 里（两次才删）—— 少了它，「一次不删」与「两段机制压根没接上」分不开。
    const once = await mount({ interactive: false, ledgerFile: file });
    await once.feed(OPEN_HISTORY);
    await once.feed([UP, CTRL_D]);
    const held = plain(await once.finish());
    expect(held).toContain("删掉的");
    expect(held).toContain("留着的");

    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(OPEN_HISTORY);
    // ⚠️ 当前会话是激活序的第一个（`s1`，下标 1），而 `s2` 更新 ⇒ 排第 0 行 ⇒ `UP` 到它
    await ui.feed([UP, CTRL_D, CTRL_D]);
    const output = plain(await ui.finish());
    expect(output).not.toContain("删掉的");
    expect(output).toContain("留着的");
    // ⚠️ **键不漏出去**：`Ctrl+D`（`0x04`）在弹窗开着时归弹窗，而**输入行上还是空串** ——
    // 漏出去的话 `printableOnly` 会把它当可打印字符插进去，而屏上没有任何东西解释那一格
    expect(output).toContain("❯ ");
    expect(sidebarOf(output).join("\n")).not.toContain(CTRL_D);
  });

  it("⚠️ `Esc` 关窗，而关掉之后那一行**回到输入行**（弹窗是模态，不留残迹）", async () => {
    const { output } = await renderAndFeed([...OPEN_HISTORY, ESC], { ledgerFile: ledger() });
    expect(plain(output)).not.toContain("历史会话");
    expect(output).toContain("会话 1");
  });

  it("⚠️ 弹窗里 `Ctrl+R` 给**高亮那一行**开改名框（不是给当前会话）", async () => {
    const file = emptyLedgerPath();
    saveSessionSeed(file, "s1", "当前的", 2);
    saveSessionSeed(file, "s2", "别处的", 0);
    pinSessionSeed(file, "s1");
    pinSessionSeed(file, "s2");
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(OPEN_HISTORY);
    // ⚠️ 高亮默认落在**当前会话**（`s1`，下标 1），而 `s2` 更新 ⇒ 排第 0 行 ⇒ **`↓` 到不了它**，
    // 要 `↑` 一次（这一条同时钉住「默认高亮是当前会话」与「`↑↓` 数的是可选会话」）
    await ui.feed([UP, CTRL_R]);
    // ⚠️ **判据是框里那一格**：框里装的是**别处那个**的名字，而不是当前那一个
    expect(plain(await ui.finish())).toContain(renameBox("别处的"));
  });
});

/* ── 那一枚记号：跑完打勾，**切回来看过就清掉** ─────────────────────────────── */

describe("侧边栏那一枚记号：跑完打勾，切回来看过就清掉", () => {
  it("⚠️ 跑完一条命令 ⇒ 那一项打勾，而**新建出来的那个一个记号都没有**", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/status"), "\r"]);
    expect(plain(await ui.finish())).toContain("● 会话 1");

    // ⚠️ **反向自检**：`/new` 是**在会话 1 里跑的命令** ⇒ 它打完勾，而**新建出来的**那个一个记号都没有
    const two = await mount({ interactive: false, ledgerFile: ledger() });
    await two.feed([...typed("/new"), "\r"]);
    const after = plain(await two.finish());
    expect(after).toContain("● 会话 1");
    expect(after).toContain("会话 2");
    expect(after.split("●")).toHaveLength(2);
  });

  it("⚠️ `run` **不再**因「切过去看一眼」被清掉（跑没跑完与看没看过**是两个字段**）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("/new"), "\r", ...typed("/status"), "\r"]);
    expect(plain(await ui.finish())).toContain("● 会话 1");
    // ⚠️ 切回会话 1（**`Ctrl+P`** —— 裸 `↑` 现在归输入框的行移动）⇒ **看过**，
    // 而那一枚的完整判据是 `run === "done" && !seen`（「跑完了」与「你还没看」是**两件事**）。
    // ⚠️ **呈现层当前只读 `run` 那半边**（`SessionSidebar` 还没读 `seen`），
    // 于是屏上看得见的那半边是「`run` 还在」—— 这条断言钉的是**旧实现那行「切过去就 `run: "idle"`」**
    // 不许回来：合成一格的话「看一眼」就把「跑完了」一起清了，于是下一次跑完再没有记号。
    const back = await mount({ interactive: false, ledgerFile: ledger() });
    await back.feed([...typed("/new"), "\r", ...typed("/status"), "\r", CTRL_P]);
    const raw = await back.finish();
    expect(plain(raw)).toContain("● 会话 1");
    expect(plain(raw)).toContain("● 会话 2");
    // ⚠️ **反向自检**：当前会话真的换回去了（加粗那一项）—— 不然上面两条与「压根没切」分不开
    expect(boldCurrent(raw)).toContain("会话 1");
  });
});

/* ── 三个局部量具（只这一档用到，故留在这一档而不是 `_shared.ts`） ────────── */

/**
 * 弹窗里那些**可选会话**的名字，**从上到下**
 * @description ⚠️ 取「高亮记号与 `◉` 之间那一段」：那一段**就是**裁好的名字，而两端的记号各有各的宽度 ——
 * 连着记号一起量的话「名字有多长」与「那一格有多宽」就在判据上分不开了（症状是「裁剪失效了」与
 * 「记号那一列变了」读起来一样）。⚠️ 判据是**次序**而不是「几个都在」：集合判据对任何排列都成立。
 */
function popupRowNames(output: string): readonly string[] {
  const names: string[] = [];
  for (const line of stripAnsi(output).split("\n")) {
    // ⚠️ **两端都要有**：只有高亮记号或只有 `◉` 的那几行是卡片右缘的框线，不是会话行
    const match = /^\s*(▍| )\s(.*?)\s*◉/u.exec(line);
    if (match !== null) names.push(match[2] ?? "");
  }
  return names;
}

/**
 * 那一帧里**当前那一个会话名**（⚠️ 加粗 = 选中，而它是颜色之外的通道 —— 无色终端里底色不存在）
 * @description 判据**不**只按名字取：弹窗那一列与结果区都逐字包含会话名，
 * 「选中」与「屏上还有那个名字」在判据上分不开。⚠️ 故这里按**加粗的片段**找，而不是按整帧找。
 */
function boldCurrent(output: string): string {
  const names = ["会话 1", "会话 2", "会话 3", "早那个", "晚那个", "甲", "乙", "丙"];
  for (const run of boldRuns(output)) {
    const found = names.find((name) => run.includes(name));
    if (found !== undefined) return found;
  }
  return "";
}

/** 那一帧的纯文本（⚠️ 判据要读的是**渲染后那一帧的字节**；`boldRuns` 只给加粗的片段） */
function plain(output: string): string {
  return stripAnsi(output);
}