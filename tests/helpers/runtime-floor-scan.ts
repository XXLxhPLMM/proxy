/**
 * 「Node 运行时地板」护栏的扫描器（唯一真相源 = `package.json` 的 `engines.node`）
 *
 * @description
 * 地板这个数字散在十几份文档与源码注释里，而**没有任何 `package.json` 字段能拦住开发环境**
 * （`engines` 在 npm / pnpm 上都只是 WARN，见根 `AGENTS.md`「开发必须 Node >= 22.13 由谁保证」
 * 那一节）。唯一真正强制地板的是测试，于是「地板不许在文档里漂」这件事也只能由测试来守。
 *
 * ## 三条判据规则（逐条独立可读，失败时直接印出是哪一条）
 * 1. **`比较符形态`**：`Node` / `Node.js` + （可含散文的）桥接窗口 + `>=` / `≥` + 版本。
 * 2. **`后缀加号形态`**：`Node` / `Node.js` + 桥接窗口 + 版本 + `+`（`Node 22.13+` 这一写法）。
 * 3. **`徽章编码形态`**：`%3E%3D` + 版本 —— shields.io 徽章里 URL 编码后的 `>=`（`node-%3E%3D22.13`）。
 *
 * ## 桥接窗口：为什么要有、为什么宽、代价是什么
 * 有些真实写法把运行时名与地板隔开了一截散文（最典型的是英文文档那句
 * 「Requires Node.js installed locally (**` + 反引号 + `engines` says ` + 反引号 +
 * `>= 22.13` + …」，中间隔着 30 多个字符）。窗口宽 48 个字符，专治这一种。
 *
 * **窗口里允许出现数字**，这是有意的：提取到的版本**永远紧跟在比较符 / 加号旁边**，
 * 而不取决于窗口里有什么。也就是说窗口只决定「这一行算不算一条声明」，**不决定**「声明的是
 * 哪个版本」—— 后者由 `(?:>=|≥)${INLINE_JUNK}(版本)` 这一段的相邻性保证。因此放宽窗口
 * 只会扩大覆盖面，不会凭空造出错误的版本。实测「窗口含数字」与「窗口不含数字」两种口径在
 * 今天的仓内给出**完全相同**的命中集合，所以这里选了覆盖面更大的那个。
 * 窗口的**代价**是写明的：运行时名与比较符隔开超过 48 字符的行会被漏掉（判据不覆盖，
 * 也不会误报）。哪天需要覆盖那种排版，改窗口宽度即可。
 *
 * ## 刻意**不**纳入判据的形状（写明理由，别当成漏检）
 * - **`node:sqlite` / `node:22` 开头的小写形态**：那是**模块名**与**镜像标签**，不是运行时名。
 *   规则对 `Node` 大小写敏感，`Dockerfile` 里那句「base image 是 `node:22`（≥22.5，走内置档）」
 *   说的是 base image 落在 `node:sqlite` 的哪个区段，与本仓地板无关。
 * - **上界写法（`Node < 22.13`）与裸边界叙述（`22.5 出生` / `22.5–22.12`）**：`node:sqlite` 有
 *   **两个独立边界**（22.5 出生 / 22.13 免 flag），它们各自合法且都不必等于地板。钉死它们会把
 *   两件事压成一个数字，正是 `src/utils/sqlite/AGENTS.md` 点名要避免的揉法。
 *   这些提及由 `unpinnedRuntimeMentions()` **普查并报出**（只报不判），人工看得见即可。
 * - **`package.json` 的 `engines` 块**：它在 JSON 里跨了四行，行级判据看不见它；它本身是
 *   真相源，由 `readEnginesFloor()` 直接读，不经过文本判据。
 *
 * ## 扫描范围：工作树遍历 + 显式排除清单（**刻意不用 `git ls-files`**）
 * 用 git 清单会让「`lib/` 里有陈旧声明」这件事**根本不可见**，于是「显式排除 `lib/`」变成一句
 * 没人能验证的空话。工作树遍历让排除清单本身成为可判据：`excludedAreaHits()` 就是它的牙齿 ——
 * 它单独把 `lib/` 扫一遍，证明排除确实挡掉了东西。
 * 排除项分两层，**这个分层是有理由的**：
 * - **任意层级**：`node_modules`（pnpm 与 `.opencode/` 各自嵌套）、`.git`、`dist`、`lib`。
 * - **仅仓库根**：`log` / `logs` / `.vscode` / `coverage`。`.gitignore` 自己就把 `/log/` 写成根
 *   锚定，理由就写在那个文件里（裸 `log/` 会把源码目录 `src/server/log/` 一起吞掉）。本护栏
 *   沿用同一条纪律，否则会把一份源码级注释从扫描面里静默删掉。
 *
 * ## 两份文本**刻意**不扫描（自噬，与 `external-network-scan.ts` 同因）
 * `SCAN_EXCLUDED_SELF_FILES` 是判据自己的素材面：本 helper 带着**合成脏样本**（`Node >= 99.0`
 * 这类故意写错地板的文本），断言档的头注释又必须**逐字写出**它要拦下的形状。判据的形状与
 * 判据对自己的描述住在同一份文本里是纯自噬 —— 扫描器会把自己的样本当成违规命中。
 * 断言档因此**反向钉住这张表不许扩大**（`tests/unit/meta/runtime-floor/coverage.test.ts`）。
 */
