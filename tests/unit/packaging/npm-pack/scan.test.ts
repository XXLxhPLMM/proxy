import { describe, expect, it } from "vitest";
import {
  built,
  hasDist,
  hasLib,
  isKeyMaterial,
  isNonExampleEnv,
  packManifest,
} from "./_pack-contents.js";

/**
 * tarball 清单这一档：降级面可见 + 判据自检 + 清单零命中（`files` 白名单本身的静态不变式在
 * `files-whitelist.test.ts`，两条通道的分工与「为什么是真 dry-run」见本目录 `AGENTS.md`）
 */

// ── 判据（探测器本身也受「判据自检」那一档监督） ──

/** 路径段是否等于日志目录名（`log` / `logs`），命中即运行期产物 */
const isLogSegment = (p: string): boolean =>
  p.split("/").some((seg) => seg === "log" || seg === "logs");

/** `cfg/` 下的 `.json` 必须带 `.example` 后缀（真实 users.json / acl.json 含密码与名单） */
const isRealCfgJson = (p: string): boolean =>
  p.split("/").includes("cfg") && p.endsWith(".json") && !p.endsWith(".example");

/** 源码 / 构建脚本 / 测试目录一律不进包 */
const isSourceTree = (p: string): boolean => /(^|\/)(src|scripts|tests)\//.test(p);

/**
 * 五条负向规则，**逐条**独立可读（失败时直接指出是哪一条）
 * @param p tarball 内的相对路径（`/` 分隔）
 * @returns 命中的规则名；零命中返回 `null`
 */
function violationOf(p: string): string | null {
  if (isLogSegment(p) && !p.startsWith("lib/")) return "log/logs 路径段（运行期日志目录）";
  if (isNonExampleEnv(p)) return "非 .example 的 .env.*（含明文凭证）";
  if (isKeyMaterial(p)) return "私钥/序列号（*.key/*.srl/*.pem/*.p12/*.pfx）";
  if (isRealCfgJson(p)) return "cfg/ 下非 .example 的 .json（含密码/名单）";
  if (isSourceTree(p)) return "src/ scripts/ tests/ 源码目录";
  return null;
}

/** 收集全部命中的规则（一条路径可能同时命中多条） */
function violationsOf(paths: readonly string[]): string[] {
  return paths.flatMap((p) => {
    const hit = violationOf(p);
    return hit ? [`${p} —— ${hit}`] : [];
  });
}

