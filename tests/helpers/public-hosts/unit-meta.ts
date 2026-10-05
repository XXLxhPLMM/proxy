import type { PublicHostEntry } from "../external-network-scan.js";

/**
 * 零外网白名单 —— `tests/unit/meta/` 主题片
 *
 * @description
 * 归**管 `tests/unit/meta/` 的 agent**维护。文件搬进子目录时 `file` 要逐条改成
 * 新路径 —— 旧路径留在原地会当场被判 stale（见 `../AGENTS.md`）。
 *
 * ⚠️ **搬迁时逐条重写 reason 里的「本档」代词**。
 *
 * 三条纪律见 `../AGENTS.md`：`reason` 答「为什么它不建链」、零公网字面量的文件不建条目、
 * 同一 `(file, host)` 对不许在表里出现两次。
 */
export const UNIT_META_HOST_REFS: readonly PublicHostEntry[] = [
  {
    file: "tests/unit/meta/runtime-floor/truth-source.test.ts",
    hosts: ["22.13.0.1"],
    reason: "**地板解析器的合成脏样本**（`>=22.13.0.1` 必须在「真相源的形状」那档被判不合格）：`engines.node` 的 patch 段必须恒为 0，否则「文档写 22.13」在字面上成假话。该样本是一个**版本号字面量**，判据是 `RegExp.exec` 的匹配与否，本档不 import 任何网络 API、不建链。",
  },
];