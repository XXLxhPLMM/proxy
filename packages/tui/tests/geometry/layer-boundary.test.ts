/**
 * 层边界（源码级）：`src/lib/` 零 IO、零 `process.*`、零 React、零 Ink
 * @description
 * 这一档**读的是源码文本**（`LIB_DIR` 指向 `src/lib/`，递归含 `log/` 与 `exec/`），不是跑起来的东西。
 *
 * ⚠️ **`src/lib/AGENTS.md` 第一条写着这一层「零 IO、零 `process.*`、零 React、零 Ink」并注明
 * 「这是这些判据能被逐字断言的前提」—— 而它此前一条断言都没有**：那句话会腐烂，而腐烂的样子是
 * 「几何层顺手 `process.stdout.write` 了一下」「`format.ts` 引了 `react` 换了个 nicer 的拼法」，
 * 两者屏上都不报错：前者把一次重排写成裸字节（绕过 Ink 的全屏帧），后者让纯函数那一层
 * 在**没有 Ink 的环境**里根本 load 不了。
 *
 * ⚠️ **判据按「引了哪个模块」写，不按「不许用某个库」写**：认的是**模块标识的形状**
 * （任何 `node:` 内建模块 / `react` / `ink`，连同它们的子路径），所以换一个同类实现也红，
 * 而这一层**该引的**（跨目录 barrel、`@/api` 契约、`string-width`、纯类型 import）全部放行 ——
 * 「不许用某个库」是技术锁定，换一种实现同一个不变量就被误判，于是下一个人会去改断言。
 *
 * ⚠️ **目录级不变量见 `AGENTS.md`**（本目录那九条几何判据住那里，这一档管的是层边界，另一件事）。
 *
 * @module tests/geometry
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `src/lib/` 的源码目录（**递归**：`log/` 与 `exec/` 两个子目录也在这一层之内）
 * @description ⚠️ **两个** `..`：本档在 `tests/geometry/`（比 `tests/` 深一层），一个会落到 `tests/src`
 * —— 那个目录不存在，于是 `readdirSync` 抛 ENOENT（**响亮的红**，不是空集假绿）。
 */
const LIB_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "lib",
);

/**
 * 只留**代码**：整行 `//` 与 `/* … *\/` 块注释都剔掉
 * @description ⚠️ 与 `tests/state-owner/state-owner.test.ts` 的 `codeOnly` **同一套纪律**：
 * 「注释里点名被禁符号」是在**描述**这条不变量，而一个不剔注释的探测器会让「本文档自己提了一句
 * `process.*`」把判据变成恒红 —— 那正是「探测器认错了东西」与「实现坏了」长得一样的那一类。
 * ⚠️ 行尾 `//` 不剔（源码里有 `http://` 那样的字符串）：宁可误报也不误判成「不是违规」。
 */
function codeOnly(text: string): readonly string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes("*/")) inBlock = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlock = true;
      continue;
    }
    if (trimmed.startsWith("//")) continue;
    out.push(line);
  }
  return out;
}

const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  // ⚠️ `process.` / `console.` 带**前导界定符**：`obj.process.exit` 是一个普通字段名 —— 不加界定符的话
  // 判据会宽到逮不住任何东西，也会在别人的同形文本上误报。
  ["process", /(^|[^.\w$])process\s*\./],
  ["console", /(^|[^.\w$])console\s*\./],
  // ⚠️ **零 IO / 零 React / 零 Ink 按「引了哪个模块」判，而不是按「不许用某个库」判**：
  // 任何 `node:` 内建模块（`fs` / `net` / `child_process` / `os` …）、`react` / `react-dom` /
  // `ink` 一律判中，而 `import type { Rect } from "…"` 与 `@/lib/` / `string-width` 都不判 ——
  // 后者本来就是这一层该引的（那一层有它自己要算的东西）。
  // ⚠️ 前缀与列表都要有：`node:fs/promises` 与 `react/jsx-runtime` 是**同一个包**的另外两条路径，
  // 只写 `^from "(node:|react|ink)"`（带闭引号）的话它们全部从判据下滑过去。
  ["宿主 / 渲染依赖的 import", /from\s+"(?:node:[a-z_/]+|react(?:\/[\w./-]+)?|ink(?:\/[\w./-]+)?)"/],
];

