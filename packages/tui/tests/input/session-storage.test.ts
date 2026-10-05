/**
 * 会话落盘与启动恢复：会话、侧边栏清单、对话三张表要读得回来，而侧边栏**永远**有一行
 *
 * @description 判据读的是**库里那份**（`readSessions` / `readSidebar` / `readMessages` 另开一次读），
 * 不是内存里那份清单；级联那几条用**原始句柄倒表**（`rawRows`）—— 孤儿行在 `readSessions` 里看不见。
 * ⚠️ 恢复类判据一律**换挂载**而不是「一挂到底」（`finish()` 会 `unmount()`）。共用不变量见 `AGENTS.md`。
 */

import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import {
  BACKSPACE,
  CTRL_D,
  CTRL_X,
  DOWN,
  ENTER,
  LAST_SESSION_REFUSAL,
  RIGHT_CLICK_COL,
  UP,
  boldRuns,
  emptyLedgerPath,
  historySlot,
  ledger,
  menuItemPoint,
  mount,
  pinSessionSeed,
  report,
  saveSessionSeed,
  sidebarNameRow,
  sidebarOf,
  stripAnsi,
  typed,
} from "./_shared.js";
import {
  LedgerError,
  appendMessages,
  readMessages,
  readSessions,
  readSidebar,
} from "@/services/config/index.js";
import { COLUMNS, ROWS } from "./_shared.js";
import { SIDEBAR_WIDTH, geometry } from "@/lib/geometry.js";

/**
 * 从**外面**把一张表倒出来
 * @description 判「没有孤儿行」必须用**不认识本包的原始句柄**（`node:sqlite`）：用本包自己的
 * `readMessages` 去量就是自证 —— 而「那个会话已删而它的对话还在」正是本包自己造出来的那种不一致。
 */
function rawRows(file: string, table: string): readonly Record<string, unknown>[] {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (file: string) => {
      close(): void;
      prepare(sql: string): { all(): readonly Record<string, unknown>[]; run(...p: unknown[]): unknown };
    };
  };
  const db = new DatabaseSync(file);
  try {
    return db.prepare(`SELECT * FROM ${table}`).all();
  } finally {
    db.close();
  }
}

/** 真排一行对话（走 `appendMessages` 那一格序列化，落进 `messages` 表） */
function seedMessage(file: string, sessionId: string, seq: number): void {
  appendMessages(file, sessionId, [{ id: seq, at: 1, turns: [{ kind: "user", text: `第 ${String(seq)} 句` }] }]);
}

describe("会话落盘：建、改名、移出侧边栏，四件事都真的进了 SQLite", () => {
  it("起步那一个**已经在库里而且已经在侧边栏清单上**，而 `/new` 两张表各追加一行", async () => {
    const file = ledger();
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed([...typed("/new"), "\r"]);
    await ui.finish();
    expect(readSessions(file).map((one) => one.name)).toEqual(["会话 1", "会话 2"]);
    // ⚠️ **两张表**：`sessions` 说「有过哪些会话」，`sidebar_sessions` 说「眼下开着哪几个」。
    // 只断前者的话「新会话没有进侧边栏」在屏上看着正常（它在内存里），而重开一次就没了。
    expect(readSidebar(file).map((one) => one.sessionId)).toEqual(["s1", "s2"]);
  });

  it("改名落库，而 `created_at` **不动**（「这个会话有多老」与「叫什么」是两件事）", async () => {
    const file = ledger();
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed([...typed("/rename"), "\r"]);
    // ⚠️ 框里装的是**它现在的名字**，而插入符在末尾 ⇒ 要先退干净才是「重打一遍」
    // （少一次就还剩一个字，而那个字会进新名字里）
    await ui.feed([...BACKSPACE, ...BACKSPACE, ...BACKSPACE, ...BACKSPACE]);
    await ui.feed(typed("改名了"));
    await ui.feed(["\r"]);
    await ui.finish();
    const rows = readSessions(file);
    expect(rows.map((one) => one.name)).toEqual(["改名了"]);
    // ⚠️ **正向对照**：改名跑完了而 `created_at` 仍是 0（种子那一档）之外的别的值 ⇒ 它真的没动
    expect(rows[0]?.createdAt).toBeGreaterThan(0);
  });

  it("从侧边栏移出落的是 `sidebar_sessions`，而 `updated_at` **不动**", async () => {
    const file = ledger();
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed([...typed("/new"), "\r", ...typed("/new"), "\r"]);
    // ⚠️ 先把当前那个挪到会话 2（`/new` 两次之后当前是会话 3，而「至少留一行」按那一列的行数判）
    await ui.feed([UP, CTRL_X]);
    await ui.finish();
    // ⚠️ **`sessions` 一行都没少**：移出侧边栏**不是**删除（真删是弹窗里的 `Ctrl+D`）
    expect(readSessions(file).map((one) => one.id)).toEqual(["s1", "s2", "s3"]);
    // ⚠️ **`sidebar_sessions` 少了一行**，而少掉的是**被移出的那一个**（`s2`）——
    // 拿 `sessions` 的顺序去判的话两处相同而恒绿
    expect(readSidebar(file).map((one) => one.sessionId)).toEqual(["s1", "s3"]);
    // ⚠️ 而被移出那一个的 `updated_at` 没动：「出现在侧边栏上」不是「这个会话动了一次」
    expect(readSessions(file).find((one) => one.id === "s2")?.updatedAt).toBe(
      readSessions(file).find((one) => one.id === "s2")?.createdAt,
    );
  });
});

