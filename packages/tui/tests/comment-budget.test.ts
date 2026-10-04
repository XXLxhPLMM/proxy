import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 注释体量的**上限**护栏（源码级）
 *
 * @description
 * **要防的事**：本包的注释曾经是「越写越多、且没有上限」的形态 —— 同一个目录里
 * `use-terminal-size.ts` 的文件头 37 行而 `input-line.ts` 只有几行，标准差 4 倍；
 * 13 行的端点模块文件配 14 行文件头；barrel 上写着整份「层不变量」散文。
 * 压缩注释这件事**分散做会失守**（上一轮就是：每个执行者按自己当时的劲头写），
 * 所以上限必须是**一条可判定的断言**，而不是一句倡议。
 *
 * ## 为什么判据是「行数」而不是「好不好」
 * @description
 * 「这段注释值得吗」是人的判断，写不成断言；而「文件头超过 6 行」是**机械可判**的，
 * 且它恰好掐在「一个不变量」与「一段论文」的分界上。判据定死之后，**要写的话就得写好** ——
 * 写好的一段 5 行注释读起来比 30 行更密。
 *
 * ## 判据自检（防「探测器写坏了 → 全绿」）
 * @description
 * 这套判据**天生怕空**：文件列表取不到就是零个文件、每条断言都在空集上通过。故本档有
 * 一节自检逐条钉住探测器（见「判据自检」那一节）：喂进合成的违规文本必须被认出来，
 * 而喂进合规文本必须**认不出来**（后者防的是「判据过宽，什么都算违规」这种反向失守）。
 *
 * ## 与内容类护栏的分工
 * @description
 * 本档**只管体量，不管对错**。注释说的是不是真的、有没有把一条不变量抄五遍，那是
 * `packages/tui/AGENTS.md` 与各文件自己的责任。本档存在的意义是：让「太长」这件事
 * **当场变红**，而不是靠下一次有人想起来去压缩。
 */

/** 本包 `src/` 下的源文件（⚠️ 列目录，不手写清单 —— 新增文件自动进扫描范围） */
function sources(): ReadonlyArray<readonly [string, string]> {
  const root = path.join(__dirname, "..", "src");
  const out: Array<readonly [string, string]> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        out.push([path.relative(root, full).split(path.sep).join("/"), fs.readFileSync(full, "utf8")]);
      }
    }
  };
  walk(root);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** 逐行分类：`head` = 第一段注释（文件头），`body` = 其后每一段独立注释块 */
function commentBlocks(lines: readonly string[]): Array<{ head: boolean; lines: string[]; at: number }> {
  const blocks: Array<{ head: boolean; lines: string[]; at: number }> = [];
  let inBlock = false;
  let cur: string[] = [];
  let start = 0;
  let seenCode = false;
  /** 块开始那一刻的「前面有没有代码」—— 必须在块**起头**时记，中途置位会把它误判成正文 */
  let curIsHead = true;

  const flush = (): void => {
    if (cur.length > 0) blocks.push({ head: curIsHead, lines: cur, at: start + 1 });
    cur = [];
  };
  const begin = (i: number): void => {
    if (cur.length === 0) {
      start = i;
      curIsHead = !seenCode;
    }
    cur.push("");
  };

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (inBlock) {
      cur.push(t);
      if (t.includes("*/")) {
        inBlock = false;
        flush();
      }
      continue;
    }
    if (t.startsWith("/*")) {
      begin(i);
      cur[cur.length - 1] = t;
      if (!t.includes("*/")) inBlock = true;
      else flush();
      continue;
    }
    if (t.startsWith("//")) {
      begin(i);
      cur[cur.length - 1] = t;
      continue;
    }
    if (t === "") continue;
    seenCode = true;
    if (!inBlock) flush();
  }
  flush();
  return blocks;
}

function isBarrel(lines: readonly string[]): boolean {
  const body = lines
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .trim();
  if (body === "") return false;
  const rest = body
    .replace(/^[ \t]*(?:import|export)\b[\s\S]*?\bfrom\s+"[^"]*";/gm, "")
    .replace(/^[ \t]*import\s+"[^"]*";/gm, "")
    .trim();
  return rest === "";
}

/** 头部注释行数（第一段块 + 紧随其后的 `//` 行，算「文件头」整体） */
function headCommentLines(lines: readonly string[]): number {
  let n = 0;
  for (const b of commentBlocks(lines)) {
    if (!b.head) break;
    n += b.lines.length;
  }
  return n;
}

const SRC = sources();

