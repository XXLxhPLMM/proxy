import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../helpers/source-scan.js";
import {
  AUDITED_EXECUTABLE_NAMES,
  AUDITED_PKI_FILES,
  AUDITED_VENDOR_PREFIX,
  built,
  bundles,
  stamp,
} from "./_zip-contents.js";

/**
 * zip 清单这一档：降级面可见 + 判据自检 + 清单零命中（含 `keys/` 的逐字节同一性）
 *
 * @description 与 `payload` / `manifest` / `package-dist-source` 是同一条通道的四档，
 * 主题级不变量（`keys/` 为什么收私钥、双标签约定、降级面）归本目录 `AGENTS.md`。
 */

// ── 判据 ──

/** 发行 zip 允许出现的顶层条目（闭集：新增顶层必须红，逼人写清它为什么可以分发） */
const AUDITED_TOP_LEVEL = new Set([
  ".env.example",
  "README.en.md",
  "README.zh-CN.md",
  "USAGE.en.md",
  "USAGE.zh-CN.md",
  "app.js",
  // Node 包这一侧的另外一个入口（`package-dist.mjs:ADMIN_CLI_FILE`）。
  // ⚠️ `proxy-cli.js` 曾长期不在这个闭集里，而 `package-dist.mjs` 一直在往每个 Node zip 里装它
  // —— 两处对不上却谁都没红：`dist/` 整个 gitignore，本目录在没跑过 `build:pkg` 的工作树上是零产物
  // `skipIf` 降级，真清单那几档**从来没跑过**。即「闸门从未被触发」，不是「闸门通过」。
  //
  // 控制面**不在**这个闭集里，因为它是 `app.js` 的一部分而不是另一个入口：它与数据面同进程
  // （`MANAGER_ENABLED=true` 时随 `proxy` 起来），故 `bin` 只有两个名字，三条分发通道对称。
  "proxy-cli.js",
  "package.json",
  "cfg/",
  "keys/",
  "node_modules/",
]);

/** 平台可执行文件名（`AUDITED_EXECUTABLE_NAMES` 那 6 个；其余名字一律不许出现在顶层） */
const AUDITED_EXECUTABLE = (p: string): boolean => AUDITED_EXECUTABLE_NAMES.has(p);

/**
 * `cfg/` 下允许出现的全部条目（闭集）
 *
 * @description
 * 两个 `.example` 是模板；`users.json` / `acl.json` 首次启动要读到，缺一个就 abort，
 * 故它们**必须**在 zip 里（内容另由零命中档的「空骨架」判据锁死）。
 * 写成整个 `cfg/` 的闭集而不是「只禁 `.json`」：账本的缺省落点 `QUOTA_USAGE_DIR=cfg/usage`
 * 产出的是 `usage.jsonl` / `usage.db`，**不匹配任何扩展名黑名单** —— 目录维度才是它们的形状。
 */
const AUDITED_CFG = new Set([
  "cfg/users.json.example",
  "cfg/acl.json.example",
  "cfg/users.json",
  "cfg/acl.json",
]);

/** 路径段是否等于日志目录名，命中即运行期产物 */
const isLogSegment = (p: string): boolean =>
  p.split("/").some((seg) => seg === "log" || seg === "logs");

/** `.env.*` 里除 `.env.example` 以外的一切（模板之外的都是开发者本机状态） */
const isNonExampleEnv = (p: string): boolean => {
  const name = p.slice(p.lastIndexOf("/") + 1);
  return (name.startsWith(".env.") || name === ".env") && name !== ".env.example";
};

/** 证书与私钥材料：公开证书与私钥在这里**不作区分** —— 判据只管「出现在哪儿」，不管是不是公开的 */
const isCertOrKeyMaterial = (p: string): boolean => /\.(key|srl|pem|p12|pfx|crt|cer)$/i.test(p);

/** 源码 / 构建脚本 / 测试目录一律不分发 */
const isSourceTree = (p: string): boolean => /(^|\/)(src|scripts|tests)\//.test(p);

/**
 * zip 内路径的负向判据，**逐条**独立可读（失败时直接指出是哪一条）
 *
 * @description
 * `keys/` 下的证书私钥**豁免扩展名判据**（那是有意分发的，见文件头），改由两条闭集判据接管：
 * 名字必须在 `AUDITED_PKI_FILES` 里，且（内容判据见零命中档的第二条）必须与仓库同名文件逐字节相同。
 * @param p zip 内的相对路径（`/` 分隔）
 * @returns 命中的规则名；零命中返回 `null`
 */
