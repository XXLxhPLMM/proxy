import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../helpers/source-scan.js";
import { AUDITED_EXECUTABLE_NAMES, EXPECTED_ZIPS, bundles, built, pkgVersion } from "./_zip-contents.js";

/**
 * 闭集里的两个例外与收敛那一档：产物表 ↔ 判据闭集 ↔ zip 布局三方对表
 *
 * @description 与 `scan` / `manifest` / `package-dist-source` 是同一条通道的四档，
 * 主题级不变量归本目录 `AGENTS.md`。
 */

describe("standalone zip 内容护栏（build:pkg 发行物）", () => {
  describe.skipIf(!built)("1 零命中：zip 清单里不许出现的形状", () => {
    it("cfg/users.json 与 cfg/acl.json 是空骨架（闭集里的两个例外也不许夹带真实数据）", () => {
      for (const b of bundles) {
        const users = b.archive.bytes("cfg/users.json").toString("utf8");
        expect(users, `${b.file} 的 cfg/users.json 不是空数组`).toBe("[]\n");

        const acl = JSON.parse(b.archive.bytes("cfg/acl.json").toString("utf8")) as unknown;
        // 收**数组本身**而不是数组元素：空名单的元素集恒为空，判据落到元素上就永远验不到东西
        const lists: unknown[] = [];
        const walk = (node: unknown): void => {
          if (Array.isArray(node)) lists.push(node);
          else if (node && typeof node === "object") Object.values(node).forEach(walk);
        };
        walk(acl);
        expect(lists.length, `${b.file} 的 cfg/acl.json 结构里一个名单都没有`).toBeGreaterThan(0);
        expect(
          lists.every((v) => (v as unknown[]).length === 0),
          `${b.file} 的 cfg/acl.json 里有非空名单`,
        ).toBe(true);
      }
    });
  });

  describe("收敛：产物表 ↔ 本档闭集 ↔ zip 布局（任一侧单独改动都会红）", () => {
    // 仓外模块只能用相对 specifier 引（`REPO_ROOT` 拼出来的绝对路径在 ESM import 里不可用），
    // 层数是 `tests/unit/packaging/zip/` → 仓根的 4 级。
    it("pkg-binaries.mjs 产出的文件名集合 == 本档 AUDITED_EXECUTABLE_NAMES", async () => {
      const { BINARIES } = await import("../../../../scripts/pkg-binaries.mjs");
      const produced = [...new Set(BINARIES.map((b) => b.file))].sort();
      expect(produced, "产物表与 zip 判据的可执行文件闭集漂了").toEqual(
        [...AUDITED_EXECUTABLE_NAMES].sort(),
      );
    });

    it("pkg-binaries.mjs 的每个入口在 dist 下真的存在（表不是纸面的）", async () => {
      const { ENTRIES } = await import("../../../../scripts/pkg-binaries.mjs");
      for (const { entry } of ENTRIES) {
        expect(fs.existsSync(path.join(REPO_ROOT, entry)), `${entry} 不存在：pkg 会拿它当入口`).toBe(
          true,
        );
      }
    });

    it("每个入口都对应一个已发布的 bin 名（入口与 bin 不会各走各的）", async () => {
      const { ENTRIES } = await import("../../../../scripts/pkg-binaries.mjs");
      const pkgJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
        bin: Record<string, string>;
      };
      for (const { bin, entry } of ENTRIES) {
        expect(pkgJson.bin[bin], `bin.${bin} 没有指向 ${entry}`).toBe(entry);
      }
    });

    it("EXPECTED_ZIPS 的三个二进制标签 == 产物表的平台标签（zip 清单不会少一个平台）", async () => {
      const { BINARY_ZIPS } = await import("../../../../scripts/pkg-binaries.mjs");
      const fromTable = BINARY_ZIPS.map((z) => `proxy-v${pkgVersion}-${z.label}.zip`).sort();
      const fromTest = EXPECTED_ZIPS.filter((z) => !z.includes("node16") && !z.includes("node22")).sort();
      expect(fromTest).toEqual(fromTable);
    });
  });
});