import fs from "node:fs";
import path from "node:path";

/** 仓库根（`tests/helpers/` 上两级） */
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ── 排除清单（断言档会反向钉住它，理由见文件头） ──

/** 任意层级都排除的目录名（`node_modules` 会嵌套在 `.opencode/` 下，`log` 不会） */
export const EXCLUDED_DIRS_ANY_DEPTH: readonly string[] = ["node_modules", ".git", "dist", "lib"];

/** 只在**仓库根**排除的目录名（`log` 根锚定的理由见文件头与 `.gitignore` 自己的注释） */
export const EXCLUDED_DIRS_AT_ROOT: readonly string[] = ["log", "logs", ".vscode", "coverage"];

/** 锁文件：依赖解析的机器产物，内容与「本仓地板」无关（体量大到会淹没判据输出） */
export const EXCLUDED_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|npm-shrinkwrap\.json)$/,
];

/** 判据自身的两份文本（自噬，见文件头）；断言档钉住这张表恰好两项、不许扩大 */
export const SCAN_EXCLUDED_SELF_FILES: readonly string[] = [
  "tests/helpers/runtime-floor-scan.ts",
  "tests/unit/meta/runtime-floor/truth-source.test.ts",
];

/** `cfg/` 下只有 `*.example` / `*.example.md` 进扫描面：其余是开发者本机的账号表与名单 */
export const CFG_ALLOWED_SUFFIXES: readonly string[] = [".example", ".example.md"];

/** 单文件大小上限（超过即跳过并报出；仓内没有文件接近它） */
export const MAX_FILE_BYTES = 1024 * 1024;

// ── 判据：版本字面量与三条规则 ──

/** 规则名（逐条独立可读，失败信息直接印出来） */
export type FloorRule = "比较符形态" | "后缀加号形态" | "徽章编码形态";

/** 全部规则（断言档要求「每条规则都被至少一个样本触发，且在真实扫描里也命中过」） */
export const FLOOR_RULES: readonly FloorRule[] = ["比较符形态", "后缀加号形态", "徽章编码形态"];

/** 行内修饰：空格 / 反引号（行内代码）/ `*`（markdown 强调）/ 下划线 / `~` / 全角与半角圆括号 / 方括号 */
const INLINE_JUNK = String.raw`[\s\`*_~（(\[]*`;

/** 桥接窗口：最多 48 个非换行字符（只决定「这一行算不算声明」，不决定「声明的是哪个版本」） */
const BRIDGE = String.raw`[^\n]{0,48}?`;

