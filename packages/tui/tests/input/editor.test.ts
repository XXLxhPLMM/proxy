/**
 * 输入行那一族（需求 1）：多行 + 选区 + 光标行移动 + 历史 + 切会话的第二路
 * @description ⚠️ **每一族键位都有它自己的正向对照**，而判据一律用 {@link inputOf}（**只读输入区
 * 那一块**）与结果区那句话：
 * ⚠️ 提示符 `❯ ` **两处都有**（输入区那一枚与结果区里那一格用户消息），而敲进去的那一串在**结果区**
 * 里还会逐字再出现一次 ⇒ 在整帧上判「输入行是空的」与「屏上还有那一格回显」**分不开**（实测踩过一次）。
 * ⚠️ 共用的不变量与判据纪律见 `AGENTS.md`。
 */

import { describe, expect, it, vi } from "vitest";

import {
  BACKSPACE,
  COLUMNS,
  CTRL_DOWN,
  CTRL_ENTER,
  CTRL_UP,
  CTRL_X,
  DOWN,
  END,
  ENTER,
  HOME,
  LEFT,
  RIGHT,
  ROWS,
  SHIFT_END,
  SHIFT_HOME,
  SHIFT_LEFT,
  SHIFT_RIGHT,
  UP,
  boldRuns,
  inputOf,
  inputTextPoint,
  ledger,
  mount,
  report,
  sidebarOf,
  stripAnsi,
  typed,
} from "./_shared.js";

vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

/** 那一句「还没配模型提供商」（⚠️ **它证明这句话真的走了模型那一圈**，而没被当成命令） */
const NO_PROVIDER = "还没配模型提供商";

describe("换行：`Ctrl+Enter` 插 `\\n`，裸 `Enter` 才提交", () => {
  it("⚠️ `Ctrl+Enter` = **插入换行**（那一行没提交，而输入区里是两行）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("ab"), CTRL_ENTER, ...typed("cd")]);
    const output = stripAnsi(await ui.finish());
    // ⚠️ **核心判据**：输入区**折成两行**且两行都在（提交过的话这里是一句结果区而输入区是空的）
    expect(inputOf(output, { input: "ab\ncd" })).toEqual(["ab", "cd"]);
    // ⚠️ **反向判据**：那一行**没有提交**（走模型那一圈才会出这一句）
    expect(output).not.toContain(NO_PROVIDER);
  });

  it("⚠️ `Alt+Enter` 是**同一个动作的兼容回退**（`ESC CR` ⇒ Ink 认成 `{return, meta}`）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    const alt = `${String.fromCharCode(0x1b)}\r`;
    await ui.feed([...typed("ab"), alt, ...typed("cd")]);
    const output = stripAnsi(await ui.finish());
    // ⚠️ **正向对照**：它与 {@link CTRL_ENTER} 那一档的判据**逐字相同**（而两者是不同的字节序列）
    expect(inputOf(output, { input: "ab\ncd" })).toEqual(["ab", "cd"]);
    expect(alt).not.toBe(CTRL_ENTER);
  });

  it("⚠️ 裸 `Enter` = **提交**（正向对照：换行那一族不提交，这一族提交）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("status"), ENTER]);
    const output = stripAnsi(await ui.finish());
    // ⚠️ **核心判据**：输入区**空了**，而结果区**多了一格消息** —— 两件事合起来才是「提交了」
    expect(inputOf(output)).toEqual([""]);
    expect(output).toContain(NO_PROVIDER);
  });

  it("⚠️ 敲了换行之后再提交 ⇒ 结果区那一格**折成两段**（需求 3 的屏面那一半）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("ab"), CTRL_ENTER, ...typed("cd"), ENTER]);
    const output = stripAnsi(await ui.finish());
    // ⚠️ **核心判据**：那一格消息在结果区里**占两段**（而不是被 `\n` 当成两个格子）
    // ⚠️ **正向对照**：那句话**走了模型那一圈**（没配 provider ⇒ 留在屏上并说明为什么）——
    // 没有它，「屏上零输出」也能满足上面那两条
    expect(output).toContain(NO_PROVIDER);
    expect(inputOf(output)).toEqual([""]);
    expect(output).toContain("❯ ab");
    expect(output).toContain("\n");
  });

  it("⚠️ **每一段都重复那一枚箭头**（折行的每一行都重复，否则气泡左边参差不齐）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("ab"), CTRL_ENTER, ...typed("cd"), ENTER]);
    const output = stripAnsi(await ui.finish());
    // ⚠️ **按行切**而不是整帧 `toContain`：整帧上「有 `❯ ab`」与「有 `❯ cd`」分得开（两个不同的子串）
    // —— 真正要钉的是「**第二段那一行上有没有那枚箭头**」，故必须按行读
    const lines = output.split("\n");
    const first = lines.findIndex((line) => line.includes("ab"));
    const second = lines.findIndex((line) => line.includes("cd"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    expect(lines[first]).toContain("❯");
    // ⚠️ **两段是两条独立的行**（不是一行里两个子串）：找都找到了而它们在同一行上，
    // 那说明整帧被当成了一个「气泡」，而气泡的左边框在屏上会参差不齐
    expect(second).not.toBe(first);
    // ⚠️ **第二段那一行自己也有那一枚箭头**（正向对照就在同一个 `it` 里：
    // 少画第二段的那个实现「第一段有箭头」照样过）
    expect(lines[second]).toContain("❯");
  });
});