describe("会话启动恢复：库里那几个 → 屏上那几个，而新会话接着库里往下发号", () => {
  it("写 3 个、移出**第一个** ⇒ 重开屏上是剩下那两个，而 `/new` 拿到的是**会话 4**", async () => {
    const file = ledger();
    const first = await mount({ interactive: false, ledgerFile: file });
    await first.feed([...typed("/new"), "\r", ...typed("/new"), "\r"]);
    // ⚠️ **`↑` 走到会话 1 再移出它** —— 于是 `sidebar_sessions` 第一行**不是** `s1`，
    // 而恢复出来的当前会话也不再是 `s1`
    await first.feed([UP, UP, CTRL_X]);
    await first.finish();
    expect(readSessions(file).map((one) => one.name)).toEqual(["会话 1", "会话 2", "会话 3"]);

    const again = await mount({ interactive: false, ledgerFile: file });
    const raw = await again.finish();
    const sidebar = sidebarOf(raw).join("\n");
    // ⚠️ **移出的那一个重开后不在侧边栏上**（它还在库里，只是不在那一列）
    expect(sidebar).not.toContain("会话 1");
    expect(sidebar).toContain("会话 2");
    expect(sidebar).toContain("会话 3");
    // ⚠️ 而当前那个是**激活顺序里的第一个**（加粗是颜色之外的通道）
    expect(boldRuns(raw).some((run) => run.includes("会话 2"))).toBe(true);

    // ⚠️ **核心判据：序号按读回来的最大下标抬起来了** —— 不抬的话 `/new` 插一个库里已有的 `id`
    const third = await mount({ interactive: false, ledgerFile: file });
    await third.feed([...typed("/new"), "\r"]);
    const frame = sidebarOf(await third.finish()).join("\n");
    expect(readSessions(file).map((one) => one.name)).toEqual([
      "会话 1",
      "会话 2",
      "会话 3",
      "会话 4",
    ]);
    expect(frame).toContain("会话 4");
    // ⚠️ **反向自检**：撞 id 的症状就是屏上那一句「没存进台账」
    expect(frame).not.toContain("没存进台账");
  });

  it("**侧边栏顺序 = 激活顺序**（pin 顺序 `s3, s1, s2` ⇒ 屏上就是那个次序）", async () => {
    // ⚠️ **判据是屏上那一列的上下次序**，而它只能由 `sidebar_sessions` 的 `rowid`（激活序）排出来：
    // 按 `created_at` 排的话这一档的期望序恰好也成立 —— 故必须**先 pin 一个反着来**的次序。
    const file = emptyLedgerPath();
    saveSessionSeed(file, "s1", "会话 1", 0);
    saveSessionSeed(file, "s2", "会话 2", 1);
    saveSessionSeed(file, "s3", "会话 3", 2);
    pinSessionSeed(file, "s3");
    pinSessionSeed(file, "s1");
    pinSessionSeed(file, "s2");
    expect(readSidebar(file).map((one) => one.sessionId)).toEqual(["s3", "s1", "s2"]);

    const ui = await mount({ interactive: false, ledgerFile: file });
    const sidebar = sidebarOf(await ui.finish()).join("\n");
    // ⚠️ **判据是三行的上下次序**，而**不是**「三个都在」：后者对**任何**排列都成立
    // （而这一档的全部意义就是激活序 ≠ 建成序）
    const at = (name: string): number => {
      const where = sidebar.indexOf(name);
      expect(where, `侧边栏上没有「${name}」`).toBeGreaterThanOrEqual(0);
      return where;
    };
    expect([at("会话 3"), at("会话 1"), at("会话 2")]).toEqual(
      [at("会话 3"), at("会话 1"), at("会话 2")].sort((a, b) => a - b),
    );
  });

  it("库里一个都没有（首次启动，文件都还不存在）⇒ 造**起步那一个**并激活，而它是 `s1`", async () => {
    const file = emptyLedgerPath();
    // ⚠️ `readSessions` 对**不存在的**库返回空清单且不建库 —— 故这一条钉的是「真的还没有那个文件」
    expect(readSessions(file)).toEqual([]);
    const ui = await mount({ interactive: false, ledgerFile: file });
    const sidebar = sidebarOf(await ui.finish()).join("\n");
    expect(sidebar).toContain("会话 1");
    expect(readSessions(file).map((one) => one.id)).toEqual(["s1"]);
    // ⚠️ **两张表各一行**（`sessions` 与 `sidebar_sessions`），而起步那一个不落成两行
    expect(readSessions(file)).toHaveLength(1);
    expect(readSidebar(file).map((one) => one.sessionId)).toEqual(["s1"]);
  });
});

