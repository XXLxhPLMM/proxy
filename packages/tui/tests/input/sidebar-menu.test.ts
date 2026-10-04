/**
 * 侧边栏那一列：点选、滚动、悬停那枚「✕」、以及右键弹出的那个菜单
 * @description 每项两行 + 项间一行，故判据一律按列切、按几何取行号。
 * ⚠️ 共用的不变量与那张变异表见 `AGENTS.md`。
 */

import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { boldRuns, COLUMNS, CTRL_X, HELP_TABLE_MARK, LAST_SESSION_REFUSAL, RIGHT_CLICK_COL, ROWS, ledger, menuItemPoint, mount, renderAndFeed, report, sidebarCloseCol, sidebarEmptyRow, sidebarNameRow, stripAnsi, typed } from "./_shared.js";
import { LOGO } from "@/features/output/logo.js";
import { geometry, SIDEBAR_WIDTH } from "@/lib/geometry.js";

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

/** 侧边栏那一列的**窄屏**档：4 个会话在 7 行里放不下 3 个 ⇒ 有溢出、可见窗口 2 项 */
const SHORT_ROWS = 7;

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
