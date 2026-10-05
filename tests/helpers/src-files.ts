import fs from "node:fs";
import path from "node:path";
import { SRC_DIR } from "./source-scan.js";

/**
 * 递归列出 `src/` 下**全部** `.ts`，返回相对 `SRC_DIR` 的路径（`codeOf()` 收的就是这个形态）
 *
 * @description
 * **递归而不是按目录现列**：调用方要钉的是「`src/**` 全文恰好 N 处」这类断言，
 * 而 `sourceFiles()` 只覆盖一层 —— 新增一个子目录时它不在清单里，于是「恰好 N 处」
 * 会因为**少算**而照样绿。两者的取舍是刻意的：按目录现列适合「这一层不许有什么」，
 * 递归适合「全仓不许有什么」。
 *
 * ⚠️ 刻意用 `readdirSync` + `statSync` 的**字符串**形态，而不是 `readdirSync` 的 **Dirent 形态**
 * （第二参数打开的那一个）：那种形态下每一项都得读它的 `name` 成员，而 `name` 正是
 * `external-network-scan.ts` 的 `PUBLIC_TLDS` 表里的一项 —— 于是本文件就成了一个「带公网 host
 * 形态字面量」的文件，而 `tests/helpers/` **不在** `SCAN_DIRS`（`unit` / `integration` /
 * `library`）范围内，那道护栏会对本文件**彻底失效且一声不吭**（`external-network-scan.ts`
 * 文件头警告的自噬，只是入口从「把白名单放进扫描目录」换成了「把遍历代码放进豁免目录」）。
 * 纪律是**不靠豁免掩盖能改掉的命中**：写法改得掉，就不要给它开豁免。
 */
export function srcFilesRecursive(rel = ""): string[] {
  const abs = path.join(SRC_DIR, rel);
  const out: string[] = [];
  for (const label of fs.readdirSync(abs)) {
    const child = rel === "" ? label : `${rel}/${label}`;
    if (fs.statSync(path.join(abs, label)).isDirectory()) {
      out.push(...srcFilesRecursive(child));
    } else if (label.endsWith(".ts")) {
      out.push(child);
    }
  }
  return out;
}