/** 版本字面量：`22.13` / `22.13.0`（`major` 两位起，与 Node 的版本号形态一致） */
const VERSION = String.raw`\d+\.\d+(?:\.\d+)?`;

/** 规则 1：`Node >= 22.13` / `Node ≥ 22.13` / `Node.js >= 22.13`（含反引号与散文桥接） */
const COMPARATOR_RULE = new RegExp(
  String.raw`\bNode(?:\.js)?(${BRIDGE})(?:>=|≥)${INLINE_JUNK}(${VERSION})`,
  "g",
);

/** 规则 2：`Node 22.13+`（版本带后缀加号） */
const PREFIX_RULE = new RegExp(
  String.raw`\bNode(?:\.js)?(${BRIDGE})(${VERSION})${INLINE_JUNK}\+`,
  "g",
);

/** 规则 3：shields.io 徽章里 URL 编码后的 `>=`（`node-%3E%3D22.13`） */
const BADGE_RULE = new RegExp(String.raw`%3E%3D(${VERSION})`, "g");

/** 任意 Node 版本字面量（普查用，`major` 两位起：裸大版本 `16` / `20` 不在此列） */
const ANY_VERSION = /\b\d{2}\.\d+(?:\.\d+)?\b/g;

/** 「这一行在谈运行时」的粗口径：只用于**普查报出**，不用于判定 */
const RUNTIME_CONTEXT = /node(?:\.js)?\b|node:sqlite|node:\d|engines/i;

export interface FloorHit {
  /** 相对 `REPO_ROOT`、`/` 分隔 */
  file: string;
  /** 1-based 行号 */
  line: number;
  /** 命中的规则（同一版本被多条规则命中时合并） */
  rules: readonly FloorRule[];
  /** 提取出的版本原文 */
  version: string;
  /** 运行时名与比较符 / 版本之间**隔着一截含文字的散文**（false = 只隔着反引号、空格一类修饰） */
  proseBridge: boolean;
  /** 该行原文（裁剪过，失败时直接贴现场） */
  text: string;
}

export interface LineHit {
  rules: readonly FloorRule[];
  version: string;
  proseBridge: boolean;
}

/** 桥接窗口里出现文字（字母 / 汉字）即「散文桥接」——纯反引号 / 空格不算 */
const HAS_PROSE = /[A-Za-z\u3040-\u9fff]/;

/**
 * 一行文本里所有的地板声明（同一版本合并成一条，规则取并集）
 *
 * @description 逐行匹配（不跨行）。跨行形状由 `crossLineFloorShapes()` 单独普查、并在断言档里
 * 断言为零：哪天有人把声明折行排版，那里会先红提示判据口径要显式扩到跨行，而不是让那条
 * 声明静默逃出护栏。
 */
export function floorHitsInLine(line: string): LineHit[] {
  const collected: Array<{ rule: FloorRule; version: string; bridge: string }> = [];
  for (const match of line.matchAll(COMPARATOR_RULE)) {
    collected.push({ rule: "比较符形态", version: match[2] ?? "", bridge: match[1] ?? "" });
  }
  for (const match of line.matchAll(PREFIX_RULE)) {
    collected.push({ rule: "后缀加号形态", version: match[2] ?? "", bridge: match[1] ?? "" });
  }
  for (const match of line.matchAll(BADGE_RULE)) {
    collected.push({ rule: "徽章编码形态", version: match[1] ?? "", bridge: "" });
  }

  const byVersion = new Map<string, { rules: FloorRule[]; version: string; proseBridge: boolean }>();
  for (const { rule, version, bridge } of collected) {
    if (version === "") continue;
    const entry = byVersion.get(version) ?? { rules: [] as FloorRule[], version, proseBridge: false };
    if (!entry.rules.includes(rule)) entry.rules.push(rule);
    if (HAS_PROSE.test(bridge)) entry.proseBridge = true;
    byVersion.set(version, entry);
  }
  return [...byVersion.values()].map((entry) => ({ ...entry, rules: [...entry.rules] }));
}

