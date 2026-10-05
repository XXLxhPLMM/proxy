import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../helpers/source-scan.js";
import {
  AUDITED_PKI_FILES,
  AUDITED_VENDOR_PREFIX,
  EXPECTED_ZIPS,
  built,
  bundles,
  type ZipBundle,
  type ZipEntry,
} from "./_zip-contents.js";

/**
 * 正向那一档：`pkg` 块逐项形状 + 五个 zip 齐全 + 必带文件（主题级不变量归本目录 `AGENTS.md`）
 */

/**
 * `dist/` 下此刻的 `proxy-v*.zip` 文件名
 *
 * @description **刻意不从 `bundles` 派生**：派生会让「五个 zip 齐全」那条断言变成
 * 「`EXPECTED_ZIPS` 与它自己相等」——恒真。这里重列一遍目录，判据才有牙齿。
 */
const zipFiles = fs.existsSync(path.join(REPO_ROOT, "dist"))
  ? fs
      .readdirSync(path.join(REPO_ROOT, "dist"))
      .filter((f) => f.startsWith("proxy-v") && f.endsWith(".zip"))
      .sort()
  : [];

/** 仓库 `keys/` 的文件名清单（zip 里 keys/ 条目的上游） */
const repoKeyFiles = fs.existsSync(path.join(REPO_ROOT, "keys"))
  ? fs.readdirSync(path.join(REPO_ROOT, "keys")).sort()
  : [];

/** 二进制 zip 的标签后缀 → zip 内可执行文件名（`binaryMap` 那张表的内容） */
const BINARY_ZIP_EXECUTABLE: Array<[string, string]> = [
  ["-win-x64.zip", "proxy-win.exe"],
  ["-linux-x64.zip", "proxy-linux"],
  ["-macos-x64.zip", "proxy-macos"],
];

