/**
 * 两档共用的扫描面与三个探测器。
 *
 * ⚠️ 收件门槛是「**两个以上文件真用到**」，不是「看起来通用」：只被一档用到的东西留在那一档里 ——
 * 搬进来就成了一份没人能单独删掉、也没人说得清谁在用的间接层。
 *
 * ⚠️ **扫描面是判据的前提**：文件列表取不到就是零个文件，而每一条上限断言都在空集上通过。故
 * `SRC` 在**模块期**算一次（同一档内多份断言看到同一份列表，故一次磁盘遍历够了），而取不到时
 * 立刻炸 —— 不许退化成「扫不到就没有违规」。
 *
 * ⚠️ `src` 根由本文件所在目录上溯**两级**得到（`tests/<folder>/../../src`）：少一级指向不存在的
 * `tests/src`。本文件夹里每个文件都在**同一层**，故这一个 `__dirname` 就是全文件夹唯一的真相。
 *
 * ⚠️ 体量判据量的是 **`src/`，不是 `tests/`** —— 在本文件夹里增删文件不改变任何一条上限的取值。
 *
 * @module tests/comment-budget
 */

import fs from "node:fs";
import path from "node:path";

/** 本包 `src/` 下的源文件（⚠️ 列目录，不手写清单 —— 新增文件自动进扫描范围） */
export function sources(): ReadonlyArray<readonly [string, string]> {
  const root = path.join(__dirname, "..", "..", "src");
  const out: Array<readonly [string, string]> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        out.push([path.relative(root, full).split(path.sep).join("/"), fs.readFileSync(full, "utf8")]);
      }
    }
  };
  walk(root);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** 逐行分类：`head` = 第一段注释（文件头），`body` = 其后每一段独立注释块 */
export function commentBlocks(lines: readonly string[]): Array<{ head: boolean; lines: string[]; at: number }> {
  const blocks: Array<{ head: boolean; lines: string[]; at: number }> = [];
  let inBlock = false;
  let cur: string[] = [];
  let start = 0;
  let seenCode = false;
  /** 块开始那一刻的「前面有没有代码」—— 必须在块**起头**时记，中途置位会把它误判成正文 */
  let curIsHead = true;

  const flush = (): void => {
    if (cur.length > 0) blocks.push({ head: curIsHead, lines: cur, at: start + 1 });
    cur = [];
  };
  const begin = (i: number): void => {
    if (cur.length === 0) {
      start = i;
      curIsHead = !seenCode;
    }
    cur.push("");
  };

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (inBlock) {
      cur.push(t);
      if (t.includes("*/")) {
        inBlock = false;
        flush();
      }
      continue;
    }
    if (t.startsWith("/*")) {
      begin(i);
      cur[cur.length - 1] = t;
      if (!t.includes("*/")) inBlock = true;
      else flush();
      continue;
    }
    if (t.startsWith("//")) {
      begin(i);
      cur[cur.length - 1] = t;
      continue;
    }
    if (t === "") continue;
    seenCode = true;
    if (!inBlock) flush();
  }
  flush();
  return blocks;
}

export function isBarrel(lines: readonly string[]): boolean {
  const body = lines
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .trim();
  if (body === "") return false;
  const rest = body
    .replace(/^[ \t]*(?:import|export)\b[\s\S]*?\bfrom\s+"[^"]*";/gm, "")
    .replace(/^[ \t]*import\s+"[^"]*";/gm, "")
    .trim();
  return rest === "";
}

/** 头部注释行数（第一段块 + 紧随其后的 `//` 行，算「文件头」整体） */
export function headCommentLines(lines: readonly string[]): number {
  let n = 0;
  for (const b of commentBlocks(lines)) {
    if (!b.head) break;
    n += b.lines.length;
  }
  return n;
}

/** 扫描面（模块期算一次；只读，各档只 `map` / `filter` / `flatMap`，谁也不改它） */
export const SRC = sources();