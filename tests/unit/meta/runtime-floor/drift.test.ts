import { describe, expect, it } from "vitest";
import {
  MUST_DECLARE_FILES,
  SQLITE_BOUNDARIES,
  crossLineFloorShapes,
  floorHitsInLine,
  repoText,
  sameFloor,
  unpinnedRuntimeMentions,
  versionTriple,
} from "../../../helpers/runtime-floor-scan.js";
import { floor, scan } from "./_runtime-floor.js";

/**
 * 运行时地板护栏 —— 零漂移与判据的视野边界（`2` / `3` / `4` 三组）
 *
 * @description 核心档是「全仓每一处声明地板的形状都必须等于 `engines.node`」，外加三组边界：
 * 承诺地板的入口文档必须**正向**声明、`node:sqlite` 的**两个**边界必须并存（缺了就红）、
 * 判据的视野边界本身要可判。「地板 vs 边界叙述」与三条刻意的口径收窄见 `./AGENTS.md`。
 * ⚠️ 本档注释里**不许**出现故意写错的版本 —— 那份豁免只给 `truth-source.test.ts`。
 */

/** 全部命中里不等于地板的那些（核心档的判据） */
const violations = scan.hits.filter((h) => !sameFloor(h.version, floor));

describe("Node 运行时地板护栏", () => {
  describe("2 地板声明：全仓零漂移（核心档）", () => {
    it(`${scan.hits.length} 处地板声明全部等于 engines 地板 ${floor}`, () => {
      const detail = violations
        .map(
          (h) =>
            `  ${h.file}:${h.line}  声明 ${h.version}（规则 ${h.rules.join("/")}）\n    ${h.text}`,
        )
        .join("\n");
      expect(
        violations.map((h) => `${h.file}:${h.line} → ${h.version}`),
        `这些地方声明的 Node 地板不是 engines 里的 ${floor}：\n${detail}\n\n` +
          "修法只有一条：package.json 的 engines.node 是唯一真相源。改地板就改它，然后同步全仓；\n" +
          "改错了就把这一处改回它。**不要**在别处新写一个数。\n" +
          "注意 node:sqlite 的 22.5（出生）与 22.13（免 flag）是两个独立事实，那类叙述不是漂移、" +
          "本档也不判它们。",
      ).toEqual([]);
    });

    it(`命中数 ${scan.hits.length} >= 8（下界，不是定数）`, () => {
      // 命中数会随文档增删变化。钉死具体个数会把「加一个文档」变成「改一次测试」的噪音，
      // 于是人们会去改测试而不是加文档；下界只挡住「探测器整体失灵」。
      expect(scan.hits.length).toBeGreaterThanOrEqual(8);
    });

    it.each(MUST_DECLARE_FILES)("%s 必须至少声明一处地板", (file) => {
      // 正向存在性：这些是今天对消费者承诺地板的入口文档，删掉声明等于撤掉承诺
      expect(scan.files, `${file} 不在扫描面内（路径写错，或它已被移出受版本管理的范围）`).toContain(file);
      const own = scan.hits.filter((h) => h.file === file);
      expect(own.length, `${file} 里一处地板声明都没有了`).toBeGreaterThanOrEqual(1);
    });

    it("紧邻写法与隔散文写法都被认出来（48 字符桥接窗口不是死代码）", () => {
      // 桥接窗口若被谁改窄成「只认反引号与空格」，`readme/README.en.md` 那句
      // 「Requires Node.js installed locally (**`engines` says `>= 22.13`**…)」就会从护栏里
      // 消失 —— 而它恰恰是唯一一处把 `engines` 与地板写在同一行散文里的英文文档。
      expect(scan.hits.filter((h) => h.proseBridge).length).toBeGreaterThanOrEqual(1);
      expect(scan.hits.filter((h) => !h.proseBridge).length).toBeGreaterThanOrEqual(8);
    });
  });

  describe("3 正向存在性：node:sqlite 的两个边界必须并存", () => {
    it.each(SQLITE_BOUNDARIES.map((b) => [b.file, b.boundaries.join(" 与 ")] as const))(
      "%s 里必须同时出现两个边界（%s）",
      (file) => {
        // **正向**断言（缺了就红），不是负向。`node:sqlite` 的分流判据是「require 得不得成」，
        // 而它的理由就是「有两个边界」；把两档表简化成一句就会把这个理由删掉 —— 删掉之后
        // 下一个读代码的人会以为「22.5 就够」，而代码在 22.5–22.12 上其实会静默落到 WASM 档。
        const text = repoText(file);
        for (const boundary of SQLITE_BOUNDARIES.find((b) => b.file === file)?.boundaries ?? []) {
          expect(text.includes(boundary), `${file} 里没有 ${boundary}：两个边界的机制叙述被删掉了一半`).toBe(true);
        }
      },
    );
  });

  describe("4 口径自检：判据的视野边界本身要可判", () => {
    it("跨行的地板形状为零（行级口径今天不漏东西）", () => {
      // 一条声明被折行排版（「Node」在行尾、地板在下一行）时，行级判据看不见它。
      // 今天一处都没有 —— 钉住这个「零」，哪天有人折行排版，这里会先红，提示口径要显式扩到
      // 跨行，而不是让那条声明静默逃出护栏。
      const shapes = crossLineFloorShapes();
      expect(shapes.map((s) => `${s.file}:${s.line}`), `出现了跨行的地板声明：\n${shapes.map((s) => `  ${s.file}:${s.line}  ${s.text}`).join("\n")}`).toEqual([]);
    });

    it("在谈运行时、却没被钉住的版本字面量被普查出来（普查器不是死代码）", () => {
      // 这一档是「边界叙述不许被误判成漂移」的对偶面：它们**不是**漂移，但也不能从视野里消失。
      // 上界写法（`Node < 22.13`）、裸边界叙述（`22.5 出生`）、以及「数字自己是句子主语」
      // （`**为什么是 22.13**`）都在这里 —— 判据覆盖不到它们是**已知缺口**，不是「不存在」。
      const mentions = unpinnedRuntimeMentions();
      expect(mentions.length).toBeGreaterThan(0);
      const scanned = new Set(scan.files);
      expect(mentions.filter((m) => !scanned.has(m.file))).toEqual([]);
      process.stderr.write(
        `运行时地板护栏：未钉的运行时版本提及 ${mentions.length} 处 —— 已知缺口，非漂移：\n` +
          mentions.map((m) => `  ${m.file}:${m.line}  [${m.versions.join("、")}]  ${m.text}`).join("\n") +
          "\n",
      );
    });

    it("判据与普查构成一个划分：每处运行时版本字面量要么被钉住、要么被普查报出", () => {
      // 用一份**独立写在这里的**朴素扫描做对照：它比 helper 里的两份都笨（不做上下文判定、
      // 不认边界），因此「它看见的都被前两者覆盖」是一条真的信号 —— 探测器或普查器的正则
      // 少写一个字符，就会有字面量从两份视野里同时溜走，这里立刻红。
      const DUMB_VERSION = /\b\d{2}\.\d+(?:\.\d+)?\b/g;
      const RUNTIME_CONTEXT = /node(?:\.js)?\b|node:sqlite|node:\d|engines/i;
      const reported = new Map(unpinnedRuntimeMentions().map((m) => [`${m.file}\u0000${m.line}`, m.versions]));
      const missing: string[] = [];
      for (const rel of scan.files) {
        repoText(rel)
          .split("\n")
          .forEach((line, index) => {
            if (!RUNTIME_CONTEXT.test(line)) return;
            const all = [...new Set([...line.matchAll(DUMB_VERSION)].map((m) => m[0]))].filter(
              (v) => versionTriple(v)[0] >= 16,
            );
            if (all.length === 0) return;
            const pinned = new Set(floorHitsInLine(line).map((h) => h.version));
            const census = reported.get(`${rel}\u0000${index + 1}`) ?? [];
            for (const v of all) {
              if (pinned.has(v) || census.includes(v)) continue;
              missing.push(`${rel}:${index + 1}  ${v}`);
            }
          });
      }
      expect(missing, `这些运行时版本字面量既没被地板判据钉住、也没进普查（等于从视野里消失）：\n${missing.join("\n")}`).toEqual([]);
    });
  });
});