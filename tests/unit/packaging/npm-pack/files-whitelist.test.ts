import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, codeOnly } from "../../../helpers/source-scan.js";
import { built, isKeyMaterial, isNonExampleEnv, packManifest } from "./_pack-contents.js";

/**
 * 白名单与构建脚本这一档：正向（包不许被收空）+ `files` 静态不变式 + `build.mjs` 源码面
 *
 * @description 与 `scan.test.ts` 是同一条通道的两半，主题级不变量归本目录 `AGENTS.md`。
 * 这一档的一半**不依赖任何构建产物**，所以在没跑过 `build:all` 的工作树上仍然有牙齿。
 */

const buildSource = codeOnly(fs.readFileSync(path.join(REPO_ROOT, "build.mjs"), "utf8"));

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

const rawPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as Record<
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

describe("npm pack 内容护栏", () => {
  describe.skipIf(!built)("2 正向：包不许被收空", () => {
    it("库入口在清单里（main + types）", () => {
      const { files } = packManifest();
      expect(files).toContain("lib/index.js");
      expect(files).toContain("lib/index.d.ts");
    });

    it("CLI 入口在清单里（bin 指向 dist/app.js，丢了就等于没装 CLI）", () => {
      expect(packManifest().files).toContain("dist/app.js");
    });

    it("**build.mjs 的 entryPoints 全部声明**（漏一个 = 那个 bin 指向不存在的文件）", () => {
      // 漏掉一个入口**不会**让构建失败（esbuild 只构建表里给的那几个），而是让 `bin` 指向
      // 一个不存在的文件 → `npm i` 成功而命令直接 `MODULE_NOT_FOUND`。故判据是「表里的每个
      // 产物都真的在 tarball 清单里」，它同时覆盖「加了 bin 忘了加进 build.mjs」那个方向。
      const declared = [...buildSource.matchAll(/out:\s*"([^"]+\.js)"/g)].map((m) => `dist/${m[1]}`);
      expect(declared.length, "从 build.mjs 抠不到任何入口（源码形状变了，需复核）").toBeGreaterThan(0);
      for (const out of declared) {
        expect(packManifest().files, `${out} 声明为入口却不在 tarball 清单里`).toContain(out);
      }
    });

    it("**bin 的每个入口**都在清单里（逐条点名，不写死某一个）", () => {
      // 这条是「加了一个 bin 却忘了加进 `files`」的唯一闸门：那种错的外部表现是
      // `npm i` 成功、命令却 `MODULE_NOT_FOUND`，而 tarball 看起来完全正常。
      // 逐条点名而不是比对数组 —— 少一个 bin 时本断言必须**红**。
      expect(binEntries.length).toBeGreaterThan(0);
      for (const bin of binEntries) {
        expect(packManifest().files, `bin 入口 ${bin} 必须在 tarball 清单里`).toContain(bin);
      }
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
        return (
          fs.existsSync(path.join(REPO_ROOT, entry)) &&
          fs.lstatSync(path.join(REPO_ROOT, entry)).isDirectory()
        );
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

    it("一个文件只对应一个 bin 名（`bin` 的各个目标互不相同）", () => {
      // 同一个产物挂两个 bin 名（别名）不是「多给一个入口」，它只在 `node_modules/.bin` 里多出
      // 一个同物，而**更贵的代价是文档与脚本会各自指向不同名字然后漂掉**：本仓真出现过
      // `dist/app.js` 同时叫 `proxy` 与 `b-hole-proxy`，三份 README 各写一种，用户按文档敲的名字
      // 与 CI 装出来的名字对不上，而两边都「能跑」，于是没人发现。
      // 判据是**目标互异**（`bin` 的键是命令名、值是文件），零命中即通过。
      const names = Object.keys(rawPkg.bin as Record<string, string>);
      const seen = new Map<string, string>();
      const duplicates: string[] = [];
      for (const name of names) {
        const target = (rawPkg.bin as Record<string, string>)[name]!;
        const first = seen.get(target);
        if (first !== undefined) {
          duplicates.push(`${target} 同时挂在 ${first} 与 ${name}`);
          continue;
        }
        seen.set(target, name);
      }
      expect(duplicates, "同一个文件挂多个 bin 名 = 别名，删掉多余那个").toEqual([]);
      // 防假绿：判据不能因为「bin 是空对象」而恒真
      expect(names.length).toBeGreaterThan(1);
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
      const wipes = [
        ...buildSource.matchAll(
          /rmSync\(\s*distDir\s*,\s*\{[^}]*recursive:\s*true[^}]*force:\s*true/g,
        ),
      ];
      expect(wipes).toHaveLength(1);
      const at = buildSource.indexOf(wipes[0][0]);
      const firstBuild = buildSource.indexOf("esbuild.build(");
      expect(firstBuild).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(firstBuild);
    });

    it("零 .env.production / .env.local 拷贝（只保留 assets 里那一个 .env.example）", () => {
      // 注释已被 codeOnly 剥掉 —— 这里点名的正是**代码面**：某个 copy 循环里正则含
      // `production|local` 就会把运行期产物重新打进 dist/
      expect(/(production|local)/.test(buildSource.replace(/\.env\.example/g, ""))).toBe(false);
      const exampleHits = buildSource.match(/\.env\.example/g) ?? [];
      expect(exampleHits).toHaveLength(1);
    });

    it("cfg 骨架是无条件覆写：写 users.json/acl.json 的块里零 existsSync 守卫", () => {
      // 锚点是**今天仍存在的形状**（cfgSrc 那个 if 的块体），不是某个可能已被删掉的符号名 ——
      // 锚在已删除符号上的负向断言会恒真（通用规则见根 `AGENTS.md`「写护栏时」）。
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