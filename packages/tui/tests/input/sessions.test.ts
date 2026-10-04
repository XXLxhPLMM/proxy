/**
 * 会话这一列上看得见的几件事：改名框、`/session hide|show`、以及「你还没看」那一枚记号
 * @description 每一格都有**纯键盘**的第二路（右键在很多终端里压根到不了，见 `packages/tui/AGENTS.md`）。
 * ⚠️ 共用的不变量与那张变异表见 `AGENTS.md`。
 */

import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { CTRL_R, CTRL_X, RIGHT_CLICK_COL, hide, ledger, menuItemPoint, mount, renderAndFeed, report, show, sidebarNameRow, sidebarOf, stripAnsi, typed } from "./_shared.js";

/** 改名框开着时输入区那一行说的话（只认开头那一截，理由同 `_shared.ts` 里 `LAST_SESSION_REFUSAL`） */
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