function entryVerdict(p: string): string | null {
  if (isLogSegment(p)) return "log/logs 路径段（运行期日志目录）";
  if (isNonExampleEnv(p)) return "非 .example 的 .env.*（开发者本机状态，含明文凭证）";

  if (isCertOrKeyMaterial(p)) {
    // 证书/私钥只允许出现在 keys/ 之下；keys/ 之内则要闭集内的文件名
    if (!p.startsWith("keys/")) return "keys/ 之外的证书/私钥材料";
    if (!AUDITED_PKI_FILES.includes(p.slice("keys/".length))) {
      return "keys/ 下闭集外的文件（只许带那套已入库的自签测试 PKI）";
    }
  }

  if (p.startsWith("cfg/") && !AUDITED_CFG.has(p)) {
    return "cfg/ 下闭集外的文件（含密码/名单或运行期账本）";
  }

  if (isSourceTree(p)) return "src/ scripts/ tests/ 源码目录";

  if (p.startsWith("node_modules/") && !p.startsWith(AUDITED_VENDOR_PREFIX)) {
    return "node_modules 下闭集外的依赖";
  }

  const top = p.split("/")[0];
  const isDirEntry = p.endsWith("/");
  if (isDirEntry) return "目录条目（发行 zip 只收文件，不收目录占位）";
  if (
    !AUDITED_TOP_LEVEL.has(top) &&
    !AUDITED_TOP_LEVEL.has(`${top}/`) &&
    !AUDITED_EXECUTABLE(top)
  ) {
    return "闭集外的顶层条目";
  }

  return null;
}

/** 收集全部命中的规则 */
function verdictsOf(paths: readonly string[]): string[] {
  return paths.flatMap((p) => {
    const hit = entryVerdict(p);
    return hit ? [`${p} —— ${hit}`] : [];
  });
}

