/**
 * 四条注释体量上限在**真实语料**（`tests/` 下递归的一切 `.test.ts`）上的取值
 *
 * @description
 * 四条是同一个判据形状作用在不同输入上（数行数 + 把超限的那些列出来），故同属一档：语料遍历一次、
 * 逐条算行数、四个清单各交一条断言。四条**各有各的上限**，拆开就是四份各带一个用例的碎片。
 * 探测器自检与覆盖面在 `./detector.test.ts`；判据为什么是行数、每个上限的实测依据在 `./AGENTS.md`。
 */

import { describe, expect, it } from "vitest";
import { CORPUS, LIMITS, budgetOf, formatOvers } from "../../../helpers/comment-budget-scan.js";

const budget = budgetOf(CORPUS);

describe(`1 判据：每个档的文件头不超过 ${LIMITS.head} 行`, () => {
  it("全仓没有一个档的文件头超过上限", () => {
    expect(
      budget.head,
      `文件头超过 ${LIMITS.head} 行（文件头答「这一档管哪一段 + 变异表在哪」，不是一篇文档）：\n${formatOvers(budget.head)}\n\n` +
        "修法：主题级不变量与长推导搬进该主题目录的 AGENTS.md（见 tests/unit/AGENTS.md「拆分纪律」），" +
        "单档文件头只留「这一档答什么 + 指向 AGENTS.md」；⚠️ 无头的档不硬造头，`0 ≤ 上限` 是合法的过法。",
    ).toEqual([]);
  });
});

describe(`2 判据：紧贴 describe() / it() 的那段注释不超过 ${LIMITS.adjacent} 行`, () => {
  it("没有一段「用例头」超过上限（它是读者看到的第一句话，不是第二份文件头）", () => {
    expect(
      budget.adjacent,
      `紧贴用例的注释超过 ${LIMITS.adjacent} 行：\n${formatOvers(budget.adjacent)}\n\n` +
        "修法：只留「这一条在防什么 + 变异怎么跑」；推导与取舍搬进该目录的 AGENTS.md。",
    ).toEqual([]);
  });
});

describe(`3 判据：正文里的单个注释块不超过 ${LIMITS.block} 行`, () => {
  it("正文里没有一块注释超过上限（⚠️ 这一条只管正文，文件头归判据 1）", () => {
    expect(
      budget.block,
      `正文里的注释块超过 ${LIMITS.block} 行：\n${formatOvers(budget.block)}\n\n` +
        "修法：一条注释只说一条不变量；多条的场合拆成相邻的几条短注释。",
    ).toEqual([]);
  });
});

describe(`4 判据：含 ⚠ 的注释块不超过 ${LIMITS.warn} 行`, () => {
  it("没有一块 ⚠ 注释超过上限（一个 ⚠ 只讲一件事）", () => {
    expect(
      budget.warn,
      `⚠ 注释块超过 ${LIMITS.warn} 行：\n${formatOvers(budget.warn)}\n\n` +
        "修法：⚠️ 只留「反例是什么」与「为什么会失守」，删掉「而那正是我们要防的事故本身」这类铺陈。",
    ).toEqual([]);
  });
});
