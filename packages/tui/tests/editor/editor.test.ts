/**
 * 输入编辑的**纯算术**：选区规范化 / 替换 / 换行 / 按显示列上下移 / 命令历史。
 *
 * @description 这一档是 `@/lib/editor.ts` 的**全部**判据，而它之所以能被逐字断言，是因为那一个文件
 * 零 React、零终端、零 IO（不读时钟、不碰随机数）—— 与 `@/lib/geometry.ts` 同一份前提。
 *
 * ⚠️ **下标一律 UTF-16 code unit**，与 `@/lib/input-line.ts` / `@/lib/geometry.ts` 同一套。
 * ⚠️ **折行由几何层那份 `wrapInput` 算**（`caretUp` / `caretDown` 不自己折一遍），
 * 而本档喂的 `width` 就是那份折行的每行显示列数 —— 换句话说「本档的 `width`」与
 * 「几何层给的 `textWidth`」是同一个数，不是两个各填各的。
 *
 * 判据为什么这么写（三条，各自有牙齿）：
 *
 * - **负向断言一律配正向对照**：同一个 `it` 里喂一个真能过的输入（见各处 ⚠️）。
 *   根 `AGENTS.md`「写护栏时」：判据坏了 ⇒ 「什么都不做」也满足它。
 * - **期望值写算式、不写常量**：拿 `INPUT_HISTORY` / 折行宽度当期望值的话，
 *   「改常量」与「改实现」同时发生就恒绿。
 * - **CJK 用例是真的**：按 `String.length` 折的那一版在纯 ASCII 上与按显示列折的完全一样，
 *   而这一档问的恰恰是「按显示列」—— 故汉字、代理对两类都要有。
 *
 * @module tests/editor
 */

import { describe, expect, it } from "vitest";

import {
  caretAtFirstRow,
  caretAtLastRow,
  caretDown,
  caretUp,
  deleteSelection,
  historyNext,
  historyPrev,
  insertNewline,
  normalizeSelection,
  pushHistory,
  replaceSelection,
} from "@/lib/editor.js";
import { wrapInput } from "@/lib/geometry.js";
import { INPUT_HISTORY } from "@/store/index.js";

/** 一段宽 20 列的输入区（每行 20 个显示列；汉字占 2 列 ⇒ 每行 10 个汉字） */
const W = 20;

/* ── 选区规范化 ─────────────────────────────────────────────────────── */

describe("选区规范化：`normalizeSelection`（`anchor === null` ⇒ 空选区）", () => {
  it("没有锚点 ⇒ 空选区落在插入符上（点一下输入行的那一帧）", () => {
    expect(normalizeSelection("abcdef", null, 3)).toEqual({ start: 3, end: 3 });
  });

  it("⚠️ **反向拖动归一化**（从后往前拖与从前往后拖是同一段，而呈现层只画得出一段）", () => {
    expect(normalizeSelection("abcdef", 2, 5)).toEqual({ start: 2, end: 5 });
    expect(normalizeSelection("abcdef", 5, 2)).toEqual({ start: 2, end: 5 });
  });

  it("锚点正好在插入符上 ⇒ 也是空选区（单击不拖）", () => {
    expect(normalizeSelection("abcdef", 3, 3)).toEqual({ start: 3, end: 3 });
  });

  it("⚠️ 两端都**夹进串长**（越界的下标是拖出框的那一次，而它不许切出半个代理对）", () => {
    expect(normalizeSelection("abc", 99, -5)).toEqual({ start: 0, end: 3 });
    expect(normalizeSelection("abc", 1, 99)).toEqual({ start: 1, end: 3 });
    // ⚠️ **正向对照**：合法的一对下标原样通过（否则上面那一条是「永远返回 {0, len}」的恒绿）
    expect(normalizeSelection("abcdef", 1, 4)).toEqual({ start: 1, end: 4 });
  });

  it("⚠️ 下标落在**代理对中间**也照样夹住（不切出半个字形）", () => {
    // "😀" 是两个 code unit；锚点 1 正落在中间
    const text = "😀x";
    expect(text.length).toBe(3);
    expect(normalizeSelection(text, 1, 3)).toEqual({ start: 1, end: 3 });
  });
});

/* ── 替换选区 ─────────────────────────────────────────────────────── */

