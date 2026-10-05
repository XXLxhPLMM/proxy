import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/unit/packaging/` 主题片
 *
 * @description
 * 归**管 `tests/unit/packaging/` 的 agent**维护。文件搬进子目录时 `file` 要逐条改成
 * 新路径 —— 旧路径留在原地会当场被判 stale（见 `../AGENTS.md`）。
 *
 * ⚠️ **本目录拆成 `npm-pack/` 与 `zip/` 六个档之后，本片仍然只有一条**：`e.name` 那两处模板
 * 字面量（`${e.name} 在仓库 keys/ 里不存在…` / `${b.file} 的 ${e.name} 与仓库…`）只落在
 * **`zip/scan.test.ts`** 一个档里，另三个 zip 档与两个 npm-pack 档**零公网字面量**
 * ⇒ 按纪律②**不建条目**，建了会被「白名单不许有失效条目」当场判 stale。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 */
export const UNIT_PACKAGING_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/unit/packaging/zip/scan.test.ts",
    hosts: ["e.name"],
    reason: "**非 host 文本：成员访问**（`b.archive.entries.find((e) => e.name === name)` / `map((e) => e.name)`）。扫描器把整条点分成员访问的小写形态当作一个「host」，而 `.name` 命中 TLD 表 —— 与 `tests/library/entry.test.ts` 申报的 `context.store` 同一类已知误报。**显式豁免而不把 `name` 从 TLD 表删掉**（那会给真实公网 TLD 开后门）。本档真读的东西只有 `dist/*.zip` 的 central directory，列 `e.name` 是解 zip 条目的文件名，从不作为连接目标。",
  },
];