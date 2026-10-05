/**
 * 命令面板（`/` 敲出来的那一块）：四个入口走同一份实现
 * @description 面板开着与关着时那些键位各自归谁、`↓`/`Tab` 落到输入行上的什么、回车之后那一行去了哪儿。
 * ⚠️ 共用的不变量与那张变异表见 `AGENTS.md`。
 */

import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { COLUMNS, HELP_TABLE_MARK, PALETTE_TOTAL, ROWS, paletteInput, paletteRowY, renderAndFeed, report, stripAnsi } from "./_shared.js";
import { PALETTE_ROWS } from "@/commands/palette.js";
import { geometry, PALETTE_MAX_RATIO } from "@/lib/geometry.js";

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
    expect(output).toContain("还没配模型提供商");
  });

  it("⚠️ 真的**没有 provider** 时那句话留在屏上，一句判据跟着（不许崩、不许静默）", async () => {
    // ⚠️ **反向自检**（同一个探针在「配了 provider」那一档里必须找得到别的说法）：
    // 空台账 ⇒ provider 也没配 ⇒ 这一圈一个请求都不发
    const { output } = await renderAndFeed(["查", "一", "下", "\r"]);
    expect(output).toContain("❯ 查一下");
    expect(output).toContain("还没配模型提供商");
    // ⚠️ **指引指向那个弹窗**（零兼容之下「配 provider」不再是命令了）
    expect(output).toContain("/providers");
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