describe("替换选区：`replaceSelection`（输入 / 退格 / 删除 / 提交的共同入口）", () => {
  it("有选区 ⇒ 整段被吃掉，插入符落在插入点之后", () => {
    expect(replaceSelection("abcdef", { start: 1, end: 4 }, "X")).toEqual({
      text: "aXef",
      cursor: 2,
    });
  });

  it("⚠️ **空选区就是纯插入**（可打印键的路径；它必须与选区路径是同一个算式）", () => {
    expect(replaceSelection("abcdef", { start: 3, end: 3 }, "X")).toEqual({
      text: "abcXdef",
      cursor: 4,
    });
  });

  it("⚠️ **整串替换**（全选之后打字）：屏上不能留下一个字符", () => {
    expect(replaceSelection("abcdef", { start: 0, end: 6 }, "Z")).toEqual({ text: "Z", cursor: 1 });
  });

  it("删除整段选区：`deleteSelection` = 替换成空串", () => {
    expect(deleteSelection("abcdef", { start: 2, end: 5 })).toEqual({ text: "abf", cursor: 2 });
    // ⚠️ **正向对照**：空选区是 no-op 且插入符不动（「没选东西」时退格该走另一个算式）
    expect(deleteSelection("abcdef", { start: 3, end: 3 })).toEqual({ text: "abcdef", cursor: 3 });
  });

  it("⚠️ 下标越界的选区也被夹住（拖出框的那一次不许插到串外面去）", () => {
    expect(replaceSelection("abc", { start: 1, end: 99 }, "X")).toEqual({ text: "aX", cursor: 2 });
  });

  it("代理对那一段整段被吃掉（不留下半个字形）", () => {
    const text = "a😀b";
    expect(replaceSelection(text, { start: 1, end: 3 }, "X")).toEqual({ text: "aXb", cursor: 2 });
  });
});

/* ── 换行插入 ─────────────────────────────────────────────────────── */

describe("换行：`insertNewline`（`Ctrl+Enter` / `Alt+Enter` 走这一条插入路径）", () => {
  it("在插入符处插入一个换行，插入符落在换行之后", () => {
    expect(insertNewline("abcd", { start: 2, end: 2 })).toEqual({
      text: "ab\ncd",
      cursor: 3,
    });
  });

  it("⚠️ **有选区时换行替换整段**（不是「在选区旁边插一个换行」）", () => {
    expect(insertNewline("abcdef", { start: 1, end: 4 })).toEqual({ text: "a\nef", cursor: 2 });
  });

  it("⚠️ 插入之后**折行认得出两行**（那正是这一格存在的原因：绘制与命中测试靠它）", () => {
    const { text, cursor } = insertNewline("abcd", { start: 2, end: 2 });
    const rows = wrapInput(text, W);
    expect(rows).toEqual([
      { text: "ab", start: 0 },
      { text: "cd", start: 3 },
    ]);
    // 光标在换行之后 ⇒ 落在**第 1 行**（不是第 0 行末尾）—— 而这一格就是「换行之后光标该在哪」
    expect(cursor).toBe(rows[1]!.start);
  });

  it("⚠️ **`\n` 不经 `printableOnly`**：粘贴进来的控制字节仍被剔掉，而换行是被放行的那个", () => {
    // 判据形状是两件事各有一个正例：`\n` 插得进去、`\u0007`（BEL）插不进去
    expect(insertNewline("a", { start: 1, end: 1 }).text).toBe("a\n");
  });
});

/* ── 上下移动插入符（按显示列） ─────────────────────────────────────── */