describe("standalone zip 内容护栏（build:pkg 发行物）", () => {
  /**
   * `package.json` 的 `pkg` 块：**每一项都必须是字符串**
   *
   * @description **锁的不变量**：`pkg.scripts` / `pkg.assets` 是 glob 列表，pkg 的解析器逐项做
   * `typeof p !== 'string'` 就抛 `Config items must be strings`（`walker.js:upon`），故任何**对象**
   * 形式（`{path, name}`）都是非法配置。**判据锚在 `typeof` 上而不是符号名**：把 `pkg` 块整个删掉时
   * 本档依然绿（那是**对**的形状），而把任何一项换成对象立刻红 —— 故它不会变成「点名一个已删除符号」
   * 的恒真断言。
   *
   * ⚠️ **三道该拦住它的机制曾同时失效过一次**（成因见 `./AGENTS.md` 同名一节）：成因是**降级链**
   * （catch 吞掉 / CI 不跑测试 / 零产物时 `skipIf` 降级），不是这条判据本身。
   */
  describe("package.json 的 pkg 块：每项必须是字符串（对象形式让 pkg 每次抛错）", () => {
    const pkgBlock = (): Record<string, unknown> | undefined => {
      const j = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
        pkg?: Record<string, unknown>;
      };
      return j.pkg;
    };

    /**
     * 与 pkg 解析器同一条判据（`typeof p !== 'string'` 抛错）
     *
     * @description
     * **遍历块里每一个值，不只 `scripts` / `assets`**：pkg 会把 `targets` 也送进同一个
     * 解析器，而一个 `{ win: "..." }` 形状的 `targets` 同样让 pkg 抛错。自检档里那条
     * `{ targets: { win: "node22-win-x64" } }` 就是冲这个来的 —— 只查两个已知键的写法会把它
     * 判成干净，那道闸门等于只锁了门把手没锁门。
     */
    const nonStringItems = (block: Record<string, unknown> | undefined): string[] => {
      if (block === undefined) return [];
      return Object.entries(block).flatMap(([key, value]) => {
        const items = Array.isArray(value) ? value : [value];
        return items.flatMap((item, i) => (typeof item === "string" ? [] : [`${key}[${i}]`]));
      });
    };

    it("今天没有非字符串项", () => {
      expect(nonStringItems(pkgBlock())).toEqual([]);
    });

    it("判据自检：把一项换成对象它就会红（探测器没写坏）", () => {
      // 防「探测器恒绿」：这档断言的是 `typeof` 那一条判据本身对它应该报的形状确实报。
      const dirty: Record<string, unknown>[] = [
        { scripts: [{ path: "dist/app.js", name: "proxy" }] },
        { assets: [{ path: "x" }] },
        { targets: { win: "node22-win-x64" } },
        { scripts: ["ok", 42] },
      ];
      for (const block of dirty) {
        expect(nonStringItems(block), `${JSON.stringify(block)} 应当被判为非字符串项`).not.toEqual([]);
      }
      expect(nonStringItems({ scripts: ["dist/app.js"], assets: [".env.example"] })).toEqual([]);
    });
  });

  describe.skipIf(!built)("2 正向：包不许被收空 / 命名约定不许被悄悄改掉", () => {
    it("五个发行 zip 齐全（build:pkg 的五个目标一个都不能少）", () => {
      expect(zipFiles).toEqual([...EXPECTED_ZIPS].sort());
    });

    it(".env.example 在每个 zip 里", () => {
      for (const b of bundles) {
        expect(b.archive.entries.map((e) => e.name), b.file).toContain(".env.example");
      }
    });

    it(".env.example 里带齐五个驱动键 + 账本目录键（改名或拼错即红）", () => {
      const required = [
        "AUTH_USERS_DRIVER=",
        "AUTH_USERS_DB=",
        "ACL_DRIVER=",
        "QUOTA_USAGE_DRIVER=",
        "QUOTA_USAGE_DIR=cfg/usage",
      ];
      for (const b of bundles) {
        const text = b.archive.bytes(".env.example").toString("utf8");
        for (const key of required) {
          expect(text, `${b.file} 的 .env.example 缺 ${key}`).toContain(key);
        }
      }
    });

    it("keys/ 条目闭集：不多不少那套已入库的自签测试 PKI", () => {
      for (const b of bundles) {
        const names = b.archive.entries
          .filter((e) => e.name.startsWith("keys/"))
          .map((e) => e.name.slice("keys/".length))
          .sort();
        expect(names, b.file).toEqual([...AUDITED_PKI_FILES].sort());
      }
    });

    it("仓库 keys/ 自身也钉在这个闭集上（往里丢正式证书会在 zip 之外先红）", () => {
      // 这是 zip 判据的**上游**：`build.mjs` 无过滤地把仓库 keys/ 整目录镜像进 dist/keys/。
      // 上游多出的文件会一路走到每一个 zip，所以要在上游就钉住。
      expect(repoKeyFiles).toEqual([...AUDITED_PKI_FILES].sort());
    });

    it("二进制包带自己的可执行文件、Node 包带 app.js 与最小 package.json", () => {
      for (const b of bundles) {
        const names = b.archive.entries.map((e) => e.name);
        // 标签 → 可执行文件名的映射是 `binaryMap` 那张表的内容，按后缀取表项而不是从文件名里
        // 切字符串（`proxy-v5.2.0-…` 里第一个 `-` 在版本号上，切出来的标签是错的）
        const binary = BINARY_ZIP_EXECUTABLE.find(([suffix]) => b.file.endsWith(suffix));
        if (binary) {
          expect(names, `${b.file} 缺可执行文件 ${binary[1]}`).toContain(binary[1]);
        } else {
          expect(names, b.file).toContain("app.js");
          expect(names, b.file).toContain("package.json");
          expect(names, b.file).toContain(`${AUDITED_VENDOR_PREFIX}dist/node-sqlite3-wasm.wasm`);
        }
      }
    });

    it("Node 包带全两个入口（app.js + proxy-cli.js）", () => {
      // `bin` 的两个入口在 Node zip 上必须**全部可得**。少了任何一个，下载 zip 的用户与
      // `npm i` 的用户能力不同 —— 那是最小的「两处对不上」。
      for (const b of bundles) {
        if (BINARY_ZIP_EXECUTABLE.some(([suffix]) => b.file.endsWith(suffix))) continue;
        const names = b.archive.entries.map((e) => e.name);
        for (const entry of ["app.js", "proxy-cli.js"]) {
          expect(names, `${b.file} 缺入口 ${entry}`).toContain(entry);
        }
      }
    });

    it("**没有任何通道**再产出 `manager.js`（控制面已并入 app.js）", () => {
      // 反向档：钉住「控制面不是第三个入口」。它与数据面同进程，随 `app.js` 起来；哪天有人
      // 「补回」一个独立 manager 入口，就是把两份可能漂移的配置快照请回同一个部署里。
      for (const b of bundles) {
        const names = b.archive.entries.map((e) => e.name);
        expect(names, `${b.file} 不该有 manager.js（控制面已并入 app.js）`).not.toContain(
          "manager.js",
        );
      }
    });

    it("node16 与 node22 的 app.js 字节相同 —— 有意的双标签约定，不是异常", () => {
      const node16 = bundles.find((b) => b.file.endsWith("-node16.zip"));
      const node22 = bundles.find((b) => b.file.endsWith("-node22.zip"));
      expect(node16).toBeDefined();
      expect(node22).toBeDefined();
      if (!node16 || !node22) return;

      const pick = (b: ZipBundle): ZipEntry => {
        const e = b.archive.entries.find((x) => x.name === "app.js");
        if (!e) throw new Error(`${b.file} 里没有 app.js`);
        return e;
      };

      const a = pick(node16);
      const c = pick(node22);
      expect(a.size, "两个标签的 app.js 长度不同，双标签约定被破坏了").toBe(c.size);
      expect(a.crc, "两个标签的 app.js CRC 不同，双标签约定被破坏了").toBe(c.crc);
    });

    it("中英文 README 与使用指南齐全", () => {
      for (const b of bundles) {
        const names = b.archive.entries.map((e) => e.name);
        for (const doc of ["README.zh-CN.md", "README.en.md", "USAGE.zh-CN.md", "USAGE.en.md"]) {
          expect(names, `${b.file} 缺 ${doc}`).toContain(doc);
        }
      }
    });
  });
});