/** 版本号三元组（`22.13` → `[22, 13, 0]`） */
export function versionTriple(version: string): [number, number, number] {
  const parts = version.split(".").map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** `22.13` 与 `22.13.0` 是同一个地板（缺省 patch 视为 `0`）；`22.13.1` 不是 */
export function sameFloor(a: string, b: string): boolean {
  const [x, y] = [versionTriple(a), versionTriple(b)];
  return x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
}

// ── 唯一真相源：`package.json` 的 `engines.node` ──

export type EnginesRead =
  | { ok: true; raw: string; major: number; minor: number; patch: number }
  | { ok: false; raw: unknown; reason: string };

let enginesCache: EnginesRead | null = null;

/**
 * 校验一个 `engines.node` 候选值，要求它是**单一 floor 形态** `>=M.m.p`
 *
 * @description 区间（`>=18 || >=22`）与 caret（`^22.13`）都判为不合格：文档只引用**一个**数字，
 * 写成多段地板之后，「文档写的那个数」根本无法表达 `engines` 的完整语义，两者从此无法互相
 * 校验 —— 那正是本档要防的失联。
 */
export function parseEnginesNode(raw: unknown): EnginesRead {
  if (typeof raw !== "string") {
    return { ok: false, raw, reason: `engines.node 缺失或不是字符串（实际 ${JSON.stringify(raw)}）` };
  }
  const matched = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(raw);
  if (!matched) {
    return { ok: false, raw, reason: `engines.node 必须写成单一 floor 形态 >=M.m.p，实际是 ${JSON.stringify(raw)}` };
  }
  return {
    ok: true,
    raw,
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: Number(matched[3]),
  };
}

/** 读 `package.json` 的 `engines.node`（整个进程只读一次） */
export function readEnginesFloor(): EnginesRead {
  if (enginesCache) return enginesCache;
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    engines?: { node?: unknown };
  };
  enginesCache = parseEnginesNode(pkg.engines?.node);
  return enginesCache;
}

// ── 扫描面 ──

const decoder = new TextDecoder("utf-8", { fatal: true });

/** 二进制 / 非 UTF-8 / 过大 → 跳过（`readme/screenshot.png`、`.wasm`、`.zip`、`.exe`） */
function isScannableText(rel: string): boolean {
  const buffer = fs.readFileSync(path.join(REPO_ROOT, rel));
  if (buffer.length > MAX_FILE_BYTES) return false;
  if (buffer.includes(0)) return false;
  try {
    decoder.decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function isExcludedDir(name: string, depth: number): boolean {
  if (EXCLUDED_DIRS_ANY_DEPTH.includes(name)) return true;
  return depth === 0 && EXCLUDED_DIRS_AT_ROOT.includes(name);
}

function isExcludedFile(rel: string): boolean {
  if (EXCLUDED_FILE_PATTERNS.some((re) => re.test(rel))) return true;
  if (SCAN_EXCLUDED_SELF_FILES.includes(rel)) return true;
  if (rel.split("/").includes("cfg") && !CFG_ALLOWED_SUFFIXES.some((s) => rel.endsWith(s))) return true;
  return false;
}

export interface RepoScan {
  /** 扫描面内的文本文件（已排序） */
  files: readonly string[];
  /** 全部地板声明命中（按文件、行排序） */
  hits: readonly FloorHit[];
  /** 因二进制 / 非 UTF-8 / 过大而跳过的文件：它们是**降级面**，必须报出而不是静默消失 */
  skipped: readonly string[];
}

let scanCache: RepoScan | null = null;

/** 全仓扫描（整个进程只跑一次：判据输出跨档共用，避免每档各扫一遍） */
export function scanRepo(): RepoScan {
  if (scanCache) return scanCache;
  const files: string[] = [];
  const skipped: string[] = [];
  const hits: FloorHit[] = [];

  const walk = (dir: string, prefix: string, depth: number): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (isExcludedDir(entry.name, depth)) continue;
        walk(path.join(dir, entry.name), `${prefix}${entry.name}/`, depth + 1);
        continue;
      }

      const rel = `${prefix}${entry.name}`;
      if (isExcludedFile(rel)) continue;
      if (!isScannableText(rel)) {
        skipped.push(rel);
        continue;
      }

      files.push(rel);
      const lines = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8").split("\n");
      lines.forEach((text, index) => {
        for (const hit of floorHitsInLine(text)) {
          hits.push({
            file: rel,
            line: index + 1,
            rules: hit.rules,
            version: hit.version,
            proseBridge: hit.proseBridge,
            text: text.trim().slice(0, 160),
          });
        }
      });
    }
  };
  walk(REPO_ROOT, "", 0);

  files.sort();
  skipped.sort();
  scanCache = { files, hits, skipped };
  return scanCache;
}

