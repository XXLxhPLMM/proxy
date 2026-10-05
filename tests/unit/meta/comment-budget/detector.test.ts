/**
 * 注释体量护栏 —— 覆盖面与**判据自检**（探测器本身看得见违规、且作用面不是空集）
 *
 * @description
 * 四条上限全是**负向断言**，而负向断言天生怕空：语料取不到就是零个文件，每一条上限都在空集上
 * 通过；探测器写坏了（恒返回 0 / 恒返回「超限」）也是全绿。故本档逐条钉住探测器与作用面 ——
 * 违规样本必须被认出、合规样本必须认不出来（后者防「判据过宽，什么都算违规」这种**反向**失守）。
 * 四条上限的取值在 `./limits.test.ts`，判据为什么是行数、每个上限的实测依据在 `./AGENTS.md`。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CORPUS,
  EXCLUDED_DIRS_ANY_DEPTH,
  LIMITS,
  OVER_BLOCK,
  OVER_CASE_DOC,
  OVER_HEAD,
  OVER_WARN,
  CLEAN_SOURCE,
  budgetOf,
  caseDocBlocks,
  commentBlocks,
  headCommentLines,
  isBarrel,
  isExcludedDirName,
  requireCorpus,
  sample,
  scanTests,
  type TestSource,
} from "../../../helpers/comment-budget-scan.js";
import { TESTS_DIR } from "../../../helpers/source-scan.js";

/** 把一份合成文本包成语料条目（让合成样本走**真语料走的同一条判定路径**） */
const asSource = (text: readonly string[]): TestSource => ["tests/synthetic.test.ts", text.join("\n")];

/** 合成文本里最长那块注释的行数（用来验「样本生成器按声称的行数产出」） */
const docOf = (text: readonly string[]): number =>
  Math.max(...commentBlocks(text).map((b) => b.lines.length));

/** 在某个位置垫一行代码，把一段注释从「文件头」推到「正文」 */
const asBody = (text: readonly string[]): TestSource => asSource(["const a = 0;", ...text.slice(1)]);