describe("npm pack 内容护栏", () => {
  describe("覆盖面（构建产物缺失时的降级面，必须看得见）", () => {
    it("报出本档此刻实际覆盖到哪一层", () => {
      const line = built
        ? "打包护栏：lib/ 与 dist/ 都在 → 第 1/2 档（真实 tarball 清单）已生效"
        : `打包护栏：⚠️ 缺 ${!hasLib ? "lib/" : ""}${!hasLib && !hasDist ? " 与 " : ""}${
            !hasDist ? "dist/" : ""
          } → 第 2 档（正向断言）已跳过，只剩静态不变式 + 判据自检；先跑 pnpm build:all 再看本档`;
      if (!built) process.stderr.write(`${line}\n`);
      expect(typeof line).toBe("string");
    });

    it("判据口径提示：清单取自 npm pack，pnpm pack 会额外多带 readme/ 目录", () => {
      // 只在 npm 清单里出现过的顶层项：一旦哪天 npm 也开始带 readme/，这条会提醒人
      // 回头更新文件头里那段「pnpm vs npm」的差异说明（而不是默默变宽）
      const topLevel = new Set(packManifest().files.map((p) => p.split("/")[0]));
      expect(topLevel.has("readme")).toBe(false);
      process.stderr.write(
        "打包护栏：判据取自 npm pack --dry-run；pnpm pack 会额外多带 readme/（7 个文件、无敏感内容）\n",
      );
    });
  });

  describe("判据自检（防「探测器写坏了导致所有负向断言恒绿」）", () => {
    // 这几条脏路径逐条对应 v5.1.3 tarball 里真实出现过的文件
    const realLeakSamples = [
      "dist/.env.production",
      "dist/log/2026-09-23-15.jsonl",
      "dist/keys/server.key",
      "dist/keys/ca.srl",
      "dist/cfg/acl.json",
      "dist/cfg/users.json",
      "src/cli.ts",
      "scripts/build-pkg.mjs",
      "tests/unit/pack-contents.test.ts",
    ];

    it.each(realLeakSamples)("能抓住 %s", (sample) => {
      expect(violationOf(sample)).not.toBeNull();
    });

    it("每条规则各被至少一个样本触发（没有写了却没人验的规则）", () => {
      const ruleNames = [
        "log/logs 路径段（运行期日志目录）",
        "非 .example 的 .env.*（含明文凭证）",
        "私钥/序列号（*.key/*.srl/*.pem/*.p12/*.pfx）",
        "cfg/ 下非 .example 的 .json（含密码/名单）",
        "src/ scripts/ tests/ 源码目录",
      ];
      const triggered = new Set(
        realLeakSamples.map((s) => violationOf(s)).filter((v): v is string => v !== null),
      );
      // 归并成规则名维度：每条规则至少命中一个样本
      for (const rule of ruleNames) {
        expect([...triggered].some((t) => t.endsWith(rule))).toBe(true);
      }
    });

    it("合法样本零命中（判据没有宽到把正常产物也咬掉）", () => {
      const clean = [
        "package.json",
        "README.md",
        "lib/index.js",
        "lib/index.d.ts",
        "lib/server/log/config-log.js", // 源码目录名，不是日志目录
        "dist/app.js",
        "dist/proxy-cli.js",
        "dist/.env.example",
        "dist/cfg/users.json.example",
        "dist/cfg/acl.json.example",
      ];
      expect(violationsOf(clean)).toEqual([]);
    });
  });

  describe("1 零命中：tarball 清单里不许出现的形状", () => {
    it(`npm pack --dry-run 清单零违规（实测 ${packManifest().elapsedMs}ms，${packManifest().files.length} 个文件）`, () => {
      const { files } = packManifest();
      const hits = violationsOf(files);
      expect(hits).toEqual([]);
    });

    it("带 log 路径段的路径全部在 lib/ 之下（豁免范围不可被放大）", () => {
      const logPaths = packManifest().files.filter(isLogSegment);
      expect(logPaths.length).toBeGreaterThan(0); // 防假绿：今天确有 lib/server/log/
      expect(logPaths.filter((p) => !p.startsWith("lib/"))).toEqual([]);
    });

    it("dist/ 下没有任何运行期产物（这条事故就是从 dist/ 泄漏的）", () => {
      // ⚠️ 白名单**逐项列出**而不是「不是 .example 就都放行」：新增一个 dist 产物时，
      // 这条断言必须**红**，逼人写清「它为什么可以进 tarball」。
      //
      // `node-sqlite3-wasm.wasm` 在白名单里：它是 Node 16–22 那一档 SQLite 驱动的
      // **运行时二进制**（WASM 编译目标不支持共享内存，库用 `__dirname + "/"` 定位它；
      // 缺了它 Node 16–22 会在第一次真正记账时 `ENOENT`）。它**不是**运行期产物 ——
      // 运行期产物指「测试跑出来的临时文件 / 开发者本机状态」，而它随构建生成、随包分发。
      //
      // 两个 `dist/*.js` 是**两个组合根的产物**（`build.mjs:entryPoints` 的唯一真相源）：
      // `app.js` 起服务（`MANAGER_ENABLED=true` 时同进程兼管控制面）/ `proxy-cli.js` 管数据。
      // 两个都是 `bin` 的目标，故都在 `files` 白名单里（`package.json` 的 `bin` ↔ 本表互相锁）。
      const allowedInDist = new Set([
        "dist/app.js",
        "dist/proxy-cli.js",
        "dist/node-sqlite3-wasm.wasm",
      ]);
      const distPaths = packManifest().files.filter(
        (p) => p.startsWith("dist/") && !p.endsWith(".example"),
      );
      const bad = distPaths.filter((p) => !allowedInDist.has(p));
      expect(bad).toEqual([]);
      // 防假绿：白名单里那两项今天**真的在**清单里（否则白名单可以写成空的恒绿）
      for (const allowed of allowedInDist) {
        if (allowed.endsWith("app.js") || allowed.endsWith("proxy-cli.js")) {
          continue; // 两个入口需先构建，由 files-whitelist 那组的 describe.skipIf(!built) 覆盖
        }
        expect(distPaths, `${allowed} 必须真的被 pack 收进去`).toContain(allowed);
      }
    });
  });
});