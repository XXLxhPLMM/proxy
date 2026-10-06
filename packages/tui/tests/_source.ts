/**
 * 本包**读源码文本**的那一小面（两个以上档真用到才放这儿：判据是「值不值得多一跳」，不是「目录里有没有」）
 *
 * ⚠️ **为什么它必须剥字符串**：判据锚在「代码里出现了某个词」上，而文档字符串与注释里提到那个词
 * 是常态 —— 不剥的话一份纯文档改动就能让那些判据转红，而它们转红时没有任何代码事实对应。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

/** `packages/tui/src/`（⚠️ **两个** `..`：本文件在 `tests/` 下，少一个会解析到不存在的目录） */
export const SRC_DIR = join(__dirname, "..", "src");

/**
 * 只留代码：注释（含行尾那半行）与字符串字面量都换成空壳
 * @description ⚠️ **不用一条带 `\t` 的正则**：`no-control-regex` 是本包的纪律，而那条正则里的
 * 字符类会踩它 ⇒ 逐条正则分开剥，每一条都不含控制字符。
 */
export function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // ⚠️ **行尾注释也要剥**（不是只剥「整行都是注释」的那些）：`const a = 1; // token` 那半行同样是注释
    .replace(/\/\/.*$/gm, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

/** 现列 `src/` 下此刻真实存在的全部 `.ts` / `.tsx`（⚠️ **现列**，不手写清单），键是 `src/` 下的相对路径 */
export function sourceFilesUnder(dir = SRC_DIR): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (full: string): void => {
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      const child = join(full, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        out.set(child.slice(dir.length + 1).split(sep).join("/"), readFileSync(child, "utf8"));
      }
    }
  };
  walk(dir);
  return out;
}