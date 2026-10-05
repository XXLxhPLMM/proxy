/**
 * `core/forward/` **两轴目录的不变式**：文件清单逐字 + 两轴之间的依赖方向（单向）
 *
 * @description
 * 拆目录的收益不是「好看」，是**依赖方向变得可断言**（`channel/**` 只能朝 `upstream/**` 单向）。
 * 本档锁两件事：每条轴每个目录的**成员清单逐字**（含「不是空壳」）、两轴之间 import 扫描的
 * 依赖方向。三条决策的完整来由在 `channel/AGENTS.md`（本目录只有一档，故不建 `AGENTS.md`），
 * `dial.ts` 与连接器层那一侧的判据在 `upstream/AGENTS.md`。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { codeOnly, SRC_DIR } from "../../../helpers/source-scan.js";

/** `src/core/forward/` 的绝对路径（从 `SRC_DIR` 派生，层数只许出现在 helper 那一处） */
const FORWARD_DIR = path.join(SRC_DIR, "core", "forward");

/**
 * `forward/` 根上**只允许**有这一个**文件**（公共基类，刻意不搬进任何一轴）
 * @description 目录条目另列：根上恰好这两个子目录，一条轴一个。
 */
const ROOT_FILES = ["base.ts"];

/** `forward/` 根上的两个子目录（一条轴一个，不许有第三种分组维度） */
const ROOT_DIRS = ["channel", "upstream"];

/** `forward/channel/` 恰好这五个成员（四条入站通道 + 它们的握手读取器） */
const CHANNEL_MEMBERS = ["http.ts", "socks-reader.ts", "socks.ts", "tunnel.ts", "upgrade.ts"];

/** `forward/upstream/` 恰好这两个成员（传输层 + 连接器层目录） */
const UPSTREAM_MEMBERS = ["connector", "dial.ts"];

/** `forward/upstream/connector/` 恰好这八个成员（七个职责模块 + 它的 barrel） */
const CONNECTOR_MEMBERS = [
  "direct.ts",
  "http-connect.ts",
  "index.ts",
  "registry.ts",
  "socks-upstream.ts",
  "socks4.ts",
  "socks5.ts",
  "types.ts",
];

/** 列某目录下的条目名（只取 `.ts` 与目录，排序后逐字比对） */
function membersOf(...segments: string[]): string[] {
  return fs
    .readdirSync(path.join(FORWARD_DIR, ...segments), { withFileTypes: true })
    .map((e) => e.name)
    .filter((n) => n.endsWith(".ts") || !n.includes("."))
    .sort();
}

/**
 * 列某目录下**只有文件**（不含子目录）的条目名
 *
 * 只取 `.ts`：这条护栏锁的是**模块布局**（哪些实现文件在哪个目录），`.md` 不是模块。
 * 目录里可以放 `AGENTS.md` 路径说明而不影响布局断言 —— 与 `membersOf` 同一口径。
 */
