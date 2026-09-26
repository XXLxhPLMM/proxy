import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { codeOnly } from "../helpers/source-scan.js";

/**
 * 打包内容护栏（`npm pack` 真实 tarball 清单 + `files` 白名单不变式 + build.mjs 源码面）
 *
 * @description
 * **事故背景（v5.1.3，真实泄漏）**：`package.json` 的 `files` 曾是
 * `["lib", "dist", "README.md"]` —— 裸 `dist` 把 `dist/` 抽屉里的一切全发进了 tarball：
 * `.env.production`（**明文上游凭证**）、`log/*.jsonl`（真实流量日志，含真实目标主机名）、
 * `cfg/acl.json`（开发者真实名单）、`cfg/users.json`、`keys/{ca,client,server}.key` + `ca.srl`。
 * 根 `.npmignore` 当时**确实**有 `.env*` 与 `log/` 两条规则，但 npm 的规则是
 * **`files` 里的路径无法被 `.npmignore` 排除** → 对 `dist/` 一条都没拦住。
 * 两半根因都在 `build.mjs`：`dist/` 从不清空（只进不出的抽屉），且 `cfg/*.json` 骨架与
 * `.env.*` 拷贝都带 `!fs.existsSync` 守卫 —— **守卫保住的恰恰是它本要防的那份文件**。
 *
 * ## 本档的形态：真 dry-run，不是只读 `files` 字段
 * 判据是 `npm pack --dry-run --json` 吐出来的**真实 tarball 文件清单**（实测 ~4s，`--dry-run`
 * 只遍历不写盘，低于 15s 默认超时，故不做降级）。只断言 `files` 字段的话，「白名单收得太紧
 * 把包收空」「某个 glob 展开出意料之外的路径」这两类事故都看不见 —— 那是**弱化判据**。
 *
 * ## 三档分工
 * 1. **零命中**（核心）：tarball 清单里不得出现运行期产物 / 凭证 / 名单 / 私钥 / 源码目录。
 * 2. **正向**：`lib/index.js` + `lib/index.d.ts` + `dist/app.js` + 至少一个 `cfg/*.example`
 *    在清单里 —— 防「白名单收太紧把包收空」这个**反向**风险。
 * 3. **静态不变式**：`files` 零裸目录且 `bin` 仍被覆盖；`build.mjs` 构建前清空 `dist/`。
 *    这一档**不依赖任何构建产物**，所以在没跑过 `build:all` 的工作树上仍然有牙齿。
 *
 * ## 防假绿（本仓最贵的一课，见 `tests/AGENTS.md`）
 * 负向判据必须证明「它盯的东西今天真的存在」。两处做了自证：
 * - **判据自检**（`判据自检：每条负向规则都能抓住它要抓的形状`）：把探测器套在合成的脏路径上，
 *   逐条断言「它会红」。探测器写坏了（例如把 `log/` 段判据写错）时这一档立刻红，而不是让
 *   上面所有负向断言一起变成永远通过。
 * - **降级面显式报出**（`覆盖面` 档）：`lib/` 与 `dist/` 是 gitignored 的构建产物，缺失时
 *   第 2 档跳过（`tests/AGENTS.md` 对打包断言的既有约定），但本档会把「本档此刻只覆盖了
 *   静态不变式 + 判据自检」**打出来**，不静默假装全覆盖。
 *
 * ## 两条刻意的口径收窄（写明理由，别当成漏检）
 * - **`log` / `logs` 路径段只对 `lib/` 之外生效**：`lib/server/log/config-log.js` 是
 *   `src/server/log/config-log.ts` 的编译产物（`server/log/` 是**源码目录名**，不是日志目录）。
 *   `lib/` 整体是 `tsc` 从 `src/**` 产出的 `.js`/`.d.ts`，里面不可能长出运行期数据文件；
 *   真正会长大文件的是 `dist/`。故豁免**只**给 `lib/`，并且额外断言「所有带 log 段的路径
 *   必须都在 `lib/` 之下」，让豁免范围不能被悄悄放大。
 * - **`cfg/` 规则对全部路径生效**（不给 `lib/` 豁免）：`lib/` 里不存在 `cfg` 路径段，
 *   规则写全范围更简单也更严。`lib/**` 那条 `src|scripts|tests` 规则不适用同理。
 *
 * ## 判据取自 `npm pack`，不是 `pnpm pack`（实测差异，2026-09 核实）
 * 两者清单**不等价**：`pnpm pack` 会无条件多带整个 **`readme/` 目录**（`readme/README.*.md`、
 * `readme/usage/*.md`、`readme/screenshot.png` 共 7 个文件约 119KB），`npm pack` 不带。
 * 故对着 `tar -tzf` 看到的行数会比本档的 dry-run 多几行 `readme/`——**那不是漏判**。
 * 两者对 `files` 的尊重是一致的（干净实验：两个 packer 都排除了 `src/`，都纳入了白名单条目）。
 * `readme/**` 不含任何被禁形状（无 log 段 / 非 example 的 env / 私钥 / cfg json / 源码目录），
 * 因此本档的每一条结论对 `pnpm pack` 同样成立；本档不额外跑 `pnpm pack` 是因为它不能
 * `--dry-run`、会真写一个 tarball（`--pack-destination` 也一样），换不到新的牙齿。
 */

