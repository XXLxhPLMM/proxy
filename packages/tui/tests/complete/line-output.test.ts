/**
 * 补完之后**那一行**变成什么样：只动光标所在那个词，以及带空白的候选必须加引号。
 *
 * @description
 * **这一档锁的是「补全吃掉用户已经敲好的东西」**。补全在句子中间被按（Tab）时，界面上看不出
 * 差别，而用户敲好的后半行 —— 一个键名、一个控制面名 —— 会消失。那是本工具能造成的一类
 * 最贵的数据丢失（地址要重新找、台账里那台机器的名字记不得），而 `pnpm typecheck` 与
 * `pnpm lint` 看不见它。故本档的核心断言是「光标之后的每一个字节逐字不变」，并且**做过变异**：
 * 把补全改成按整行重建，断言必须转红。
 *
 * 两条不变量各自独立：
 *
 * - **只重写光标所在那个词**：其余词与光标位置逐字保留。「接不接受多出来的词」不归本层 ——
 *   本层只承诺「不吞字」。
 * - **带空白的候选插入时加引号**：不加就会把一个名字变成两个参数，而读回来已经不是同一个名字了，
 *   故引号与反斜杠都要转义。
 *
 * 「该出候选的位置」不归本档（`candidates.test.ts`），「退化输入」也不归（`boundaries.test.ts`）。
 * 目录级不变量见 `AGENTS.md`。
 *
 * @module tests/complete
 */

import { describe, expect, it } from "vitest";
import { at } from "./_shared.js";

/* ── 只动光标所在那个词 ─────────────────────────────────────────────────── */

describe("⚠️ 只动光标所在那个词：后面的内容一个字节都不许变", () => {
  it("光标在词中间：补全那个词，光标之后的词逐字保留", () => {
    // `batch pr|od extra keep` —— 后半行是用户已经敲好的
    const result = at("batch pr|od extra keep");
    expect(result.candidates).toEqual(["prod"]);
    expect(result.line).toBe("/batch prod extra keep");
    expect(result.cursor).toBe(11);
  });

  it("光标在词中间、且那个词是命令表里的主题：尾部的值保留", () => {
    const result = at("help sta|tus extra-words");
    expect(result.candidates).toEqual(["status"]);
    expect(result.line).toBe("/help status extra-words");
  });

  it("光标落在**空白**上：它是一个空词，后面的词一个字节都不动", () => {
    // 光标压在那个空格上（不是压在 `prod` 的第一个字符上），故空词在光标处、
    // `prod` 完整地留在后面 —— 结果是三个词，那**不是**本层要管的事：
    // 本层只承诺「不吞字」，接不接受由界面层决定。
    const result = at("batch | prod");
    expect(result.candidates).toEqual(["dev", "prod", "staging"]);
    expect(result.line).toBe("/batch dev prod");
    expect(result.cursor).toBe(10);
  });

  it("行尾的空白：空词在行尾，插进去就行", () => {
    const result = at("batch   |");
    expect(result.line).toBe("/batch   dev");
  });

  it("光标紧跟空白、后面已经有一个词：那个词**就是**光标词（与 shell 的 complete-word 一致）", () => {
    // 判据写清是因为它和上一条**故意相反**：光标在某个词的第一个字符上时，
    // 候选替换的是那个词（否则同一行会多出一个词）
    const result = at("batch |prod");
    expect(result.candidates).toEqual(["dev", "prod", "staging"]);
    expect(result.line).toBe("/batch dev");
    expect(result.cursor).toBe(10);
  });

  it("光标在**命令名**那一段上、行后面还有内容：一个候选都不给（那归命令面板）", () => {
    // ⚠️ 这一条曾经断言「`sta|` → `/status`」。现在命令名归 `@/commands/palette.js`：
    // 本层在一个**已经被面板接管**的位置上再给一次答案，就是两个答案（且排序不同）。
    const result = at("sta| extra-words here");
    expect(result.candidates).toEqual([]);
    expect(result.line).toBe("/sta extra-words here");
    expect(result.cursor).toBe(4);
  });

  it("没有候选时那一行与光标都不动（哪怕光标在词中间）", () => {
    const result = at("batch pr|od extra");
    expect(result.candidates).toEqual(["prod"]);
    const none = at("usage ali|ce extra");
    expect(none.candidates).toEqual([]);
    expect(none.line).toBe("/usage alice extra");
    expect(none.cursor).toBe(10);
  });
});

/* ── 插入形态 ───────────────────────────────────────────────────────────── */

describe("带空白的候选必须加引号（否则补全会把一个名字变成两个参数）", () => {
  it("名字里有空格：插入后加双引号，光标落在收尾引号之后", () => {
    const result = at("batch my|", ["my target", "prod"]);
    expect(result.line).toBe('/batch "my target"');
    expect(result.cursor).toBe(18);
  });

  it("⚠️ 名字里有引号或反斜杠：也要加引号并转义（否则读回来就不是同一个名字）", () => {
    // 字典序：`back\slash` < `we"ird`
    const result = at("batch |", ['we"ird', "back\\slash"]);
    expect(result.line).toBe('/batch "back\\\\slash"');
    const quoted = at("batch |", ['we"ird']);
    expect(quoted.line).toBe('/batch "we\\"ird"');
  });
});