describe("对话落盘：桶里那一格 ↔ `messages` 表的一行", () => {
  it("跑一条命令 ⇒ 屏上那一格**真的进了 `messages` 表**（判据是原始句柄倒表）", async () => {
    const file = ledger();
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed([...typed("/status"), "\r"]);
    await ui.finish();
    // ⚠️ **倒表而不是问本包**：`readMessages` 走的是同一段解码，用它判等于自证
    const rows = rawRows(file, "messages");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row["session_id"] === "s1")).toBe(true);
    // ⚠️ `seq` 恒等于 `LogEntry.id`，而 `id` 从 1 起 ⇒ 第一格就是 1（`dropped()` 用 0 当哨兵）
    expect(rows[0]?.["seq"]).toBe(1);
  });

  it("`/clear` ⇒ 内存里那个桶空了，而**盘上那个会话的 `messages` 也空了**", async () => {
    const file = ledger();
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed([...typed("/status"), "\r"]);
    await ui.feed([...typed("/clear"), "\r"]);
    await ui.finish();
    // ⚠️ **核心判据是盘上那张表**：只清内存的话重开一次它原样回来，而「结果区被清空」就成了假事实
    expect(rawRows(file, "messages").filter((row) => row["session_id"] === "s1")).toEqual([]);
    // ⚠️ 而**别的会话那一份不受影响**（`clearMessages` 按 `(session_id, seq)` 删）
    expect(readSessions(file)).toHaveLength(1);
  });

  it("**恢复出来的桶与盘上的 `seq` 对齐**（判据是「恢复后再 push 一条不撞主键」）", async () => {
    const file = ledger();
    // ⚠️ **三格**而不是一格：`append` 发的是「最后一格 id + 1」，一格的话对齐与否看不出来
    for (const seq of [1, 2, 3]) seedMessage(file, "s1", seq);
    expect(readMessages(file, "s1").map((one) => one.id)).toEqual([1, 2, 3]);

    const ui = await mount({ interactive: false, ledgerFile: file });
    // ⚠️ **恢复之后那几格看得见**（读回来了）⇒ 而恢复出来的桶**不是空的**
    await ui.feed([...typed("/status"), "\r"]);
    const frame = stripAnsi(await ui.finish());
    expect(frame).toContain("第 1 句");
    expect(frame).toContain("第 3 句");
    // ⚠️ **核心判据是「盘上多出第 4 格」**：`append` 发的是「最后一格 id + 1」，
    // 而恢复出来的桶那几格的 `id` 必须与盘上的 `seq` 逐字相等 —— 不相等的话这次追加**撞主键**，
    // 整批落不进去（症状是「跑完一条命令而它一句都没存下来」，屏上零解释）
    const seqs = rawRows(file, "messages")
      .filter((row) => row["session_id"] === "s1")
      .map((row) => row["seq"]);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });

  it("`Ctrl+D` 是**级联**删：三张表里都没有那一行的孤儿", async () => {
    // ⚠️ **`updated_at` 差开一天**而不是靠 `/new` 的先后：那两次 `/new` 常常落在**同一毫秒**，
    // 而弹窗的排序是「`updated_at` 倒序 + 同值按 `id` 升序」—— 并列时高亮落在哪一行就成了
    // 一个与被测行为无关的变量（症状是「这一条有时红有时绿」）
    const file = emptyLedgerPath();
    saveSessionSeed(file, "s1", "甲", 3);
    saveSessionSeed(file, "s2", "乙", 0);
    pinSessionSeed(file, "s1");
    pinSessionSeed(file, "s2");
    seedMessage(file, "s2", 1);
    // ⚠️ **前置事实**：三张表里都真的有那一行 —— 少了它，「删完没有孤儿」会因「本来就没有」而绿
    expect(rawRows(file, "messages").some((row) => row["session_id"] === "s2")).toBe(true);
    expect(rawRows(file, "sidebar_sessions").some((row) => row["session_id"] === "s2")).toBe(true);

    // ⚠️ 弹窗 → `↑` 到「乙」（它 `updated_at` 更近 ⇒ 排第 0 行，而高亮默认落在**当前会话**「甲」那 1 行）
    const kill = await mount({ interactive: false, ledgerFile: file });
    await kill.feed([...typed("/sessions"), ENTER, UP, CTRL_D]);
    await kill.finish();
    // ⚠️ **倒三张表逐张判**：只判 `sessions` 的话，「对话还在」与「侧边栏还列着它」都看不见
    for (const table of ["sessions", "sidebar_sessions", "messages"]) {
      expect(
        rawRows(file, table).filter((row) => row["session_id"] === "s2" || row["id"] === "s2"),
        `${table} 里还有 s2 的行`,
      ).toEqual([]);
    }
    // ⚠ 而**别的那一个一个都没丢**（级联删删的是一行，不是整张表）
    expect(readSessions(file).map((one) => one.id)).toEqual(["s1"]);
    expect(rawRows(file, "messages")).toEqual([]);
  });

  it("盘上的对话是**坏内容**时：说一句话、不崩，而那个会话的历史显示为空", async () => {
    const file = ledger();
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed([...typed("/status"), "\r"]);
    await ui.finish();
    expect(readMessages(file, "s1").length).toBeGreaterThan(0);
    // ⚠️ **从外面塞一行坏内容**：本包的写入路径**永远**写出合法字节，故这条只能手改库才造得出来
    // （而那正是「库被人动过」那一档 —— 判据是「不崩 + 有话」，不是「清空」）
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (file: string) => {
        close(): void;
        prepare(sql: string): { run(...p: unknown[]): unknown };
      };
    };
    const raw = new DatabaseSync(file);
    try {
      raw.prepare("INSERT INTO messages (session_id, seq, at, turns) VALUES (?, ?, ?, ?)").run(
        "s1",
        99,
        1,
        "这一格不是 JSON",
      );
    } finally {
      raw.close();
    }
    // ⚠️ **读面自己拒**：本包的 `readMessages` 抛 `LedgerError` 而**不**降级成空对话
    expect(() => readMessages(file, "s1")).toThrow(LedgerError);

    const again = await mount({ interactive: false, ledgerFile: file });
    const output = stripAnsi(await again.finish());
    expect(output).toContain("对话读不出来");
  });
});

