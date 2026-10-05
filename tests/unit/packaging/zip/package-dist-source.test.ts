import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, codeOnly } from "../../../helpers/source-scan.js";

/**
 * `package-dist.mjs` 源码面那一档（**不依赖打包产物**）：五个 `it` 全是「代码面」判定
 *
 * @description 与 `scan` / `payload` / `manifest` 是同一条通道的四档，
 * 主题级不变量归本目录 `AGENTS.md`。
 */

const packDistSource = codeOnly(
  fs.readFileSync(path.join(REPO_ROOT, "scripts", "package-dist.mjs"), "utf8"),
);
const buildSource = codeOnly(fs.readFileSync(path.join(REPO_ROOT, "build.mjs"), "utf8"));

describe("standalone zip 内容护栏（build:pkg 发行物）", () => {
  describe("3 静态不变式：package-dist.mjs 的源码面（不依赖打包产物）", () => {
    it("零 .env.development / .env.production / .env.local 的 addFile（只允许 .env.example）", () => {
      // 注释已被 codeOnly 剥掉 —— 这里点名的正是**代码面**：某个拷贝里带上这三个名字，
      // 就会把开发者本机的明文上游凭证分发出去
      expect(/development|production|local/.test(packDistSource)).toBe(false);
    });

    it("cfg 空骨架是无条件写入：addCommonAssets 里写 cfg/*.json 的两处零 existsSync 守卫", () => {
      // 与 `packaging/npm-pack/` 对 `build.mjs` 的同类断言同源：`!existsSync` 守卫保住的
      // 恰恰是它本要防的那份文件（`dist/cfg/users.json` 若曾被真实数据污染就永不刷新）
      const at = packDistSource.indexOf("function addCommonAssets(");
      expect(at).toBeGreaterThanOrEqual(0);
      const body = packDistSource.slice(at, packDistSource.indexOf("function addWasmDriver(", at));
      expect(body).toContain('Buffer.from("[]\\n"), "cfg/users.json"');
      expect(body).toContain('"cfg/acl.json"');
      expect(body).toMatch(/zip\.addBuffer\(/);
      // 守卫只允许出现在 envExample / cfgDir / keysDir 上，绝不落在 cfg/*.json 上
      const guards = [...body.matchAll(/existsSync\(([^)]*)\)/g)].map((m) => m[1]);
      expect(guards.length, "addCommonAssets 里零 existsSync 守卫，形状变了需复核").toBeGreaterThan(0);
      for (const guard of guards) {
        expect(guard).not.toContain("users.json");
        expect(guard).not.toContain("acl.json");
      }
    });

    it("addDir 的调用点闭集：只许那两个已审计目标 + addDir 自身的递归调用", () => {
      // `addDir` 是**无过滤递归**：给它一个仓库自有的目录，就等于把那个目录此刻的**全部**内容
      // 分发出去，而清单的真相源随即消失（这正是 keys/ 那条字节比对存在的原因）。
      // 闭集钉住调用点 ⇒ 新增一个 addDir 目标必须红，逼人显式复核那个目录里有什么。
      const audited = new Set([
        'addDir(zip, keysDir, "keys");',
        "addDir(zip, full, path.join(zipBase, f));",
        'addDir(zip, fs.realpathSync(pkgDir), path.join("node_modules", "node-sqlite3-wasm"));',
      ]);
      const found = packDistSource
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("addDir(") && line.endsWith(");"));
      expect(found.length, "零个 addDir 调用点，形状变了需复核").toBeGreaterThan(0);
      expect(found.filter((line) => !audited.has(line))).toEqual([]);
    });

    it("keys/ 仍走 addDir(zip, keysDir, \"keys\") 这个已审计形状", () => {
      // 一旦它被换成带扩展名过滤的循环，这条会红：那是**有意的收紧**，需要同步复核
      // readme 的目录树与 `.env.example` 的 TLS_KEY 缺省还成不成立，而不是默默生效
      expect(packDistSource).toContain('addDir(zip, keysDir, "keys");');
    });

    it("build.mjs 把仓库 keys/ 无过滤镜像进 dist/（故 zip 侧必须靠字节比对兜底）", () => {
      // 这是 zip 里 keys/ 条目的**上游**，且它同样是整目录镜像。断言「今天无 filter」，
      // 是在记录那条必须由 zip 判据兜住的理由；哪天加了 filter，这条会提醒人复核 dist/keys 的形状。
      const at = buildSource.indexOf("fs.cpSync(keysSrc, keysDest, {");
      expect(at).toBeGreaterThanOrEqual(0);
      const call = buildSource.slice(at, buildSource.indexOf("});", at));
      expect(call).toContain("recursive: true");
      expect(call, "keys 拷贝带了 filter，dist/keys 的形状变了，需复核 zip 侧判据").not.toContain(
        "filter",
      );
    });
  });
});