describe("选区：鼠标拖出来、键盘扩出来，而打印吃掉整段", () => {
  it("⚠️ **按下 → 拖动** = 选出一段，而打印**替换掉整段**", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("abcd")]);
    // ⚠️ **落点从几何现取**（`inputTextRows[0]`），而 `offset` 就是「点在那几个字上」
    const from = inputTextPoint(COLUMNS, ROWS, 1);
    const to = inputTextPoint(COLUMNS, ROWS, 3);
    await ui.feed([report(0, from.x, from.y)]);
    // ⚠️ **拖动**：SGR 的第三个数 32 = 「按住左键移动」
    await ui.feed([report(32, to.x, to.y)]);
    await ui.feed([...typed("X")]);
    const output = stripAnsi(await ui.finish());
    // ⚠️ **核心判据**：`bc` 那一段被吃掉 ⇒ `aXd`（不扩选区的话会是 `aXbcd`）
    expect(inputOf(output, { input: "aXd" })).toEqual(["aXd"]);
  });

  it("⚠️ **单击（没拖）** ⇒ 选区清空，而打印是**插入**不是替换", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("abcd")]);
    const at = inputTextPoint(COLUMNS, ROWS, 2);
    await ui.feed([report(0, at.x, at.y)]);
    await ui.feed([...typed("X")]);
    const output = stripAnsi(await ui.finish());
    // ⚠️ **核心判据**：`abXcd`（有选区的话这一格会是 `abX`）
    expect(inputOf(output, { input: "abXcd" })).toEqual(["abXcd"]);
  });

  it("⚠️ `Shift+→` 扩选区，而打印替换掉整段；**不带 Shift 的移动清空选区**", async () => {
    const extended = await mount({ interactive: false, ledgerFile: ledger() });
    await extended.feed([...typed("abc")]);
    await extended.feed([HOME, SHIFT_RIGHT, SHIFT_RIGHT]);
    await extended.feed([...typed("X")]);
    // ⚠️ **核心判据**：`ab` 被吃掉 ⇒ `Xc`（不扩选区的话会是 `abXc`）
    expect(inputOf(stripAnsi(await extended.finish()), { input: "Xc" })).toEqual(["Xc"]);

    // ⚠️ **反向对照**：扩完再按一次**不带 Shift** 的 `→` ⇒ 选区清掉，而打印是插入
    const cleared = await mount({ interactive: false, ledgerFile: ledger() });
    await cleared.feed([...typed("abc")]);
    await cleared.feed([HOME, SHIFT_RIGHT, SHIFT_RIGHT]);
    await cleared.feed([RIGHT]);
    await cleared.feed([...typed("X")]);
    // ⚠️ **方向判据**：`→` 把插入符落到行末 ⇒ `abcX`（选区还在的话这一格会是 `Xc`）
    expect(inputOf(stripAnsi(await cleared.finish()), { input: "abcX" })).toEqual(["abcX"]);
  });

  it("⚠️ `Shift+End` 扩到行末，而打印替换掉整段", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("abc")]);
    // ⚠️ **必须先 `Home`**：插入符本来就在行末，而 `Shift+End` 落点也是行末 ⇒ 那一步造出的是
    // **空选区**（`[3, 3)`），打印只会插在末尾（症状是「`Shift+End` 看着没反应」）
    await ui.feed([HOME, SHIFT_END]);
    await ui.feed([...typed("X")]);
    // ⚠️ **核心判据**：整段被吃掉 ⇒ `X`（不扩选区的话会是 `abcX`）
    expect(inputOf(stripAnsi(await ui.finish()), { input: "X" })).toEqual(["X"]);
  });

  it("⚠️ `Shift+Home` 扩到行首，而打印替换掉整段", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("abc")]);
    await ui.feed([END, SHIFT_HOME]);
    await ui.feed([...typed("X")]);
    // ⚠️ **核心判据**：整段被吃掉 ⇒ `X`（不扩选区的话会是 `Xabc`）
    expect(inputOf(stripAnsi(await ui.finish()), { input: "X" })).toEqual(["X"]);
  });

  it("⚠️ `Shift+←` 往回扩，而打印替换掉整段", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("abc")]);
    await ui.feed([END, SHIFT_LEFT]);
    await ui.feed([...typed("X")]);
    // ⚠️ **核心判据**：`c` 被吃掉 ⇒ `abX`
    expect(inputOf(stripAnsi(await ui.finish()), { input: "abX" })).toEqual(["abX"]);
  });

  it("⚠️ **裸 `←` / `→` 不扩选区**（正向对照：它们只是移动，屏上那一串不变）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("abc")]);
    await ui.feed([END, LEFT]);
    await ui.feed([...typed("X")]);
    // ⚠️ **核心判据**：`abXc`（扩了选区的话这一格会是 `Xc`）
    expect(inputOf(stripAnsi(await ui.finish()), { input: "abXc" })).toEqual(["abXc"]);
  });

  it("⚠️ 退格吃掉**整段选区**（而空选区时它只删一个字）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("abcd")]);
    const from = inputTextPoint(COLUMNS, ROWS, 1);
    const to = inputTextPoint(COLUMNS, ROWS, 3);
    await ui.feed([report(0, from.x, from.y), report(32, to.x, to.y), BACKSPACE]);
    // ⚠️ **核心判据**：`bc` 整段被吃掉 ⇒ `ad`（只删一个字的话会是 `acd`）
    expect(inputOf(stripAnsi(await ui.finish()), { input: "ad" })).toEqual(["ad"]);
  });

  it("⚠️ **跨折行的选区**：每一视觉行各自吃属于它的那一段（判据在**两行**上）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("abc"), CTRL_ENTER, ...typed("def")]);
    await ui.feed([HOME, SHIFT_RIGHT, SHIFT_RIGHT]);
    await ui.feed([...typed("X")]);
    // ⚠️ **核心判据**：第一行 `ab` 整段被吃掉 ⇒ `Xc` / `def`（**第二行一个字都不动**）
    // ⚠️ 而「两端各自夹进本行」写错的话第二行会从第 0 个字开始吃（症状是「后面几个字全没了」）
    expect(inputOf(stripAnsi(await ui.finish()), { input: "Xc\ndef" })).toEqual(["Xc", "def"]);
  });
});