describe("上下移动：`caretUp` / `caretDown`（按**显示列**保持同一列）", () => {
  it("ASCII 行：停在同一列（两行等宽时的基准档）", () => {
    const text = "abcdefghij\nklmnopqrst";
    // 第 1 行第 3 列（`n` 之前，下标 14）⇒ 上一行第 3 列（`d` 之前，下标 3）
    expect(caretUp(text, 14, W)).toBe(3);
    expect(caretDown(text, 3, W)).toBe(14);
    // ⚠️ **正向对照**：行末也停得住（不是只有行内那一档走得动）
    expect(caretUp(text, 21, W)).toBe(10);
  });

  it("⚠️ **CJK 按显示列而不是按字符个数**（这是这一档存在的理由）", () => {
    // ⚠️ 判据形状是**同一件事的两个算法给不同答案**：下一行第 1 个**列**
    // 往上一行找时，按显示列落在「汉」**之前**（第 0 列，汉字那一格占 0–1 列），
    // 按字符个数落在「汉」**之后** —— 差一个字形，屏上是光标偏一格。
    const text = "汉字\nabc";
    expect(caretUp(text, 4, W)).toBe(0);
    expect(caretDown(text, 1, W)).toBe(5);
    // ⚠️ **正向对照**：反方向真的走得动（否则上面两条是「恒返回行首」的恒绿）
    expect(caretDown(text, 0, W)).toBe(3);
    expect(caretUp(text, 3, W)).toBe(0);
  });

  it("⚠️ **目标行短于那一列时落到行末**（不是绕回行首继续找）", () => {
    // 第 0 行 10 列、第 1 行只有 2 列
    const text = "abcdefghij\nxy";
    // 第 0 行第 8 列往下 ⇒ 第 1 行只有 2 列，于是落在它的行末
    expect(caretDown(text, 8, W)).toBe(13);
    // ⚠️ 而目标行**够长**时它停在那**同一列**，不是行末（这一条是上面那条的另一半）
    expect(caretUp(text, 13, W)).toBe(2);
    // ⚠️ **正向对照**：目标行恰好吃到那一列时，两者一致（否则上面两条是「恒落行末」的恒绿）
    expect(caretDown(text, 0, W)).toBe(11);
  });

  it("⚠️ 软折出来的行也算「上一行」（不是只认 `\\n` 分段的那些行）", () => {
    // 宽 6 ⇒ 第一段 6 列折成两行，第二段 6 列一行
    const text = "abcdefghij\nklm";
    const rows = wrapInput(text, 6);
    expect(rows).toHaveLength(3);
    // 第 1 段第 2 行第 1 列（`g`）往上 ⇒ 第 1 行第 1 列（`a`）
    expect(caretUp(text, 6, 6)).toBe(rows[0]!.start);
    expect(caretDown(text, rows[0]!.start, 6)).toBe(rows[1]!.start);
  });

  it("⚠️ 首行按 `↑` 与末行按 `↓` 都给 `null`（那是「去问历史」的判据，不是 no-op）", () => {
    const text = "abc\ndef";
    expect(caretUp(text, 1, W)).toBeNull();
    expect(caretDown(text, 5, W)).toBeNull();
    // ⚠️ **正向对照**：反方向都真的给得下一个下标（否则上面两条是「恒返回 null」的恒绿）
    expect(caretDown(text, 1, W)).toBe(5);
    expect(caretUp(text, 5, W)).toBe(1);
  });

  it("单行输入 ⇒ 两个方向都 `null`（历史那一档在单行上是常态）", () => {
    expect(caretUp("/status", 3, W)).toBeNull();
    expect(caretDown("/status", 3, W)).toBeNull();
  });

  it("⚠️ 越界的插入符先夹住再算（不返回负下标，也不返回串长之外的下标）", () => {
    const text = "abc\ndef";
    for (const cursor of [-5, 0, 7, 99]) {
      const up = caretUp(text, cursor, W);
      const down = caretDown(text, cursor, W);
      for (const at of [up, down]) {
        if (at === null) continue;
        expect(at, `cursor=${String(cursor)}`).toBeGreaterThanOrEqual(0);
        expect(at, `cursor=${String(cursor)}`).toBeLessThanOrEqual(text.length);
      }
    }
    // ⚠️ **正向对照**：夹完之后答案与合法下标一致
    expect(caretUp(text, 99, W)).toBe(caretUp(text, 7, W));
  });
});

/* ── 首 / 末行判据 ───────────────────────────────────────────────── */