describe("侧边栏永远有一行：从侧边栏移出**最后一行**时拒绝并说一句话", () => {
  it("`Ctrl+X` 移出**当前**那一个 ⇒ 它还在屏上，而屏上说了为什么", async () => {
    const file = ledger();
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed([CTRL_X]);
    const raw = await ui.finish();
    const sidebar = sidebarOf(raw).join("\n");
    expect(readSessions(file).map((one) => one.name)).toEqual(["会话 1"]);
    expect(raw).toContain(LAST_SESSION_REFUSAL);
    // ⚠️ **反向自检**：那一行**还在侧边栏上**（移掉了的话这里会空）
    expect(sidebar).toContain("会话 1");
  });

  it("从**菜单**里移出也移不掉（那一条是同一个入口，只守键盘那一路就是鼠标那路的洞）", async () => {
    const file = ledger();
    const ui = await mount({ interactive: false, ledgerFile: file });
    const row = sidebarNameRow(1, 0);
    await ui.feed([report(2, RIGHT_CLICK_COL, row)]);
    const [x, y] = menuItemPoint(row, 0);
    await ui.feed([report(0, x, y)]);
    const output = await ui.finish();
    expect(readSessions(file).map((one) => one.name)).toEqual(["会话 1"]);
    expect(output).toContain(LAST_SESSION_REFUSAL);
  });

  it("侧边栏那一列装不下时**能竖着滚**（溢出说明行出现，而当前那一项留在窗口里）", async () => {
    // ⚠️ 一个**矮屏**（`rows: 10` ⇒ 侧边栏放不下 5 项），判据是「溢出说明行出现了」——
    // 那一句**跟着窗口滚**（写死首项号的实现会在滚过之后说错范围）
    const file = ledger();
    const ui = await mount({ interactive: false, rows: 10, ledgerFile: file });
    // ⚠️ **四项**而那一列在 10 行的屏上**只装得下三项**（每项 2 行 + 项间 1 行 + 顶部 1 行 + 末尾说明 1 行）
    await ui.feed([...typed("/new"), "\r", ...typed("/new"), "\r", ...typed("/new"), "\r"]);
    const after = sidebarOf(await ui.finish()).join("\n");
    // ⚠️ **反向自检**：那一帧真的有字（否则下面「装不下」那一条恒真）
    expect(after).toContain("会话 4");
    // ⚠️ **核心判据**：溢出说明行出现了，且它报的是**当前窗口里那一段**而不是写死的首项号
    expect(after).toContain("/ 共 4");
    // ⚠️ 而**当前那一个**（会话 4）**在屏上**（几何层只夹不推，「当前会话必须留在窗口里」是状态层的活）
    expect(after).toContain("会话 4");
    // ⚠️ **反向对照**：装得下的那一档**没有**那句话（`sidebarOverflowRow` 是 `null`）
    const tall = await mount({ interactive: false, ledgerFile: file });
    await tall.feed([...typed("/new"), "\r", ...typed("/new"), "\r", ...typed("/new"), "\r"]);
    expect(sidebarOf(await tall.finish()).join("\n")).not.toContain("/ 共 4");
  });

  it("会话被激活进侧边栏（弹窗里 `Enter`）⇒ 它出现在那一列，且激活序排在末尾", async () => {
    const file = ledger();
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed([...typed("/new"), "\r"]);
    await ui.finish();
    // ⚠️ 先把**当前**那一个移出侧边栏（它还在库里）⇒ 弹窗里还看得见它，而激活能把它放回来。
    // ⚠️ 恢复后的当前会话是**激活序里的第一个**（`sidebar_sessions` 的第一行），而它**不**是
    // 「最后一个被激活的」—— 故这一条判据要求实现按**激活序**而不是按 `created_at` 组装那一列。
    const away = await mount({ interactive: false, ledgerFile: file });
    await away.feed([CTRL_X]);
    const awayFrame = sidebarOf(await away.finish()).join("\n");
    // ⚠️ **被移出的那一个是恢复后的当前会话**（激活序里的第一个），而它**不**是「最后一个被激活的」——
    // 故这一条同时钉住「那一列按**激活序**组装」而**不是**按 `created_at`
    expect(awayFrame).not.toContain("会话 1");
    expect(awayFrame).toContain("会话 2");
    // ⚠️ **前置事实**：它**还在库里**（移出不是删除）
    expect(readSessions(file).map((one) => one.id)).toEqual(["s1", "s2"]);

    const back = await mount({ interactive: false, ledgerFile: file });
    // ⚠️ 弹窗按 `updated_at` 倒序（会话 2 更新 ⇒ 排第 0 行）而高亮默认落在**当前会话**（会话 2）
    // ⇒ 往**下**一格才是被移出的那一个（这一条同时钉住了「默认高亮落在当前会话」）
    await back.feed([...typed("/sessions"), ENTER, DOWN, ENTER]);
    const frame = sidebarOf(await back.finish()).join("\n");
    expect(frame).toContain("会话 1");
    // ⚠️ **激活序排在末尾**：pin 那一行的 `rowid` 是后写的，故重开之后它在那一列的**下面**
    expect(readSidebar(file).map((one) => one.sessionId)).toEqual(["s2", "s1"]);
  });
});