describe("`↑`/`↓`：行移动，到顶 / 到底才去问历史", () => {
  it("⚠️ 提交过的行能从历史里**召回**（而裸 `↑` 不再切会话）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("abc"), ENTER]);
    await ui.feed([...typed("x")]);
    // ⚠️ 插入符在**第二行**（`x` 那一行）⇒ 第一次 `↑` 是行移动，第二次才是历史
    await ui.feed([UP, UP]);
    const output = stripAnsi(await ui.finish());
    // ⚠️ **核心判据**：输入区那一串换成了 `abc`
    expect(inputOf(output, { input: "abc" })).toEqual(["abc"]);
  });

  it("⚠️ **第一次 `↑` 是行移动**：两行那一格动的是插入符，而输入串**一个字都不变**", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("abc"), ENTER]);
    await ui.feed([...typed("ab"), CTRL_ENTER, ...typed("cd")]);
    await ui.feed([UP]);
    // ⚠️ **核心判据**：两行都还在（历史里只有 `abc`，召回它的话这一格会变成一行 `abc`）
    expect(inputOf(stripAnsi(await ui.finish()), { input: "ab\ncd" })).toEqual(["ab", "cd"]);
  });

  it("⚠️ **行移动优先于历史**（插入符不在末行时 `↓` 只动它，而历史里那一条一个字都不进屏）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("abc"), ENTER]);
    await ui.feed([...typed("ab"), CTRL_ENTER, ...typed("cd"), UP]);
    await ui.feed([DOWN]);
    // ⚠️ **核心判据**：两行都还在（`↓` 落到历史的话这一格会变成单行 `abc`）
    expect(inputOf(stripAnsi(await ui.finish()), { input: "ab\ncd" })).toEqual(["ab", "cd"]);
  });

  it("⚠️ 到底再按 `↓` ⇒ 清空输入行（`historyNext` 恒给得出答案）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([...typed("abc"), ENTER]);
    await ui.feed([UP, UP]);
    await ui.feed([DOWN]);
    const output = stripAnsi(await ui.finish());
    // ⚠️ **核心判据**：输入区**空了**（而 `↓` 被当成 no-op 的话这一格会还是 `abc`）
    expect(inputOf(output)).toEqual([""]);
  });

  it("⚠️ `Ctrl+↑` / `Ctrl+↓` = **切会话**，而**裸 `↑↓` 切不动**（需求 1 与需求 2 各有各的键）", async () => {
    const bare = await mount({ interactive: false, ledgerFile: ledger() });
    await bare.feed([...typed("/new"), ENTER, ...typed("/new"), ENTER]);
    await bare.feed([UP, UP]);
    // ⚠️ **判据形状**：读**加粗那一项**（颜色之外的通道），而 ⚠️ **读的是剥 ANSI 之前的那一帧** ——
    // `boldRuns` 认的就是那些转义序列，剥掉之后它恒答「一段都没有」（实测踩过一次）
    const after = await bare.finish();
    // ⚠️ **核心判据**：当前会话**一个都没换** ⇒ 加粗那一项仍是会话 3
    expect(boldRuns(after)).toContain("会话 3");
    expect(boldRuns(after)).not.toContain("会话 1");

    const ctrl = await mount({ interactive: false, ledgerFile: ledger() });
    await ctrl.feed([...typed("/new"), ENTER, ...typed("/new"), ENTER]);
    await ctrl.feed([CTRL_UP]);
    const moved = await ctrl.finish();
    // ⚠️ **正向对照**：`Ctrl+↑` 真的换了（切到会话 2 ⇒ 加粗那一项换了）
    expect(boldRuns(moved)).toContain("会话 2");
    expect(boldRuns(moved)).not.toContain("会话 3");
    // ⚠️ **反向自检**：这两个键**确实与裸 `↑↓` 不是同一串字节**（否则两条判据在讲同一件事）
    expect(CTRL_UP).not.toBe(UP);
    expect(CTRL_DOWN).not.toBe(DOWN);
  });

  it("⚠️ 命令面板开着时 `↓` **归面板**：它把高亮那一行填进输入行", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed(["/"]);
    await ui.feed([DOWN]);
    const output = stripAnsi(await ui.finish());
    // ⚠️ **核心判据**：输入行**整格被面板那一行换掉了** —— 单行那一格上「行移动」恒是 no-op，
    // 于是「`↓` 落到行移动」与「`↓` 落到面板」在屏上分不开，而这一格只有面板那一条路会改它
    expect(inputOf(output, { input: "/status" })).toEqual(["/status"]);
    // ⚠️ **反向自检**：面板**真的开着**（否则「输入行被换掉」与「`↓` 走了别的路」也分不开）
    expect(output).toContain("共 ");
  });
});

