import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXCLUDED_DIRS_ANY_DEPTH,
  EXCLUDED_DIRS_AT_ROOT,
  EXCLUDED_FILE_PATTERNS,
  SCAN_EXCLUDED_SELF_FILES,
  excludedAreaHits,
  unpinnedRuntimeMentions,
} from "../../../helpers/runtime-floor-scan.js";
import { REPO_ROOT } from "../../../helpers/source-scan.js";
import { engines, floor, scan } from "./_runtime-floor.js";

/**
 * 运行时地板护栏 —— 覆盖面与降级面（`0` 那一组）
 *
 * @description 本档只答「这道护栏此刻覆盖了哪些文本」：扫了多少、命中多少、降级面落在哪，
 * 以及**每一项排除是不是有东西可排**。少了这一档，「只覆盖了哪些文本」就只存在于判据作者脑子里。
 * 六档分工 / 判据自检的口径 / ⚠️ 自指排除清单为什么必须跟着搬家，见 `./AGENTS.md`；
 * 文本面（探测器与合成脏样本）在 `../../../helpers/runtime-floor-scan.ts`。
 */

/** `lib/` 是否存在（`build:lib` 的产物，gitignored） */
const hasLib = existsSync(path.join(REPO_ROOT, "lib", "index.js"));
/** `lib/` 里的陈旧声明（证明排除 `lib/` 这件事在干活） */
const libHits = hasLib ? excludedAreaHits("lib") : [];