describe("standalone zip 内容护栏（build:pkg 发行物）", () => {
  describe("覆盖面（产物缺失时的降级面，必须看得见）", () => {
    it("报出本档此刻实际覆盖到哪一层 + 每个 zip 的条目数", () => {
      if (!built) {
        process.stderr.write(
          "zip 护栏：⚠️ 没有 build:pkg 的 stamp（node_modules/.cache/proxy-build-pkg.stamp 不存在）" +
            " → 从没跑过 pnpm build:pkg，第 1–4 档（真实 zip 清单）已跳过，" +
            "只剩静态不变式 + 判据自检；先跑 pnpm build:pkg 再看本档\n",
        );
      } else if (bundles.length === 0) {
        // 这个分支必须是**响**的：stamp 在（构建过）而 zip 全没了（`pnpm build` 清过 dist/），
        // 真断言会全跑并变红 —— 这一行是让人不必先看红字就知道成因。
        process.stderr.write(
          `zip 护栏：🔴 有 build:pkg 的 stamp（构建于 ${stamp?.at ?? "未记时刻"}）` +
            " 但 dist/ 下零个 proxy-v*.zip —— pnpm build 清空过 dist/，真断言会全部变红；" +
            "重跑 pnpm build:pkg\n",
        );
      } else {
        for (const b of bundles) {
          process.stderr.write(`zip 护栏：${b.file} —— ${b.archive.entries.length} 个条目\n`);
        }
      }

      expect(true).toBe(true);
    });

    it.skipIf(!built)("每个 zip 都能被解析成非空清单（空清单会让零命中恒真）", () => {
      expect(bundles.length).toBeGreaterThan(0);
      for (const b of bundles) {
        expect(b.archive.entries.length, `${b.file} 条目数为 0`).toBeGreaterThan(0);
      }
    });
  });

  describe("判据自检（防「探测器写坏了导致所有负向断言恒绿」）", () => {
    // 脏条目逐条对应今天真实存在的**危险形状**，不是凭空编的
    const dirtySamples = [
      "log/2026-09-23-15.jsonl",
      "log/usage.jsonl",
      ".env.development",
      ".env.production",
      ".env.local",
      "dist/.env.production",
      "server.key", // 私钥落在顶层
      "cfg/keys/ca.key", // 证书材料落在 keys/ 之外
      "keys/", // 目录占位条目
      "keys/prod.key", // keys/ 闭集外的新增私钥
      "keys/server.pem", // keys/ 闭集外的另一种私钥编码
      "cfg/usage/usage.db", // 运行期账本
      "cfg/usage/usage.jsonl", // 运行期账本
      "cfg/accounts.json", // cfg/ 闭集外的账号表
      "src/cli.ts",
      "scripts/package-dist.mjs",
      "tests/unit/zip-contents.test.ts",
      "node_modules/dotenv/lib/main.js",
      "extra-notes.md", // 闭集外的顶层
    ];

    it.each(dirtySamples)("能抓住 %s", (sample) => {
      expect(entryVerdict(sample)).not.toBeNull();
    });

    it("每条规则各被至少一个样本触发（没有写了却没人验的规则）", () => {
      const ruleNames = [
        "log/logs 路径段（运行期日志目录）",
        "非 .example 的 .env.*（开发者本机状态，含明文凭证）",
        "keys/ 之外的证书/私钥材料",
        "keys/ 下闭集外的文件（只许带那套已入库的自签测试 PKI）",
        "cfg/ 下闭集外的文件（含密码/名单或运行期账本）",
        "src/ scripts/ tests/ 源码目录",
        "node_modules 下闭集外的依赖",
        "目录条目（发行 zip 只收文件，不收目录占位）",
        "闭集外的顶层条目",
      ];
      const triggered = new Set(
        dirtySamples.map((s) => entryVerdict(s)).filter((v): v is string => v !== null),
      );
      for (const rule of ruleNames) {
        expect([...triggered].some((t) => t.endsWith(rule)), `规则从未被样本触发：${rule}`).toBe(true);
      }
    });

    it("合法样本零命中（判据没有宽到把正常产物也咬掉）", () => {
      const clean = [
        ".env.example",
        "README.zh-CN.md",
        "README.en.md",
        "USAGE.zh-CN.md",
        "USAGE.en.md",
        "app.js",
        "package.json",
        "proxy-win.exe",
        "proxy-linux",
        "proxy-macos",
        "proxy-cli-win.exe",
        "proxy-cli-linux",
        "proxy-cli-macos",
        "cfg/users.json.example",
        "cfg/acl.json.example",
        "cfg/users.json",
        "cfg/acl.json",
        "keys/ca.crt",
        "keys/ca.key",
        "keys/ca.srl",
        "keys/client.crt",
        "keys/client.key",
        "keys/server.crt",
        "keys/server.key",
        "node_modules/node-sqlite3-wasm/dist/node-sqlite3-wasm.js",
        "node_modules/node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm",
        "node_modules/node-sqlite3-wasm/package.json",
      ];
      expect(verdictsOf(clean)).toEqual([]);
    });

    it.skipIf(!built)("每个真实 zip 的名字零违规（判据自检之外，真清单也过同一套判据）", () => {
      for (const b of bundles) {
        expect(verdictsOf(b.archive.entries.map((e) => e.name)), b.file).toEqual([]);
      }
    });
  });

  describe.skipIf(!built)("1 零命中：zip 清单里不许出现的形状", () => {
    it("全部 zip 的条目名零违规", () => {
      for (const b of bundles) {
        expect(verdictsOf(b.archive.entries.map((e) => e.name)), b.file).toEqual([]);
      }
    });

    it("keys/ 条目逐条与仓库同名文件逐字节相同（抓「把正式证书掉进 keys/ 后静默分发」）", () => {
      // 这条是 `addDir` 无过滤递归的**唯一**兜底：`package-dist.mjs` 与 `build.mjs` 两处都不筛选，
      // 所以「谁进了 zip」这件事的真相源只能是**字节比对**。改动 build/package 两个脚本都绕不开它。
      for (const b of bundles) {
        const keyEntries = b.archive.entries.filter((e) => e.name.startsWith("keys/"));
        expect(keyEntries.length, `${b.file} 零个 keys/ 条目`).toBeGreaterThan(0);
        for (const e of keyEntries) {
          const onDisk = path.join(REPO_ROOT, "keys", e.name.slice("keys/".length));
          expect(fs.existsSync(onDisk), `${e.name} 在仓库 keys/ 里不存在：那是仓库外的东西，不许分发`).toBe(
            true,
          );
          expect(
            b.archive.bytes(e.name).equals(fs.readFileSync(onDisk)),
            `${b.file} 的 ${e.name} 与仓库 keys/ 下的同名文件内容不同`,
          ).toBe(true);
        }
      }
    });
  });
});