function filesOf(...segments: string[]): string[] {
  return fs
    .readdirSync(path.join(FORWARD_DIR, ...segments), { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => n.endsWith(".ts"))
    .sort();
}

/** 列某目录下**只有子目录**的条目名 */
function dirsOf(...segments: string[]): string[] {
  return fs
    .readdirSync(path.join(FORWARD_DIR, ...segments), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** 某目录下全部 `.ts` 的绝对路径（递归） */
function allSources(...segments: string[]): string[] {
  const root = path.join(FORWARD_DIR, ...segments);
  const out: string[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(path.join(entry.parentPath ?? root, entry.name));
    }
  }

  return out.sort();
}

/** 相对 `src/core/forward/` 的可读路径（失败输出里要能一眼看出是哪个文件） */
function rel(abs: string): string {
  return path.relative(path.join(FORWARD_DIR, ".."), abs).split(path.sep).join("/");
}

describe("core/forward：两轴目录的不变式（文件清单逐字）", () => {
  it("forward/ 根上只有 base.ts 一个文件（横跨两轴的公共基类，刻意不进任何一轴）", () => {
    expect(filesOf()).toEqual(ROOT_FILES);
  });

  it("forward/ 根上恰好两个子目录，一条轴一个（不许出现第三种分组维度）", () => {
    expect(dirsOf()).toEqual(ROOT_DIRS);
  });

  it("channel/ 恰好四条入站通道 + 它们的握手读取器（无多余文件、无遗漏、无子目录）", () => {
    expect(filesOf("channel")).toEqual(CHANNEL_MEMBERS);
    expect(dirsOf("channel"), "channel/ 是扁平的：入站通道之间没有子分组").toEqual([]);
  });

  it("upstream/ 恰好「传输层一个文件 + 连接器层一个目录」两个成员", () => {
    expect(filesOf("upstream")).toEqual(["dial.ts"]);
    expect(dirsOf("upstream")).toEqual(["connector"]);
    // 两条断言的合并形态（顺序按 files+dirs 排）
    expect(membersOf("upstream")).toEqual(UPSTREAM_MEMBERS);
  });

  it("upstream/connector/ 的七个职责模块 + 它的 barrel 齐全（层出口是唯一对外引用面）", () => {
    expect(filesOf("upstream", "connector")).toEqual(CONNECTOR_MEMBERS);
    expect(dirsOf("upstream", "connector"), "连接器层是扁平的：七个模块平铺").toEqual([]);
  });

  it("目录不是空壳：每条轴的每个文件都真的有代码（防「建了目录没搬东西」）", () => {
    for (const file of allSources()) {
      expect(codeOnly(fs.readFileSync(file, "utf8")).length, `${rel(file)} 是空文件？`).toBeGreaterThan(
        500,
      );
    }
  });
});

describe("core/forward：两轴之间的依赖方向（单向，反向禁止）", () => {
  /**
   * import 语句（去掉注释后的代码面）
   * @description 只取 `from "..."` 那一段：判据是「引的是哪个模块」，不是「怎么用」。
   */
  function importsOf(file: string): string[] {
    const code = codeOnly(fs.readFileSync(file, "utf8"));

    return [...code.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]);
  }

  it("channel/** 只引同轴的兄弟与 @/core/** ，绝不引别的入站通道实现", () => {
    for (const file of allSources("channel")) {
      for (const spec of importsOf(file)) {
        // 允许：node: 内置 / 跨目录的 @ 别名（配置、core 兄弟、utils、upstream 轴）
        // 禁止：./ 之外的 forward 平铺路径，以及任何指向另一条通道实现的深路径
        expect(
          spec,
          `${rel(file)} 引了「${spec}」：入站通道之间不许互相实现（那会让四条通道长成互相依赖的网）`,
        ).not.toMatch(/@\/core\/forward\/(?!base\.js$|upstream\/)/);
      }
    }
  });

  it("channel/** 引 upstream 轴时只能走 @/core/forward/upstream/**（跨目录用别名）", () => {
    for (const file of allSources("channel")) {
      for (const spec of importsOf(file)) {
        if (!spec.startsWith("@/core/forward/upstream/")) {
          continue;
        }
        expect(
          spec,
          `${rel(file)} 跨目录引上游必须用 @/ 别名：相对路径会让人误以为通道与上游是同层`,
        ).toMatch(/^@\/core\/forward\/upstream\//);
      }
    }
  });

  it("upstream/** 绝不引 channel/**（依赖必须单向：入站 → 上游，反向即目录级环）", () => {
    for (const file of allSources("upstream")) {
      for (const spec of importsOf(file)) {
        expect(
          spec,
          `${rel(file)} 引了「${spec}」：上游对接轴不许反向依赖入站通道（那会让「怎么到达 dest」`
            + "变成取决于谁在请求它）",
        ).not.toMatch(/channel\//);
      }
    }
  });

  it("base.ts 跨两轴引的都是 @/ 别名（它横跨两轴，用相对路径会读错归属）", () => {
    for (const spec of importsOf(path.join(FORWARD_DIR, "base.ts"))) {
      if (spec.startsWith("node:") || spec.startsWith("@/config") || spec.startsWith("@/utils") || spec.startsWith("@/datasource")) {
        continue;
      }
      expect(
        spec,
        "base.ts 引 forward 内部模块必须用 @/core/forward/...（同目录相对路径只对 channel/ 内部成立）",
      ).toMatch(/^@\/core\//);
    }
  });
});