describe("首末行判据：`caretAtFirstRow` / `caretAtLastRow`（历史那一档读它们）", () => {
  it("单行输入：既是首行**也是**末行", () => {
    expect(caretAtFirstRow("/status", 3, W)).toBe(true);
    expect(caretAtLastRow("/status", 3, W)).toBe(true);
  });

  it("⚠️ 硬换行：第 0 行只有首，第 1 行只有末", () => {
    const text = "abc\ndef";
    expect(caretAtFirstRow(text, 0, W)).toBe(true);
    expect(caretAtLastRow(text, 0, W)).toBe(false);
    expect(caretAtFirstRow(text, 5, W)).toBe(false);
    expect(caretAtLastRow(text, 5, W)).toBe(true);
  });

  it("⚠️ **光标在换行符**与**在换行符之后**是两件事（前者算上一行末尾）", () => {
    const text = "abc\ndef";
    // 光标 3 = `abc` 之后、`\n` **之前** ⇒ 第 0 行末尾 ⇒ `↑` 该去翻历史
    expect(caretAtFirstRow(text, 3, W)).toBe(true);
    expect(caretAtLastRow(text, 3, W)).toBe(false);
    // 光标 4 = `\n` **之后** = 第 1 行开头 ⇒ `↓` 该去翻历史
    expect(caretAtFirstRow(text, 4, W)).toBe(false);
    expect(caretAtLastRow(text, 4, W)).toBe(true);
    // ⚠️ **正向对照**：行内（既不是行首也不是行末）那一档两判都为假 ——
    // 否则上面那两对是「按串里有没有 `\n` 来判」的恒绿
    expect(caretAtLastRow(text, 1, W)).toBe(false);
    expect(caretAtFirstRow(text, 1, W)).toBe(true);
  });

  it("⚠️ 换行之后光标落在**新起的那一行**，于是「按 `↓` 立刻去翻历史」", () => {
    // 判据钉的是**插入那一格返回的下标与折行结果的对应**：`insertNewline` 交回的下标
    // 落在新起那一行上，而那一行是末行 —— 少了它「换行之后光标停在上一行末尾」就恒绿
    const { text, cursor } = insertNewline("abc", { start: 3, end: 3 });
    expect(text).toBe("abc\n");
    expect(caretAtLastRow(text, cursor, W)).toBe(true);
    expect(caretAtFirstRow(text, cursor, W)).toBe(false);
  });

  it("⚠️ 判据与 `caretUp` / `caretDown` **是同一个事实**（两处各判一次就会有一处判错）", () => {
    const text = "abc\ndef\nghi";
    for (const cursor of [0, 2, 3, 5, 6, 9, -1, 99]) {
      expect(caretAtFirstRow(text, cursor, W), `cursor=${String(cursor)}`).toBe(
        caretUp(text, cursor, W) === null,
      );
      expect(caretAtLastRow(text, cursor, W), `cursor=${String(cursor)}`).toBe(
        caretDown(text, cursor, W) === null,
      );
    }
  });
});

/* ── 命令历史 ─────────────────────────────────────────────────────── */

describe("命令历史：`pushHistory`（上限 / 空串不入 / 重复不入）", () => {
  it("正常入历史，最新在末尾", () => {
    expect(pushHistory([], "/status")).toEqual(["/status"]);
    expect(pushHistory(["/status"], "/users")).toEqual(["/status", "/users"]);
  });

  it("⚠️ **空串不入**（回车按在空输入行上是零件事，而历史里那条空行会让 `↑` 像失灵）", () => {
    const entries = ["/status"];
    expect(pushHistory(entries, "")).toEqual(["/status"]);
    expect(pushHistory(entries, "   ")).toEqual(["/status"]);
    // ⚠️ **正向对照**：非空的一行真的入得去（否则上面两条是「什么都不入」的恒绿）
    expect(pushHistory(entries, "/users")).toHaveLength(2);
  });

  it("⚠️ **与最近一条逐字相同的不重复入**（重复入的话 `↓` 要按两遍才回到真正那条）", () => {
    expect(pushHistory(["/status"], "/status")).toEqual(["/status"]);
    // ⚠️ 而**与更早那条相同**的仍要入：历史是「按时间排的提交」，不是「集合」
    expect(pushHistory(["/a", "/b"], "/a")).toEqual(["/a", "/b", "/a"]);
  });

  it("⚠️ 入库的是**原样那一行**（只拿 trim 判空，不改写它）", () => {
    expect(pushHistory([], "  /status  ")).toEqual(["  /status  "]);
  });

  it("⚠️ 上限 10：**从最早那一条开始丢**（最新恒在末尾）", () => {
    const many = Array.from({ length: INPUT_HISTORY }, (_, i) => `/cmd${String(i)}`);
    expect(many).toHaveLength(10);
    const grown = pushHistory(many, "/newest");
    expect(grown).toHaveLength(INPUT_HISTORY);
    expect(grown[grown.length - 1]).toBe("/newest");
    expect(grown[0]).toBe("/cmd1");
    // ⚠️ **上限那个数本身被钉住**：拿它当期望值的话「改上限」与「改实现」一起变 ⇒ 恒绿
    expect(INPUT_HISTORY).toBe(10);
    // ⚠️ 正向对照：恰好到上限之前**一个都不丢**
    const nine = Array.from({ length: INPUT_HISTORY - 1 }, (_, i) => `/cmd${String(i)}`);
    expect(pushHistory(nine, "/newest")).toHaveLength(INPUT_HISTORY);
  });

  it("入历史**不改传入的那个数组**（引用判据要靠它）", () => {
    const entries = ["/a"];
    const grown = pushHistory(entries, "/b");
    expect(entries).toEqual(["/a"]);
    expect(grown).not.toBe(entries);
  });
});