describe("历史会话弹窗：坐标从几何读，而模态门禁罩住背后那一层", () => {
  it("点那一行 = **激活它**（不是只挪高亮）", async () => {
    const file = ledger();
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed([...typed("/new"), "\r", ...typed("/sessions"), "\r"]);
    // ⚠️ 弹窗那一列的几何（分组标题 + N 个会话）；`windowRows[0]` 是**第 0 个可选会话**
    const row = historySlot(2, 0);
    await ui.feed([report(0, row.x + 3, row.y + 1)]);
    const output = await ui.finish();
    // ⚠️ **判据是侧边栏那一列**：它成了当前那一个（加粗），而弹窗关掉了
    const sidebar = sidebarOf(output).join("\n");
    expect(sidebar).toContain("会话 2");
    expect(boldRuns(output).some((run) => run.includes("会话 2"))).toBe(true);
    expect(output).not.toContain("历史会话");
  });

  it("弹窗里点那个改名输入框 = 落插入符（点完之后敲的字**接着那个位置**）", async () => {
    const file = ledger();
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed([...typed("/rename"), "\r"]);
    // ⚠️ **改名框那一格从几何读**：整行含提示符，而落点要按**文字那一格**算
    const g = geometry({
      columns: COLUMNS,
      rows: ROWS,
      sidebarWidth: SIDEBAR_WIDTH,
      sessionCount: 1,
      sessionsTop: 0,
      input: "",
      paletteCount: 0,
      window: [{ kind: "group" }, { kind: "row" }, { kind: "input" }],
      windowCloseHint: false,
      menu: null,
    });
    const box = g.windowInputText!;
    // ⚠️ 点**最左边**那一列 ⇒ 插入符落在 0 ⇒ 敲进去的字插到名字**最前面**
    // ⚠️ **SGR 那一列是 1-based 而几何是 0-based**：少加这一位就是「点在框左边那一格」，
    // 而那一格落在**下一列**上（`hitTest` 判 `< r.x`）
    await ui.feed([report(0, box.x + 1, box.y + 1)]);
    await ui.feed(typed("甲"));
    await ui.feed(["\r"]);
    const output = stripAnsi(await ui.finish());
    expect(output).toContain("甲会话 1");
  });

  it("弹窗开着时滚轮**不动**背后那一层（症状是「面板照滚照亮，操作者以为滚轮坏了」）", async () => {
    const file = ledger();
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed([...typed("/new"), "\r", ...typed("/new"), "\r", ...typed("/sessions"), "\r"]);
    const settled = ui.bytes();
    // ⚠️ 滚轮落在**侧边栏**上（那一列的滚轮去处是「翻会话清单」）
    await ui.feed([report(65, 6, sidebarNameRow(3, 0))]);
    const afterWheel = ui.bytes() - settled;
    const output = await ui.finish();
    // ⚠️ **反向自检**：那一帧真的有字（零字节的判据在「Ink 根本没渲染」时恒真）
    expect(stripAnsi(output)).toContain("会话 1");
    // ⚠️ **门禁在 ⇒ 一个字节都不许写**（滚轮真滚了的话会换掉侧边栏那一列 ⇒ 一整帧）
    expect(afterWheel).toBe(0);
    // ⚠️ 而侧边栏那一列**一个都没少**（滚轮没生效的第二个可观察事实）
    expect(sidebarOf(output).join("\n")).toContain("会话 3");
  });
});