/**
 * 「注释体量上限」那道护栏的扫描面与探测器（语料 = `tests/` 下递归的一切 `.test.ts`）
 *
 * @description
 * 根 `AGENTS.md`「注释写不变量，不写变更日志」是一条**倡议**，而压缩注释这件事分散做会失守
 * （每个执行者按自己当时的劲头写）。本模块是让「太长」当场变红的那一侧：四个行数上限加
 * 一份合成样本。为什么判据是行数而不是「好不好」、每个数是怎么定的，见
 * `tests/unit/meta/comment-budget/AGENTS.md`。
 *
 * ⚠️ **合成样本刻意住在本模块**：档就是语料本身，而判据要认出的违规文本必须以「注释的**形状**」
 * 存在。写进档里 = 判据的素材面与语料同源，扫自己会把合成脏样本当成真违规。本文件不带
 * `.test.ts` 后缀（`vitest.config.ts` 的那条 `include` 收不到它），而断言档**反向钉住**这件事。
 *
 * ⚠️ 路径从 `./source-scan.js` 派生：**`..` 的层数只许出现在那一处**，多一个 `..` 会静默枚举到
 * 空集（空集上每一条上限断言都通过）。
 */
import fs from "node:fs";
import path from "node:path";
import { TESTS_DIR } from "./source-scan.js";

/**
 * 四条上限（逐条独立可读；实测分布与「为什么是这个数」在 `comment-budget/AGENTS.md`）
 *
 * @description ⚠️ **判据 3 只管正文、不管文件头**：文件头本身就是一块注释，于是「头 ≤26 而块
 * ≤24」会自相矛盾（语料里确实有 25 / 26 行的头，那两个数不可能同时成立）。判据 1 管头、
 * 判据 3 管头以下的一切。⚠️ **判据 4 横跨两者**：含 `⚠` 的块一律更紧（原型那道护栏的
 * `6 / 12 / 3` 是同一个分层的另一种排法，阈值不共享）。
 */
export const LIMITS = {
  /** 判据 1：每个档的文件头（第一段块 + 紧随其后的 `//` 行） */
  head: 26,
  /** 判据 2：**紧贴** `describe()` / `it()` 的那段注释 */
  adjacent: 12,
  /** 判据 3：正文里（非文件头）的单个注释块 */
  block: 24,
  /** 判据 4：含 `⚠` 的注释块（文件头与正文都算） */
  warn: 18,
} as const;

/** 任意层级都排除的目录名：依赖树、git 内部状态、`pnpm build` / `pnpm build:lib` 的产物 */
export const EXCLUDED_DIRS_ANY_DEPTH: readonly string[] = ["node_modules", ".git", "dist", "lib"];

/** 目录名是否落在排除清单里（walker 与断言档共用同一个真相，免得两处各写一份） */
export function isExcludedDirName(name: string): boolean {
  return EXCLUDED_DIRS_ANY_DEPTH.includes(name);
}

/** 一段注释块：`head` = 是不是文件头，`lines` = 逐行原文（已 trim），`at` = 1-based 起始行 */
export interface CommentBlock {
  head: boolean;
  lines: readonly string[];
  at: number;
}

/**
 * 逐行分类：文件头（第一段块 + 紧随其后的 `//` 行）与其后每一段独立注释块
 *
 * @description 单趟状态机；与 `packages/tui/tests/comment-budget/_shared.ts` 的同名探测器同形
 * （两个包各判各的作用面，见各自 `AGENTS.md`）。
 * ⚠️ **不去字符串字面量**：多行模板字符串里以 `//` 开头的行会被当成注释计入。方向是**漏检**
 * （字符串里伪装成长注释的东西量不到），而漏检安全；反过来误报会逼着人改文案而不是改判据。
 */
export function commentBlocks(lines: readonly string[]): CommentBlock[] {
  const blocks: CommentBlock[] = [];
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
    const text = lines[i]!.trim();
    if (inBlock) {
      cur.push(text);
      if (text.includes("*/")) {
        inBlock = false;
        flush();
      }
      continue;
    }
    if (text.startsWith("/*")) {
      begin(i);
      cur[cur.length - 1] = text;
      if (text.includes("*/")) flush();
      else inBlock = true;
      continue;
    }
    if (text.startsWith("//")) {
      begin(i);
      cur[cur.length - 1] = text;
      continue;
    }
    if (text === "") continue;
    seenCode = true;
    flush();
  }
  flush();
  return blocks;
}

/**
 * 头部注释行数（第一段块 + 紧随其后的 `//` 行，算「文件头」整体）
 *
 * @description ⚠️ **无头的档恒返回 0**，于是它在这条判据上恒过（`0 ≤ N`）—— 那是**可接受**的
 * 状态而不是漏检：`tests/` 里有相当一批档本来就没有文件头（判据不许为了好看硬造一个头）。
 */