/** 走一遍工作树，返回全部在扫描面内的**文本**文件（相对 `REPO_ROOT`、`/` 分隔、已排序） */
export function scannedTextFiles(): readonly string[] {
  return scanRepo().files;
}

/**
 * `lib/`（`build:lib` 的产物）里命中地板判据的那些行
 *
 * @description 这条素材**存在才成立**（`lib/` 是 gitignored 产物，没跑过 `build:lib` 的工作树上
 * 返回空数组）。它的用途是**证明「排除 `lib/`」这件事在干活**：`.d.ts` / `.js` 是 `tsc` 从
 * `src/**` 拷过去的注释，内容由 `src/` 决定，扫进去只会让构建产物冒充真相源。
 */
export function excludedAreaHits(relDir = "lib"): FloorHit[] {
  const base = path.join(REPO_ROOT, relDir);
  if (!fs.existsSync(base)) return [];
  const hits: FloorHit[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      if (!/\.(ts|js|mjs|cjs|md|json)$/.test(entry.name)) continue;
      const rel = `${relDir}/${prefix}${entry.name}`;
      if (!isScannableText(rel)) continue;
      const lines = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8").split("\n");
      lines.forEach((text, index) => {
        for (const hit of floorHitsInLine(text)) {
          hits.push({
            file: rel,
            line: index + 1,
            rules: hit.rules,
            version: hit.version,
            proseBridge: hit.proseBridge,
            text: text.trim().slice(0, 160),
          });
        }
      });
    }
  };
  walk(base, "");
  return hits;
}

// ── 普查：跨行形状与未钉的边界叙述（**只报出，不判定**） ──

/** 一行以运行时名收尾 —— 若下一行以比较符 / 版本收头，就是一条跨行的地板声明 */
const RUNTIME_TAIL = new RegExp(String.raw`\b(?:Node(?:\.js)?|node:sqlite)${INLINE_JUNK}$`);
const NEXT_LINE_COMPARATOR = new RegExp(String.raw`^${INLINE_JUNK}(?:>=|≥)${INLINE_JUNK}(\d+\.\d+)`);
const NEXT_LINE_PREFIXED = new RegExp(String.raw`^${INLINE_JUNK}(\d+\.\d+(?:\.\d+)?)${INLINE_JUNK}\+`);

export interface CrossLineShape {
  file: string;
  /** 运行时名所在行（1-based） */
  line: number;
  text: string;
}

/**
 * 跨行的地板声明形状（运行时名与地板被换行拆开）
 *
 * @description 本档的行级判据**看不见**这种形状。返回它是为了让断言档把「今天一处都没有」钉成
 * 事实：哪天有人把声明折行排版，这里会先红，提示判据口径需要显式扩到跨行，而不是让那条声明
 * 静默逃出护栏。
 */
export function crossLineFloorShapes(): CrossLineShape[] {
  const out: CrossLineShape[] = [];
  for (const rel of scanRepo().files) {
    const lines = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8").split("\n");
    for (let i = 0; i + 1 < lines.length; i++) {
      const current = lines[i] ?? "";
      if (!RUNTIME_TAIL.test(current)) continue;
      const next = lines[i + 1] ?? "";
      if (!NEXT_LINE_COMPARATOR.test(next) && !NEXT_LINE_PREFIXED.test(next)) continue;
      out.push({ file: rel, line: i + 1, text: `${current.trim()} ⏎ ${next.trim()}`.slice(0, 160) });
    }
  }
  return out;
}