describe("覆盖面（防「扫描面是空的 → 下面全是空断言」）", () => {
  it("扫描面覆盖 unit / integration / library 三个顶层，且点名四个具体档", () => {
    process.stderr.write(
      `\n注释体量护栏：语料 = ${CORPUS.length} 个 *.test.ts；上限 ${JSON.stringify(LIMITS)}\n`,
    );
    // 下界不是定数：加档不许变成「改一次测试」的噪音，它只挡「路径写错 / include 收不到」
    expect(CORPUS.length).toBeGreaterThanOrEqual(200);
    const names = CORPUS.map(([rel]) => rel);
    for (const dir of ["tests/unit/", "tests/integration/", "tests/library/"]) {
      expect(names.some((n) => n.startsWith(dir)), `${dir} 一个档都没进扫描面`).toBe(true);
    }
    expect(names).toContain("tests/unit/manager/control-plane.test.ts");
    expect(names).toContain("tests/unit/datasource/quota/sqlite/driver-split.test.ts");
    expect(names).toContain("tests/integration/inbound/socks-handshake.test.ts");
    expect(names).toContain("tests/library/entry.test.ts");
  });

  it("判据的素材面（合成样本所在的 helper）不在扫描面内 —— 判据不许扫自己", () => {
    // 正向存在性：那份素材**确实在磁盘上**，否则「它不在扫描面内」只是一句无从验证的话
    const helper = path.join(TESTS_DIR, "helpers", "comment-budget-scan.ts");
    expect(existsSync(helper)).toBe(true);
    // 钉的是**形状**（helpers 目录不进语料）而不是某一个文件名：改名不该让这条变红，而把
    // 素材挪进 `tests/` 下任何一个会被收的目录会让它变红 —— 那正是自噬
    expect(CORPUS.filter(([rel]) => rel.startsWith("tests/helpers/"))).toEqual([]);
  });

  it("排除清单与后缀规则真的生效（临时目录：收一个、不收其余五个）", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "comment-budget-"));
    try {
      writeFileSync(path.join(root, "keep.test.ts"), "export const a = 1;\n", "utf8");
      writeFileSync(path.join(root, "not-a-test.ts"), "export const a = 1;\n", "utf8");
      for (const name of EXCLUDED_DIRS_ANY_DEPTH) {
        mkdirSync(path.join(root, name));
        writeFileSync(path.join(root, name, "skip.test.ts"), "export const a = 1;\n", "utf8");
      }
      expect(scanTests(root).map(([rel]) => path.basename(rel))).toEqual(["keep.test.ts"]);
      // 排除项逐个是活着的名字（写一个不存在的排除名 = 白写）
      for (const name of EXCLUDED_DIRS_ANY_DEPTH) {
        expect(isExcludedDirName(name)).toBe(true);
      }
      expect(isExcludedDirName("unit")).toBe(false);
      expect(isExcludedDirName("helpers")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("扫描面取不到要立刻炸，不许退化成「扫不到就没有违规」", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "comment-budget-empty-"));
    try {
      expect(() => requireCorpus(root)).toThrow(/扫描面是空的/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("判据 2 的作用面在真实语料上非空（收窄的判据最容易落空 —— 空集上它恒过）", () => {
    // ⚠️ 这里刻意**解构**取行号而不写 `doc.at`：`.at` 是奥地利 TLD，而本档在 `SCAN_DIRS` 内，
    // 写成 `doc.at` 会被零外网那道护栏当成一个未申报的公网 host（`../../helpers/` 里的同名
    // 写法反而看不见 —— 那边不在扫描面内。**看得见的副本优于看不见的失效**，这次是反过来的读法）
    const docs = CORPUS.flatMap(([rel, text]) =>
      caseDocBlocks(text.split(/\r?\n/)).map(({ at }) => `${rel}:${at}`),
    );
    const under = (dir: string): number => docs.filter((at) => at.startsWith(dir)).length;
    // 下界不是定数；钉的是「这个面真的存在、且跨两个顶层」，而不是某一个具体文件
    // —— 具体路径会随注释压缩消失，而**面归零**才是那条判据真正失效的时刻
    expect(docs.length).toBeGreaterThanOrEqual(20);
    for (const dir of ["tests/unit/", "tests/integration/"]) {
      expect(under(dir), `${dir} 一个「用例头」都没有 —— 判据 2 作用面已经空了`).toBeGreaterThan(0);
    }
  });

  it("本仓今天没有一个 barrel —— 判据 2 因此**不**作用在 barrel 上（理由见 AGENTS.md）", () => {
    // 先钉探测器的正向存在性：命中集为空必须是因为「真的没有 barrel」，不能是因为「认不出」
    expect(isBarrel(['export { a } from "./a.js";'])).toBe(true);
    expect(isBarrel(["const x = 1;", "export const a = x;"])).toBe(false);
    const barrels = CORPUS.filter(([, text]) => isBarrel(text.split(/\r?\n/))).map(([rel]) => rel);
    expect(
      barrels,
      "tests/ 下出现了 barrel：判据 2 该按原型那套「barrel 头更严」回来，先改判据再改阈值",
    ).toEqual([]);
  });
});

describe("判据自检（防「探测器写坏了 → 全绿」）", () => {
  it("合成样本的块行数就是声称的那一行（生成器坏了 → 自检会喂进一个合规样本）", () => {
    expect(docOf(OVER_HEAD)).toBe(LIMITS.head + 4);
    expect(docOf(OVER_BLOCK)).toBe(LIMITS.block + 4);
    expect(docOf(OVER_WARN)).toBe(LIMITS.warn + 4);
    expect(docOf(OVER_CASE_DOC)).toBe(LIMITS.adjacent + 4);
    expect(docOf(sample(7, { head: true }))).toBe(7);
    expect(docOf(CLEAN_SOURCE)).toBe(3);
  });

  it("四份违规样本逐条被认出来（探测器看得见，不是恒返回零）", () => {
    expect(budgetOf([asSource(OVER_HEAD)]).head, "判据 1 认不出超长文件头").toHaveLength(1);
    expect(budgetOf([asBody(OVER_BLOCK)]).block, "判据 3 认不出超长正文块").toHaveLength(1);
    expect(budgetOf([asBody(OVER_WARN)]).warn, "判据 4 认不出超长的 ⚠ 块").toHaveLength(1);
    expect(
      budgetOf([asBody(OVER_CASE_DOC)]).adjacent,
      "判据 2 认不出紧贴用例的超长注释",
    ).toHaveLength(1);
    // 且判据 1 数得出「超长头」与「合规头」是两种不同的结果（不是恒返回零也不是恒返回块长）
    expect(headCommentLines(OVER_HEAD)).toBeGreaterThan(LIMITS.head);
    expect(headCommentLines(CLEAN_SOURCE)).toBe(3);
  });

  it("一份完全合规的合成档逐条认不出来（防「判据过宽，什么都算违规」这种反向失守）", () => {
    // ⚠️ 只喂违规样本的话，一个恒返回「超限」的探测器照样全绿 —— 故必须同时有一份逐条合法的样本
    const clean = budgetOf([asSource(CLEAN_SOURCE)]);
    expect(clean.head).toEqual([]);
    expect(clean.adjacent).toEqual([]);
    expect(clean.block).toEqual([]);
    expect(clean.warn).toEqual([]);
  });

  it("头部行数判据数得出头部，且不把正文注释算进去", () => {
    expect(headCommentLines(["/**", " * a", " */", "const a = 1;", "/**", " * 正文", " */"])).toBe(3);
    expect(headCommentLines(["// 一行", "const a = 1;"])).toBe(1);
    expect(headCommentLines(["const a = 1;", "/**", " * 正文", " */"])).toBe(0);
    expect(headCommentLines(["/**", " * 头", " */", "", "// 紧随其后", "const a = 1;"])).toBe(4);
  });

  it("判据 2 的探测器只认「下一段非空行就是打开一个用例」那一种排版", () => {
    const code = "const z = 0;";
    const doc = ["/**", " * a", " */"];
    const openCase = 'describe("y", () => {});';
    expect(caseDocBlocks([code, ...doc, openCase]).length, "紧贴 describe 必须被认出来").toBe(1);
    expect(caseDocBlocks([code, ...doc, "", openCase]).length, "空行不算「隔着」").toBe(1);
    expect(
      caseDocBlocks([code, ...doc, "const w = 1;", openCase]).length,
      "段与 describe 之间隔了一行代码 ⇒ 不认（方向是漏检，漏检安全）",
    ).toBe(0);
    expect(caseDocBlocks([code, ...doc, 'describe.each(["x"])("y", () => {});']).length).toBe(1);
    expect(caseDocBlocks([code, ...doc, 'expect(1).toBe(1); // describe("y")']).length).toBe(0);
    // 文件头**不**归判据 2 —— 判据 1 已经收它，两条对同一个块各判一次等于把一条判据写两遍
    expect(caseDocBlocks([...doc, openCase]).length, "文件头归判据 1，判据 2 不许重复收").toBe(0);
    // 而 `CLEAN_SOURCE` 是判据 2 的**形状**样本：它确实有一段紧贴 `describe(` 的注释
    expect(caseDocBlocks(CLEAN_SOURCE)).toHaveLength(1);
  });
});