export function headCommentLines(lines: readonly string[]): number {
  let n = 0;
  for (const block of commentBlocks(lines)) {
    if (!block.head) break;
    n += block.lines.length;
  }
  return n;
}

/** 紧贴一段代码的那句注释：下一段非空行以 `describe` / `it` / `test` 开头（可带 `export` 前缀），
 *  或紧跟一个点 —— 后者吃住 `describe.each([...])(...)` 这类排版 */
const CASE_OPEN = /^(?:export\s+)?(?:describe|it|test)\s*[(.]/;

/**
 * **紧贴** `describe()` / `it()` 的那段注释（判据 2 的探测器）
 *
 * @description 用途是「用例头不许变成第二份文件头」：它是读者进这一档看到的第一句话，职责是
 * 「这一条在防什么 + 变异怎么跑」，推导属于该目录的 `AGENTS.md`。⚠️ **跳过文件头**（判据 1 已经
 * 收它）—— 判据 2 只管「挂在某个用例上方」的那一段，否则两条会对同一个块各判一次。
 * ⚠️ 只认「下一段非空行就是打开一个用例」这一种排版；中间隔着别的声明时不认 —— 方向是漏检，
 * 而漏检安全。⚠️ `at` 是 **1-based** 而下标是 0-based，故下一行是 `at - 1 + 行数`。
 * ⚠️ `blocks` 可注入是为了让调用方复用已经算好的那一份（`budgetOf` 每个文件只扫一趟）。
 */
export function caseDocBlocks(
  lines: readonly string[],
  blocks: readonly CommentBlock[] = commentBlocks(lines),
): CommentBlock[] {
  const out: CommentBlock[] = [];
  for (const block of blocks) {
    if (block.head) continue;
    let j = block.at - 1 + block.lines.length;
    while (j < lines.length && lines[j]!.trim() === "") j++;
    if (CASE_OPEN.test(lines[j]?.trim() ?? "")) out.push(block);
  }
  return out;
}

/**
 * 这个文件是不是「只有 re-export、没有实现」的 barrel
 *
 * @description **今天在 `tests/` 上它的命中集是空的**，而那正是判据 2 不再是「barrel 头」的原因
 * （原型那道护栏作用在 `src/` 上，那里有一批真 barrel；`tests/` 一档都是执行断言的代码）。
 * 保留它是为了把「空集」**钉成事实**：将来 `tests/` 下真出现 barrel 时这一条会先红、提示判据
 * 要回来，而不是让一条作用面为空的断言长期绿着冒充护栏（根 `AGENTS.md`「写护栏时」）。
 */
export function isBarrel(lines: readonly string[]): boolean {
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

/** 语料里的一份文本：路径（相对仓库根、`/` 分隔）+ 原文 */
export type TestSource = readonly [rel: string, text: string];

/**
 * 走一遍 `tests/`，返回全部 `*.test.ts`（已排序）
 *
 * @description **列目录，不手写清单**：手写清单漏掉的永远是「将来新增的那一个」，而那一个看起来
 * 正在生效。⚠️ `root` 可注入是为了让「排除清单与后缀规则真的生效」有牙齿 —— 断言档拿一个临时
 * 目录喂它（内含四个排除目录各一个 `.test.ts`，外加一个不带后缀的 `.ts`）。
 * ⚠️ 目录读不到**立刻抛**（`ENOENT` 自己暴露），不许退化成「扫不到就没有违规」。
 */
export function scanTests(root: string = TESTS_DIR): TestSource[] {
  const out: TestSource[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (isExcludedDirName(entry.name)) continue;
        walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.name.endsWith(".test.ts")) continue;
      out.push([`tests/${prefix}${entry.name}`, fs.readFileSync(path.join(dir, entry.name), "utf8")]);
    }
  };
  walk(root, "");
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** 作用面取不到就是零个文件，而每一条上限断言都在空集上通过 —— 故取不到立刻炸（不留后门） */
export function requireCorpus(root: string = TESTS_DIR): TestSource[] {
  const corpus = scanTests(root);
  if (corpus.length === 0) {
    throw new Error(
      `扫描面是空的（${root} 下零个 *.test.ts）：每一条上限断言都会在空集上通过，护栏等于不存在`,
    );
  }
  return corpus;
}

/** 语料（模块期算一次：两份断言看到同一份列表，故一次磁盘遍历够了；取不到在 import 期就炸） */
export const CORPUS: readonly TestSource[] = requireCorpus();

/** 一处超限：`at` = 定位（`路径:行号`，文件头用 `路径:头`），`n` = 实测行数 */
export interface Over {
  at: string;
  n: number;
}

/** 四条判据各报出的一批超限（键与 {@link LIMITS} 一一对应） */
export interface Budget {
  head: readonly Over[];
  adjacent: readonly Over[];
  block: readonly Over[];
  warn: readonly Over[];
}

/**
 * 走一遍语料，算出四条判据各自的超限清单（一次遍历，四份结果）
 *
 * @description ⚠️ **四条是同一个判据形状作用在不同输入上**（数行数 + 列出超限的那些），故它们
 * 共用这一个出口：拆成四个函数就会得到四份可以各自漂的口径，而「同一形状」正是它们该被放在
 * 同一档里的理由。
 */
export function budgetOf(sources: readonly TestSource[]): Budget {
  const head: Over[] = [];
  const adjacent: Over[] = [];
  const block: Over[] = [];
  const warn: Over[] = [];

  for (const [rel, text] of sources) {
    const lines = text.split(/\r?\n/);
    const blocks = commentBlocks(lines);
    const n = headCommentLines(lines);
    if (n > LIMITS.head) head.push({ at: `${rel}:头`, n });

    for (const b of blocks) {
      if (!b.head && b.lines.length > LIMITS.block) block.push({ at: `${rel}:${b.at}`, n: b.lines.length });
      if (b.lines.some((l) => l.includes("⚠")) && b.lines.length > LIMITS.warn) {
        warn.push({ at: `${rel}:${b.at}`, n: b.lines.length });
      }
    }

    for (const b of caseDocBlocks(lines, blocks)) {
      if (b.lines.length > LIMITS.adjacent) adjacent.push({ at: `${rel}:${b.at}`, n: b.lines.length });
    }
  }
  return { head, adjacent, block, warn };
}

/** 超限清单的可读形态（失败信息直接印它，省得人去对着数组数下标） */
export function formatOvers(overs: readonly Over[]): string {
  return overs.map((o) => `  ${o.at} = ${o.n} 行`).join("\n");
}

// ── 判据自检样本（防「探测器写坏了 → 全绿」） ──

/** 一份合成的文本：按行给，探测器吃的就是它 */
export type Lines = readonly string[];

/**
 * 合成一段 **n 行**的 JSDoc（`warn` 时逐行带 `⚠`），前后各垫一行代码
 *
 * @description `head: true` 让它当**文件头**，`tail` 指定块后面那一行代码（判据 2 的样本需要
 * 后面紧跟 `describe(`）。⚠️ **样本是字面量、不落磁盘**：这样判据自检判的是**探测器**而不是语料，
 * 语料变了它的结论也不该动。⚠️ 而它必须住在本文件里 —— 住进档就是判据的素材面与语料同源。
 */
export function sample(
  n: number,
  opts: { warn?: boolean; head?: boolean; tail?: Lines } = {},
): Lines {
  const doc = [
    "/**",
    ...Array.from({ length: Math.max(0, n - 2) }, (_, i) => (opts.warn ? ` * ⚠ 第 ${i} 行` : ` * 第 ${i} 行`)),
    " */",
  ];
  const tail = opts.tail ?? ["const a = 1;"];
  return opts.head === true ? [...doc, ...tail] : ["const b = 0;", ...doc, ...tail];
}

/** 判据 1 的违规样本：文件头超长 */
export const OVER_HEAD: Lines = sample(LIMITS.head + 4, { head: true });

/** 判据 3 的违规样本：正文里的注释块超长 */
export const OVER_BLOCK: Lines = sample(LIMITS.block + 4);

/** 判据 4 的违规样本：含 `⚠` 的注释块超长 */
export const OVER_WARN: Lines = sample(LIMITS.warn + 4, { warn: true });

/** 判据 2 的违规样本：紧贴 `describe()` 的那段注释超长 */
export const OVER_CASE_DOC: Lines = sample(LIMITS.adjacent + 4, { tail: ['describe("x", () => {});'] });

/**
 * 一份**完全合规**的合成档（四条判据都必须认它「无违规」）
 *
 * @description ⚠️ 这一条防的是**反向**失守：「判据过宽，什么都算违规」。只喂违规样本的话，
 * 一个恒返回 `{ 超限: true }` 的探测器照样全绿 —— 所以必须有一份**逐条都合法**的样本，
 * 四条判据同时对它给出「零违规」。它同时是判据 2 与判据 3 的形状样本（有头、有正文块、
 * 有紧贴用例的注释）。
 */
export const CLEAN_SOURCE: Lines = [
  "/**",
  " * 一句话不变量。",
  " */",
  "import { describe, expect, it } from \"vitest\";",
  "",
  "/**",
  " * 紧贴用例的那句话：在防什么 + 变异怎么跑。",
  " */",
  "describe(\"一个主题\", () => {",
  "  it(\"一件事\", () => {",
  "    expect(1).toBe(1);",
  "  });",
  "});",
];