export interface UnpinnedMention {
  file: string;
  line: number;
  /** 这一行里「在谈运行时、但没被钉住」的版本字面量 */
  versions: readonly string[];
  text: string;
}

/**
 * 在谈运行时、却**不被地板判据钉住**的版本字面量
 *
 * @description 上界写法（`Node < 22.13`）、裸边界叙述（`22.5 出生` / `22.5–22.12`）、以及「数字
 * 自己是句子主语」（`**为什么是 22.13**`）都在这里。**它们不是漂移**：`node:sqlite` 的两个边界
 * 各自独立，钉死它们会把两件事压成一个数。本函数只普查，作用是让这些提及**看得见**，免得
 * 「判据没覆盖到」这件事只存在于判据作者的脑子里。
 */
export function unpinnedRuntimeMentions(): UnpinnedMention[] {
  const out: UnpinnedMention[] = [];
  for (const rel of scanRepo().files) {
    const lines = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8").split("\n");
    lines.forEach((text, index) => {
      if (!RUNTIME_CONTEXT.test(text)) return;
      const pinned = new Set(floorHitsInLine(text).map((h) => h.version));
      const versions = new Set(
        [...text.matchAll(ANY_VERSION)]
          .map((m) => m[0])
          .filter((v) => versionTriple(v)[0] >= 16 && !pinned.has(v)),
      );
      if (versions.size === 0) return;
      out.push({
        file: rel,
        line: index + 1,
        versions: [...versions],
        text: text.trim().slice(0, 160),
      });
    });
  }
  return out;
}