describe("注释体量上限（源码级）", () => {
  describe("覆盖面（防「扫描面是空的 → 下面全是空断言」）", () => {
    it("扫描面覆盖到本包的源文件，且新增文件自动入扫描", () => {
      const names = SRC.map(([name]) => name);
      expect(names.length).toBeGreaterThanOrEqual(40);
      expect(names).toContain("hooks/useTerminalSize.ts");
      expect(names).toContain("features/sessions/SessionSidebar.tsx");
      expect(names).toContain("api/endpoints/status.ts");
    });

    it("barrel 识别器认得出 barrel、且认不出普通实现文件（否则 barrel 那档判据会落空）", () => {
      expect(isBarrel(['export { a } from "./a.js";'])).toBe(true);
      expect(isBarrel(["const x = 1;", "export const a = x;"])).toBe(false);
    });

    it("头部行数判据数得出头部，且不把正文注释算进去", () => {
      const lines = ["/**", " * a", " */", "export const x = 1;", "/**", " * 正文注释", " */", ""];
      expect(headCommentLines(lines)).toBe(3);
      expect(headCommentLines(["// 一行", "const a = 1;"])).toBe(1);
      expect(headCommentLines(["const a = 1;", "/**", " * 正文", " */"])).toBe(0);
    });
  });

  describe("判据自检（防「探测器写坏了 → 全绿」）", () => {
    it("超长文件头被判为违规（探测器看得见，不是恒返回零）", () => {
      const long = ["/**", ...Array.from({ length: 20 }, (_, i) => ` * 第 ${i} 行`), " */", "export const a = 1;"];
      expect(headCommentLines(long)).toBeGreaterThan(6);
    });

    it("合规文件头判为不违规（防「判据过宽，什么都算违规」这种反向失守）", () => {
      const ok = ["/**", " * 一句话。", " */", "export const a = 1;"];
      expect(headCommentLines(ok)).toBeLessThanOrEqual(6);
    });

    it("超长 ⚠️ 块与超长普通块都被认出来（判据 3 与判据 4 各有各的探测器）", () => {
      const warn = ["/**", ...Array.from({ length: 6 }, () => " * ⚠️ 一句"), " */", "const a = 1;"];
      expect(commentBlocks(warn).some((b) => b.lines.length > 3 && b.lines.some((l) => l.includes("⚠")))).toBe(true);
      const plain = ["/**", ...Array.from({ length: 20 }, (_, i) => ` * 行 ${i}`), " */", "const a = 1;"];
      expect(commentBlocks(plain).some((b) => b.lines.length > 12)).toBe(true);
    });
  });

  describe("1 判据：文件头不超过 6 行", () => {
    it("每个源文件的头部注释都在上限内", () => {
      const over = SRC.map(([name, text]) => {
        const n = headCommentLines(text.split(/\r?\n/));
        return n > 6 ? `${name}: 头部 ${n} 行` : null;
      }).filter((x): x is string => x !== null);
      expect(
        over,
        `文件头超过 6 行（判据：头部是「一个不变量」，不是一段论文）：\n${over.join("\n")}\n\n` +
          "修法：留 @fileoverview 一句 + 最多一条「为什么不一样」；推导过程搬进 packages/tui/AGENTS.md 或删掉。",
      ).toEqual([]);
    });
  });

  describe("2 判据：barrel 的注释不超过 3 行", () => {
    it("判据只作用在 barrel 上（判据写反过一次，这条钉住作用面）", () => {
      // 曾经写成 `!isBarrel(...) || head <= 3` —— 留下的恰好是**非 barrel**，
      // 于是这条判据实际变成了「所有文件 ≤3 行」，而真正的 barrel 永远不会被列出。
      const impl = ["/**", " * a", " * b", " * c", " * d", " */", "export const a = 1;"];
      const barrel = ["/**", " * a", " * b", " * c", " * d", " */", 'export { x } from "./x.js";'];
      expect(isBarrel(impl)).toBe(false);
      expect(isBarrel(barrel)).toBe(true);
      expect(headCommentLines(impl)).toBeLessThanOrEqual(6);
    });

    it("本包今天真的有一批 barrel（否则这条判据作用在空集上）", () => {
      const barrels = SRC.filter(([, text]) => isBarrel(text.split(/\r?\n/))).map(([n]) => n);
      expect(barrels.length).toBeGreaterThanOrEqual(8);
      expect(barrels).toContain("api/index.ts");
      expect(barrels).toContain("components/index.ts");
    });

    it("每个 barrel 的注释都在上限内", () => {
      const over = SRC.filter(([, text]) => isBarrel(text.split(/\r?\n/)))
        .map(([name, text]) => {
          const n = headCommentLines(text.split(/\r?\n/));
          return n > 3 ? `${name}: 头部 ${n} 行` : null;
        })
        .filter((x): x is string => x !== null);
      expect(
        over,
        `barrel 的注释超过 3 行：\n${over.join("\n")}\n\n` +
          "修法：barrel 只许说「这个目录答什么」一句；层不变量搬进该目录的 AGENTS.md。",
      ).toEqual([]);
    });
  });

  describe("3 判据：单个注释块不超过 12 行", () => {
    it("正文里没有超过上限的注释块（长推导属于 AGENTS.md，不属于代码）", () => {
      const over = SRC.flatMap(([name, text]) => {
        const lines = text.split(/\r?\n/);
        return commentBlocks(lines)
          .filter((b) => b.lines.length > 12)
          .map((b) => `${name}:${b.at}: 注释块 ${b.lines.length} 行`);
      });
      expect(
        over,
        `单个注释块超过 12 行：\n${over.join("\n")}\n\n` +
          "修法：一条注释只说一条不变量；多条的场合拆成相邻的几条短注释。",
      ).toEqual([]);
    });
  });

  describe("4 判据：⚠️ 警告不许超过 3 行", () => {
    it("没有超过上限的 ⚠️ 注释块（一个 ⚠️ 讲一件事）", () => {
      const over = SRC.flatMap(([name, text]) => {
        const lines = text.split(/\r?\n/);
        return commentBlocks(lines)
          .filter((b) => b.lines.length > 3 && b.lines.some((l) => l.includes("⚠")))
          .map((b) => `${name}:${b.at}: ${b.lines.length} 行`);
      });
      expect(
        over,
        `⚠️ 注释超过 3 行：\n${over.slice(0, 40).join("\n")}\n\n` +
          "修法：⚠️ 只留「反例是什么」，删掉「而那正是我们要防的事故本身」这类铺陈。",
      ).toEqual([]);
    });
  });
});