describe("命令历史：`historyPrev` / `historyNext`（到头 / 清行）", () => {
  const three = ["/one", "/two", "/three"];

  it("⚠️ 当前这行不在历史里 ⇒ `↑` 取**最新**那一条（用户改过输入行的那一次）", () => {
    expect(historyPrev(three, "/改了半截")).toEqual({ line: "/three", cursor: 6, at: 2 });
  });

  it("⚠️ 连着按 `↑` 一次往更旧的一条走（判据是「这行是不是历史里那一条」）", () => {
    expect(historyPrev(three, "/three")).toEqual({ line: "/two", cursor: 4, at: 1 });
    expect(historyPrev(three, "/two")).toEqual({ line: "/one", cursor: 4, at: 0 });
  });

  it("⚠️ 已经在**最旧**那一条上按 `↑` ⇒ `null`（按键不动，而不是绕回最新那条）", () => {
    expect(historyPrev(three, "/one")).toBeNull();
    // ⚠️ **正向对照**：还有更旧的一条时它**不是** null（否则上面这条是「恒 null」的恒绿）
    expect(historyPrev(three, "/two")).not.toBeNull();
  });

  it("空历史 ⇒ `↑` 给 `null`（一个会话还没提交过任何东西）", () => {
    expect(historyPrev([], "任何")).toBeNull();
  });

  it("⚠️ `↓` 从**最旧**开始一路往更新的一条走", () => {
    expect(historyNext(three, -1)).toEqual({ line: "/one", cursor: 4, at: 0 });
    expect(historyNext(three, 0)).toEqual({ line: "/two", cursor: 4, at: 1 });
    expect(historyNext(three, 1)).toEqual({ line: "/three", cursor: 6, at: 2 });
  });

  it("⚠️ 已在**最新**那条上按 `↓` ⇒ **清空输入行**（不是 `null`，也不是留在原地）", () => {
    expect(historyNext(three, 2)).toEqual({ line: "", cursor: 0, at: -1 });
    // ⚠️ 而越界的 `at` 同样落在「清行」那一档（哨兵可判据，不是越界崩掉）
    expect(historyNext(three, 99)).toEqual({ line: "", cursor: 0, at: -1 });
    // ⚠️ **正向对照**：`at` 落在最新之前时它真的给出那一行（否则上面两条是「恒清行」的恒绿）
    expect(historyNext(three, 1).line).toBe("/three");
  });

  it("⚠️ 清空之后按 `↓` 回到**最新**那一条（`-1` 落在最新上，不是「再往下走一格」）", () => {
    // 往返：`↑` 到最旧 → `↓` 三次回到最新 → 再一次清空 → 再一次回到最新
    const step = historyPrev(three, "/改了");
    expect(step).not.toBeNull();
    let at = step!.at;
    while (historyNext(three, at).at >= 0) {
      at = historyNext(three, at).at;
    }
    expect(at).toBe(2);
    expect(historyNext(three, at)).toEqual({ line: "", cursor: 0, at: -1 });
    // ⚠️ 而「清空那一档」的 `at = -1` 再走一格回来时**仍是最新那条**（不是 `null`）
    expect(historyNext(three, -1)).toEqual({ line: "/one", cursor: 4, at: 0 });
  });

  it("空历史 ⇒ `↓` 也给「清空」那一档（`at = -1`）而不是 `null`", () => {
    expect(historyNext([], 0)).toEqual({ line: "", cursor: 0, at: -1 });
    expect(historyNext([], -1)).toEqual({ line: "", cursor: 0, at: -1 });
  });

  it("⚠️ 召回的那一行**插入符恒在行末**（整条塞回去，不带半截插入符）", () => {
    const step = historyPrev(["/user add charlie 1g"], "/改了");
    expect(step!.cursor).toBe(step!.line.length);
    expect(step!.cursor).toBe("/user add charlie 1g".length);
  });
});