function hits(text: string): string[] {
  const lines = codeOnly(text);
  const found: string[] = [];
  for (const [what, shape] of FORBIDDEN) {
    lines.forEach((line, index) => {
      if (shape.test(line)) found.push(`${what} @ ${index + 1}: ${line.trim()}`);
    });
  }
  return found;
}

/** `src/lib/` 下的全部源文件（⚠️ **列目录**而不是手写清单：新增文件自动进扫描面） */
function sources(): ReadonlyArray<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        out.push([path.relative(LIB_DIR, full).split(path.sep).join("/"), fs.readFileSync(full, "utf8")]);
      }
    }
  };
  walk(LIB_DIR);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

const SRC = sources();

describe("层边界（源码级）：`src/lib/` 是零 IO、零 process.*、零 React、零 Ink 的那一半", () => {
  it("扫描面非空，且真的覆盖到本目录（含两个子目录）的源文件", () => {
    const names = SRC.map(([name]) => name);
    // ⚠️ **点名三个今天的路径**（不点名的判据在目录被搬走后恒空、恒绿 —— 根 `AGENTS.md`「写护栏时」）
    expect(names).toContain("geometry.ts");
    expect(names).toContain("log/rows.ts");
    expect(names).toContain("exec/run.ts");
    // ⚠️ 而**递归**是这条的一部分：只扫顶层的话 `log/` 与 `exec/` 两个子目录整个不在判据内
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it("判据自检：同一套判据必须能认出违规样本（否则上面那条是恒绿）", () => {
    // 「探测器看得见」与「今天真的干净」两条合起来才叫断言；只写后半条的话，探测器写坏了照样全绿
    const dirty = [
      "const code = process.exitCode ?? 0;",
      'console.log("x");',
      'import React from "react";',
      'import { render } from "ink";',
      'import fs from "node:fs";',
      // ⚠️ **带子路径的同一个包**：`node:fs/promises` 与 `react/jsx-runtime` 是一条被前缀漏掉的路
      'import { readFile } from "node:fs/promises";',
      'import { jsx } from "react/jsx-runtime";',
    ];
    for (const sample of dirty) {
      expect(hits(sample).length, `判据没认出：${sample}`).toBe(1);
    }
    // ⚠️ 且不能把**成员访问**误判成宿主访问（`obj.process.exit` 只是普通字段名）
    expect(hits("const a = obj.process.exit;").length).toBe(0);
    expect(hits("const a = obj.console.log;").length).toBe(0);
    // ⚠️ 而这一层**该引的**都放行：跨目录 barrel、本包兄弟、`@/api` 契约、以及宽度测量那个第三方库
    expect(hits('import { ellipsis } from "@/lib/index.js";').length).toBe(0);
    expect(hits('import stringWidth from "string-width";').length).toBe(0);
    // ⚠️ **类型** import 同样放行（`WindowSlot` / `TuiCode` / `Rect` 都是类型）
    expect(hits('import type { Rect } from "@/lib/index.js";').length).toBe(0);
    expect(hits('import type { Tone } from "@/theme/index.js";').length).toBe(0);
  });

  it("⚠️ **注释里提到 `process.` / `console.` 不算违规**（否则注释一改判据就恒红）", () => {
    const commented = [
      "/**",
      " * 组合根采一次往下传，于是本层没有 `process.stdout.write`；",
      " * 也不许 `console.log`。",
      " */",
      "export const x = 1;",
    ].join("\n");
    expect(hits(commented)).toEqual([]);
    // ⚠️ 而**真代码**里的那一行仍然认得出（防的是「把代码也当成注释」这种反向失守）
    expect(hits(["// 见下", "const code = process.exitCode;"].join("\n")).length).toBe(1);
    expect(hits(["/* 见下 */", "console.log(1);"].join("\n")).length).toBe(1);
  });

  it("`src/lib/` 零 `process.*`、零 `console.*`、零真值 import（宽高与时刻由入参注入正是为了这一条）", () => {
    const violations = SRC.flatMap(([name, text]) =>
      hits(text).map((where) => `${name}: ${where}`),
    );
    expect(
      violations,
      `本层出现了宿主访问 / 渲染依赖 / 调试输出：\n${violations.join("\n")}\n\n` +
        "判据：`src/lib/AGENTS.md` 第一条 —— 这一层没有一处能触网、读时钟或读环境。\n" +
        "需要宿主能力时把值**注入进来**（`geometry()` 收宽高就是这样），别在本层伸手。",
    ).toEqual([]);
  });
});