/** 读仓内某个文件（相对 `REPO_ROOT`）的原文；文件不存在时抛错（锚点消失必须让断言红） */
export function repoText(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

// ── 判据自检样本（防「探测器写坏了 → 全绿」） ──

/** 自检样本里的一条：文本 + 期望提取出的版本 + 期望命中的规则 */
export interface SelfCheckSample {
  rule: FloorRule;
  version: string;
  text: string;
}

/** 「不得被当成地板」的样本：文本 + 该行里**绝不许**被提取成地板的那些边界版本 */
export interface BoundaryNotPinnedSample {
  /** 绝不许被提取的版本（`node:sqlite` 的两个边界 / 区间尾数） */
  boundary: string;
  text: string;
}

/**
 * 探测器的自检样本
 *
 * @description `mustFlag.dirty` 逐字复刻本仓真实发生过的两类漂移（`22.6` 顶替 `22.13`、
 * `22.5` 被当成免 flag 版本）；`mustFlag.clean` 逐字取自**今天合法的写法**（相邻 / 隔散文 /
 * 无空格 / 反引号 / 后缀加号 / 徽章编码）。断言档既要求「认得出」，也要求「`dirty` 的版本确实
 * 不等于今天的 `engines` 地板」—— 两者合起来才是「它会红」。
 *
 * `mustNotFlag` 逐条取自**今天的合法文本**且必须**零命中**（上界写法、模块名与镜像标签、区间、
 * 两个边界的机制叙述，以及根 `AGENTS.md` 里「把 engines 写成 `>=99.0.0` 再装」的方法学举例）。
 * `mustNotPinBoundary` 是另一类合法文本：它**有**命中（`22.13`），但同一行里的 `22.5` /
 * `22.12` 绝不许被顺手提出来当地板 —— 「识别度」与「误判面」必须分开断言。
 *
 * 两张表逐条取自**今天真实存在的行**：负向判据的锚点必须是活着的形状，否则它会恒真而不是
 * 失败（根 `AGENTS.md`「写护栏时」）。
 */
export const SELF_CHECK: {
  mustFlag: { dirty: readonly SelfCheckSample[]; clean: readonly SelfCheckSample[] };
  mustNotFlag: readonly string[];
  mustNotPinBoundary: readonly BoundaryNotPinnedSample[];
} = {
  mustFlag: {
    dirty: [
      { rule: "比较符形态", version: "22.6", text: "Requires **Node.js >= 22.6** for both CLI and library mode." },
      { rule: "比较符形态", version: "22.6", text: "只准 `pnpm`（Node >= 22.6、pnpm `>=9`）" },
      { rule: "比较符形态", version: "22.6", text: "- **Node.js >= 22.6**（`engines` 声明，CLI 与库模式均要求）" },
      { rule: "比较符形态", version: "22.6", text: "| Node.js | Node >= 22.6 | npm 包（CLI 与库模式统一）的要求 |" },
      { rule: "比较符形态", version: "22.6", text: "只准 `pnpm`（Node `>=22.6`、pnpm `>=9`）" },
      { rule: "比较符形态", version: "22.6", text: "| Node>=22.6 | npm 包（CLI 与库模式统一）的要求 |" },
      {
        rule: "比较符形态",
        version: "22.6",
        text: "Requires Node.js installed locally (**`engines` says `>= 22.6`**, for both CLI and library mode):",
      },
      {
        rule: "比较符形态",
        version: "22.5",
        text: "本仓要同时支持两档运行时，而 `node:sqlite`（Node 内置）要到 **Node.js >= 22.5** 才**免 flag**",
      },
      { rule: "比较符形态", version: "99.0", text: "只准 `pnpm`（Node >= 99.0、pnpm `>=9`）" },
      { rule: "后缀加号形态", version: "22.6", text: " * @fileoverview SQLite 驱动实现（两档）：Node 22.6+ 内置 / Node 16–22 WASM" },
      { rule: "后缀加号形态", version: "22.6", text: "- `sqlite/` — SQLite 驱动层（端口 + Node 22.6+ 内置 / Node 16–22.12 WASM 两档分流）" },
      {
        rule: "徽章编码形态",
        version: "22.6",
        text: "[![Node](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen.svg)](https://nodejs.org)",
      },
    ],
    clean: [
      { rule: "比较符形态", version: "22.13", text: "只准 `pnpm`（Node `>=22.13`、pnpm `>=9`）" },
      { rule: "比较符形态", version: "22.13", text: "### 「开发必须 Node >= 22.13」由谁保证：**不是 `engines`**" },
      { rule: "比较符形态", version: "22.13", text: "| Node.js | Node >= 22.13 | npm 包（CLI 与库模式统一）的要求，见下方说明 |" },
      { rule: "比较符形态", version: "22.13", text: "#          （v = v + excluded.v），**没有上面那个压缩窗口**；Node ≥22.13 走内置档（有真 WAL）。" },
      { rule: "比较符形态", version: "22.13", text: "驱动按运行时自动分档：Node ≥ 22.13 用内置 `node:sqlite`（真 WAL）；Node 16–22 用" },
      { rule: "比较符形态", version: "22.13", text: " * | Node ≥ 22.13 | `node:sqlite`（内置，零依赖） | **真 WAL**（读写不互斥） |" },
      { rule: "比较符形态", version: "22.13", text: "- **Node.js >= 22.13**（`engines` 声明，CLI 与库模式均要求）" },
      { rule: "比较符形态", version: "22.13", text: "需要本地安装 Node.js **>= 22.13**（`engines` 声明，CLI 与库模式统一要求）：" },
      { rule: "比较符形态", version: "22.13", text: "> 本包的 CLI 与库模式统一要求 **Node.js >= 22.13**（`engines`）。库入口只导出 API" },
      {
        rule: "比较符形态",
        version: "22.13",
        text: "Requires Node.js installed locally (**`engines` says `>= 22.13`**, for both CLI and library mode):",
      },
      { rule: "后缀加号形态", version: "22.13", text: " * @fileoverview SQLite 驱动实现（两档）：Node 22.13+ 内置 / Node 16–22 WASM" },
      { rule: "后缀加号形态", version: "22.13", text: "/** 内置档：Node 22.13+ 的 `node:sqlite`（22.5–22.12 需 flag，用不了，故不在此列） */" },
      { rule: "徽章编码形态", version: "22.13", text: "[![Node](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)](https://nodejs.org)" },
    ],
  },
  mustNotFlag: [
    // 上界写法：说的是「低于免 flag 版本」，不是地板
    "/** 探内置档；取不到（Node < 22.13）返回 undefined。**探测用 require 本身**，不靠版本号。 */",
    "# 运行期依赖：**不是**「顺手拷的」，是 Node < 22.5 那条路的唯一前置。",
    // 模块名与镜像标签（小写 `node:`）：不是运行时地板
    "# 缺了它，base image 是 node:22（≥22.5，走内置档）时**一切正常**，",
    // 区间与「边界尾数」：声明的是**紧跟比较符 / 加号**的那个版本，区间尾数不是地板
    " * | Node 16 – 22.12 | `node-sqlite3-wasm`（纯 WASM，无 native 编译） | 无 WAL，靠 `busy_timeout` 串行化 |",
    // 没有运行时锚点：版本比较确实存在，但它不是在说「本仓要求的 Node 地板」
    "装依赖前请确认 `>= 22.13`（engines 只会 WARN，拦不住你）",
    // 两个边界的机制叙述：合法，不是漂移
    " * （22.5 出生时仍需 `--experimental-sqlite`）。16/18/20/22.0–22.12 上不带 flag 的",
    '- **分流判据是「`require("node:sqlite")` 成不成」，不是任何版本号比较**：`node:sqlite` 有**两个**边界（**22.5** 出生、**22.13** 免 flag）',
    " * **22.5** 才出生（此前模块压根不存在），**22.13** 才去掉 `--experimental-sqlite` flag。",
    "**为什么是 22.13**：这是 `node:sqlite`（SQLite 内置档）**去掉 flag 的那个版本**。实测 16 / 18 / 20 上产物能跑通完整链路",
    // 方法学举例：这一行在讲「一次实测」，它写的版本不是本仓地板
    "`package.json` 的 `engines` **不拦开发环境**，实测（把根包 `engines` 写成 `>=99.0.0` 再装）：",
  ],
  mustNotPinBoundary: [
    {
      boundary: "22.12",
      text: "- `sqlite/` — SQLite 驱动层（端口 + Node 22.13+ 内置 / Node 16–22.12 WASM 两档分流）；见 `src/utils/sqlite/AGENTS.md`",
    },
    {
      boundary: "22.5",
      text: "/** 内置档：Node 22.13+ 的 `node:sqlite`（22.5–22.12 需 flag，用不了，故不在此列） */",
    },
    {
      boundary: "22.12",
      text: " * | Node 16 – 22.12 | `node-sqlite3-wasm`（纯 WASM，无 native 编译） | 无 WAL，靠 `busy_timeout` 串行化 |",
    },
  ],
};

/** 判据自检档用：**两个 `node:sqlite` 边界必须在同一处同时出现（缺一个即红） */
export const SQLITE_BOUNDARIES: readonly { file: string; boundaries: readonly string[] }[] = [
  { file: "src/utils/sqlite/driver.ts", boundaries: ["22.5", "22.13"] },
  { file: "src/utils/sqlite/open.ts", boundaries: ["22.5", "22.13"] },
  { file: "src/utils/sqlite/AGENTS.md", boundaries: ["22.5", "22.13"] },
  { file: "AGENTS.md", boundaries: ["22.5", "22.13"] },
];

/** 覆盖面档用：**今天必须在扫描面内、且必须各含至少一条地板声明的文件 */
export const MUST_DECLARE_FILES: readonly string[] = [
  "README.md",
  "readme/README.en.md",
  "readme/README.zh-CN.md",
  "readme/usage/node.en.md",
  "readme/usage/node.zh-CN.md",
  "AGENTS.md",
  ".env.example",
];