const ROOT = path.resolve(__dirname, "..", "..");
const buildSource = codeOnly(fs.readFileSync(path.join(ROOT, "build.mjs"), "utf8"));

// ── 判据（被上面那份文件头逐条解释；探测器本身也受「判据自检」那一档监督） ──

/** 路径段是否等于日志目录名（`log` / `logs`），命中即运行期产物 */
const isLogSegment = (p: string): boolean => p.split("/").some((seg) => seg === "log" || seg === "logs");

/** `.env.*` 里除 `.env.example` 以外的一切（模板之外的都是开发者本机状态） */
const isNonExampleEnv = (p: string): boolean => {
  const name = p.slice(p.lastIndexOf("/") + 1);
  return name.startsWith(".env.") && name !== ".env.example";
};

/** 私钥与证书序列号：任何形态都不许进包 */
const isKeyMaterial = (p: string): boolean => /\.(key|srl|pem|p12|pfx)$/i.test(p);

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

/**
 * 把一条 `files` glob 编成正则，供「bin / main / types 是否被覆盖」用
 *
 * @description 单趟扫描（不用占位符，避免把控制字符写进正则触发 `no-control-regex`）：
 * 双星斜杠（跨任意层目录，含零层）、单星与问号（不跨 `/`），其余正则元字符一律转义。
 * 末尾的裸双星（`lib/**`）按「任意字符含 `/`」处理。
 * ⚠️ 写这条函数的注释时**别把双星斜杠原样写进块注释里** —— 它就是块注释的终止符。
 * @param glob `files` 数组里的一条模式
 * @returns 匹配该模式的路径正则
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          out += "(?:[^/]+/)*";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }

      continue;
    }

    if (ch === "?") {
      out += "[^/]";
      continue;
    }

    out += ch.replace(/[.+^${}()|[\]\\]/g, (m) => `\\${m}`);
  }

  return new RegExp(`^${out}$`);
}

const rawPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as Record<
  string,
  unknown
>;
/** `files` 白名单条目（逐条过滤成 string，不给「数组里混进别的东西」留机会） */
const filesEntries: string[] = Array.isArray(rawPkg.files)
  ? rawPkg.files.filter((e): e is string => typeof e === "string")
  : [];
/** `bin` 的每个入口目标（CLI 装上后 bin 指向的文件必须真的在包里） */
const binEntries: string[] =
  rawPkg.bin !== null && typeof rawPkg.bin === "object"
    ? Object.values(rawPkg.bin as Record<string, unknown>).filter(
        (v): v is string => typeof v === "string",
      )
    : [];

// ── 真 dry-run：整个文件只跑一次 ──

interface PackResult {
  files: string[];
  elapsedMs: number;
}

let cached: PackResult | null = null;

/**
 * `npm pack --dry-run --json` 的真实清单
 *
 * @description 走 shell 是为了跨平台（Windows 上 `npm` 是 `.cmd` shim，Node ≥18 的
 * `execFile` 不带 `shell` 会直接 EINVAL）。**stderr 必须丢弃**：npm 会往那里打
 * 「Unknown user config …」一类 warning，混进 stdout 就 JSON.parse 失败。
 * update_notifier 关掉，免得它在 CI 里做无谓的网络尝试。
 */