describe("零会话那一档：输入一句话 / 敲命令都**先**造一个会话", () => {
  it("⚠️ `Ctrl+X` 移出最后一个之后敲字 ⇒ **新会话当场出现**，而那句话落在它里面", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([CTRL_X]);
    // ⚠️ **零会话那一屏**：侧边栏那一列**整个不存在**（判据是那一列上没有会话名）
    expect(sidebarOf(stripAnsi(ui.snapshot())).join("\n")).not.toContain("会话 1");
    // ⚠️ 敲第一个字 ⇒ 会话回来了（而**输入的那一串留在输入行里**）
    await ui.feed([...typed("hello")]);
    await ui.feed([ENTER]);
    const output = stripAnsi(await ui.finish());
    expect(sidebarOf(output).join("\n")).toContain("会话 2");
    expect(inputOf(output)).toEqual([""]);
    expect(output).toContain("❯ hello");
    expect(output).toContain(NO_PROVIDER);
  });

  it("⚠️ 零会话那一档里**光标键也造得出会话**（正向对照：不是只有可打印字符那一条路）", async () => {
    const ui = await mount({ interactive: false, ledgerFile: ledger() });
    await ui.feed([CTRL_X]);
    expect(sidebarOf(stripAnsi(ui.snapshot())).join("\n")).not.toContain("会话 1");
    await ui.feed([RIGHT]);
    await ui.feed([...typed("hi")]);
    const output = stripAnsi(await ui.finish());
    expect(sidebarOf(output).join("\n")).toContain("会话 2");
    expect(inputOf(output, { input: "hi" })).toEqual(["hi"]);
  });
});