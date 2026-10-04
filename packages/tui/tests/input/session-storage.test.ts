/**
 * 会话落盘与启动恢复：写进去的四件事要读得回来，而侧边栏**永远**有一行
 * @description 判据读的是**库里那份**（`readSessions` 另开一次读），不是内存里那份清单。
 * ⚠️ 恢复类判据一律**换挂载**而不是「一挂到底」（`finish()` 会 `unmount()`）。共用不变量见 `AGENTS.md`。
 */

import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { boldRuns, CTRL_X, LAST_SESSION_REFUSAL, RIGHT_CLICK_COL, emptyLedgerPath, hide, ledger, menuItemPoint, mount, report, show, sidebarNameRow, sidebarOf, typed } from "./_shared.js";
import { readSessions, setSessionVisible } from "@/services/config/index.js";

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