describe("Node 运行时地板护栏", () => {
  describe("0 覆盖面：扫了多少、命中多少、降级面在哪（必须看得见）", () => {
    it(`报出本档此刻的覆盖面：${scan.files.length} 个文本文件 / ${scan.hits.length} 处地板声明 / 跳过 ${scan.skipped.length} 个非文本`, () => {
      const perFile = new Map<string, number>();
      for (const hit of scan.hits) perFile.set(hit.file, (perFile.get(hit.file) ?? 0) + 1);
      const summary = [...perFile]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([file, n]) => `  ${n} × ${file}`)
        .join("\n");
      process.stderr.write(
        [
          `运行时地板护栏：扫了 ${scan.files.length} 个文本文件，命中 ${scan.hits.length} 处地板声明（地板 = ${floor}）`,
          ...(engines.ok ? [] : [`  ⚠️ engines.node 不合格：${engines.reason}`]),
          "命中分布：",
          summary,
          `降级面：跳过 ${scan.skipped.length} 个非文本文件（${scan.skipped.join("、") || "无"}）`,
          `未钉的运行时版本提及：${unpinnedRuntimeMentions().length} 处（只报出、不判定，见第 4 档）`,
          "",
        ].join("\n"),
      );

      // 扫描面下界：路径写错、排除清单写太宽、或整仓遍历坏掉时这一档会立刻红
      expect(scan.files.length).toBeGreaterThan(100);
      // 命中下界：判据一条都匹配不到时这一档会立刻红（下界不是定数，见第 2 档的说明）
      expect(scan.hits.length).toBeGreaterThanOrEqual(8);
      // 降级面不许把源码吃掉：非文本跳过清单里不许出现源码 / 文档 / 配置扩展名
      const textExtensions = /\.(ts|tsx|mts|cts|js|mjs|cjs|md|json|jsonc|ya?ml|example|development|production)$/;
      expect(scan.skipped.filter((f) => textExtensions.test(f))).toEqual([]);
    });

    it("扫描面排除了依赖与构建产物（node_modules / .git / dist / lib 任意层级）", () => {
      for (const hit of scan.hits) {
        expect(EXCLUDED_DIRS_ANY_DEPTH.some((d) => hit.file.split("/").includes(d))).toBe(false);
      }
      // 锁文件是依赖解析的机器产物，且体量大到会淹没判据输出
      for (const pattern of EXCLUDED_FILE_PATTERNS) {
        expect(scan.files.filter((f) => pattern.test(f))).toEqual([]);
      }
    });

    it("排除清单不许扩大到源码与文档目录（豁免面不可被悄悄放大）", () => {
      // 排除项只能是依赖 / 构建产物 / 本机状态 / 编辑器配置
      for (const kept of ["src", "tests", "readme", "scripts", "keys", "cfg", ".opencode"]) {
        expect(EXCLUDED_DIRS_ANY_DEPTH).not.toContain(kept);
        expect(EXCLUDED_DIRS_AT_ROOT).not.toContain(kept);
      }
      // 且排除项确实都是今天真实存在的目录（写一个不存在的排除名 = 白写）
      const declared = [...EXCLUDED_DIRS_ANY_DEPTH, ...EXCLUDED_DIRS_AT_ROOT];
      const onDisk = declared.filter((d) => existsSync(path.join(REPO_ROOT, d)));
      expect(onDisk.length).toBeGreaterThanOrEqual(4);
    });

    it("log 只在仓库根排除：源码目录 src/server/log/ 必须在扫描面内", () => {
      // `.gitignore` 自己把 `/log/` 写成根锚定，理由是裸 `log/` 会把 src/server/log/ 一起吞掉。
      // 护栏若按任意层级排除 `log`，就会把一份源码级注释从扫描面里静默删掉。
      expect(EXCLUDED_DIRS_AT_ROOT).toContain("log");
      expect(EXCLUDED_DIRS_ANY_DEPTH).not.toContain("log");
      expect(scan.files).toContain("src/server/log/config-log.ts");
      expect(scan.files).toContain("src/server/log/AGENTS.md");
    });

    it("自指排除恰好两份（判据的素材面与它自己的说明，理由见 helper 文件头）", () => {
      // ⚠️ 这一条**钉的是字面量数组**，所以 `runtime-floor-scan.ts` 的
      // `SCAN_EXCLUDED_SELF_FILES` 与它必须逐字同步：不同步的话这张表会恒绿，
      // 而「排除真的生效」这件事就只剩下面那半截在验。
      expect([...SCAN_EXCLUDED_SELF_FILES].sort()).toEqual([
        "tests/helpers/runtime-floor-scan.ts",
        "tests/unit/meta/runtime-floor/truth-source.test.ts",
      ]);
      // 排除必须真的生效，否则上面那张表就是一句空话
      for (const self of SCAN_EXCLUDED_SELF_FILES) {
        expect(scan.files).not.toContain(self);
      }
    });

    describe.skipIf(!hasLib)("lib/ 排除的牙齿（产物存在时才有）", () => {
      it("单独扫 lib/ 会命中地板声明 —— 所以排除它不是空转，而是有东西可排", () => {
        expect(libHits.length).toBeGreaterThan(0);
        process.stderr.write(
          `运行时地板护栏：lib/（build:lib 的产物，gitignored）里有 ${libHits.length} 处地板声明，` +
            `例如 ${libHits[0]?.file}:${libHits[0]?.line} 声明 ${libHits[0]?.version} —— ` +
            "它由 src/ 决定，已被显式排除，不参与判定\n",
        );
      });

      it("lib/ 里的声明要么与地板相同、要么是另一条**合法**的边界叙述（不是地板漂移）", () => {
        // ⚠️ 判据刻意**不是**「lib/ 里有与地板不同的声明」：`build:lib` 是 `src/` 的忠实编译，
        // 所以重建后的 lib/ 必然与 src/ 一致、与地板一致。上一版把「存在陈旧声明」当前提，
        // 于是 `pnpm build:lib` 跑完就红 —— 那是在要求一个**陈旧产物**永远不许被重建，
        // 把「排除 lib/」的理由从「它是派生产物」偷换成了「它碰巧是错的」。
        //
        // 真正要钉的是排除的**理由**：lib/ 里的地板形状必须与 src/ 同源（同一批文件），
        // 所以它要么等于地板、要么是被判据显式放行的边界叙述（如 sqlite 的 22.5 出生线），
        // **绝不会**出现「src/ 里没有、只有 lib/ 才有」的地板数字。
        const srcVersions = new Set(scan.hits.map((h) => h.version));
        const libOnly = libHits.filter((h) => !srcVersions.has(h.version));
        expect(
          libOnly.map((h) => `${h.file}:${h.line} → ${h.version}`),
          "lib/ 里有 src/ 不存在的地板数字：那是 lib/ 自己漂了（陈旧产物），该重建 build:lib 而不是改判据",
        ).toEqual([]);
      });
    });
  });
});