function packManifest(): PackResult {
  if (cached) return cached;
  const started = Date.now();
  const stdout = execSync("npm pack --dry-run --json", {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  const parsed = JSON.parse(stdout) as Array<{ files?: Array<{ path: string }> }>;
  const files = (parsed[0]?.files ?? []).map((f) => f.path);
  if (files.length === 0) throw new Error("npm pack --dry-run 没给出任何文件，判据会恒真");
  cached = { files, elapsedMs: Date.now() - started };
  return cached;
}

const hasLib = fs.existsSync(path.join(ROOT, "lib", "index.js"));
const hasDist = fs.existsSync(path.join(ROOT, "dist", "app.js"));
const built = hasLib && hasDist;

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
      const distPaths = packManifest().files.filter((p) => p.startsWith("dist/"));
      const bad = distPaths.filter((p) => !p.endsWith(".example") && p !== "dist/app.js");
      expect(bad).toEqual([]);
    });
  });

  describe.skipIf(!built)("2 正向：包不许被收空", () => {
    it("库入口在清单里（main + types）", () => {
      const { files } = packManifest();
      expect(files).toContain("lib/index.js");
      expect(files).toContain("lib/index.d.ts");
    });

    it("CLI 入口在清单里（bin 指向 dist/app.js，丢了就等于没装 CLI）", () => {
      expect(packManifest().files).toContain("dist/app.js");
    });

    it("配置模板在清单里（至少一个 cfg/*.example）", () => {
      const templates = packManifest().files.filter((p) => /^dist\/cfg\/.*\.example$/.test(p));
      expect(templates.length).toBeGreaterThan(0);
    });

    it("清单规模合理（防「白名单写错路径」把包收成三四个文件）", () => {
      expect(packManifest().files.length).toBeGreaterThan(50);
    });
  });

  describe("3 静态不变式：files 白名单本身（不依赖构建产物）", () => {
    it("files 数组存在且非空", () => {
      expect(filesEntries.length).toBeGreaterThan(0);
    });

    it("零裸目录：每个条目要么带通配，要么是一个确切的文件路径", () => {
      // 判据用**文件系统事实**而不是「看起来像不像路径」：`dist` / `lib` 这种名字会解析成
      // 一个目录，于是红；写错成 `dist/app.jsx`（文件不存在）在没构建的工作树上也判它是
      // 文件路径 —— 那种错由第 2 档的正向断言负责，不在这里越权假红。
      const bareDirectories = filesEntries.filter((entry) => {
        if (/[*?]/.test(entry)) return false;
        return fs.existsSync(path.join(ROOT, entry)) && fs.lstatSync(path.join(ROOT, entry)).isDirectory();
      });
      expect(bareDirectories).toEqual([]);
    });

    it("每条 entry 都不带尾斜杠（`dist/` 与 `dist` 同义，都会扫整棵树）", () => {
      expect(filesEntries.filter((e) => e.endsWith("/"))).toEqual([]);
    });

    it("白名单里零敏感名字（log / 私钥 / 非 example 的 env / 整目录 cfg）", () => {
      const suspicious = filesEntries.filter(
        (e) =>
          e.split("/").some((seg) => seg === "log" || seg === "logs" || seg === "keys") ||
          /(^|\/)(cfg|log|logs|keys)\/?$/.test(e) ||
          isKeyMaterial(e) ||
          isNonExampleEnv(e) ||
          /\.env$/.test(e),
      );
      expect(suspicious).toEqual([]);
    });

    it("bin 的每个入口都被 files 里一条非裸目录条目覆盖（CLI 装上必须真的有文件）", () => {
      // 裸目录 entry（`dist`）在 npm 眼里**确实**能覆盖 dist/app.js，但它本身已被上一条禁掉；
      // 这里只承认「带通配的窄模式」与「确切文件路径」两种覆盖方式，失败信息才不会误导人
      // 说「bin 没被覆盖」（实际是被一个非法条目覆盖的）。
      expect(binEntries.length).toBeGreaterThan(0);
      const matchers = filesEntries.map(globToRegExp);
      const uncovered = binEntries.filter((t) => !matchers.some((re) => re.test(t)));
      expect(uncovered).toEqual([]);
    });

    it("main / types 指向的文件都被 files 覆盖（库消费方必须能 require 到）", () => {
      const matchers = filesEntries.map(globToRegExp);
      for (const field of ["main", "types"] as const) {
        const target = rawPkg[field];
        if (typeof target !== "string") continue;
        expect(matchers.some((re) => re.test(target))).toBe(true);
      }
    });
  });

  describe("4 静态不变式：build.mjs 的三处根因（源码级，不依赖构建产物）", () => {
    it("构建前无条件清空 dist/（rmSync 恰好一处，且在 esbuild.build 之前）", () => {
      const wipes = [...buildSource.matchAll(/rmSync\(\s*distDir\s*,\s*\{[^}]*recursive:\s*true[^}]*force:\s*true/g)];
      expect(wipes).toHaveLength(1);
      const at = buildSource.indexOf(wipes[0][0]);
      const firstBuild = buildSource.indexOf("esbuild.build(");
      expect(firstBuild).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(firstBuild);
    });

    it("零 .env.production / .env.local 拷贝（只保留 assets 里那一个 .env.example）", () => {
      // 注释已被 codeOnly 剥掉 —— 这里点名的正是**代码面**：历史上那个
      // readdirSync + /^\.env\.(production|local|example)$/ 循环就是泄漏源
      expect(/(production|local)/.test(buildSource.replace(/\.env\.example/g, ""))).toBe(false);
      const exampleHits = buildSource.match(/\.env\.example/g) ?? [];
      expect(exampleHits).toHaveLength(1);
    });

    it("cfg 骨架是无条件覆写：写 users.json/acl.json 的块里零 existsSync 守卫", () => {
      // 锚点是**今天仍存在的形状**（cfgSrc 那个 if 的块体），不是某个可能已被删掉的符号名 ——
      // 锚在已删除符号上的负向断言会恒真，见 tests/AGENTS.md 的通用教训。
      const start = buildSource.indexOf("if (fs.existsSync(cfgSrc))");
      expect(start).toBeGreaterThanOrEqual(0);
      const body = buildSource.slice(start, buildSource.indexOf("process.exit(0);", start));
      expect(body).toContain("fs.writeFileSync(usersFile");
      expect(body).toContain("fs.writeFileSync(");
      expect(body).toContain("aclFile");
      expect(body).not.toContain("existsSync(usersFile)");
      expect(body).not.toContain("existsSync(aclFile)");
    });
  });
});
