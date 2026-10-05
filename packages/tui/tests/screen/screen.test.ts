/**
 * `@/services/terminal/screen` 的收尾结构与「控制序列的 owner 只有一个」断言
 *
 * **锁什么**：
 * ① 链式收尾：收尾那几件事共用**一个**调用点 —— 全部收尾都跑、结果仍幂等、一个抛了其余照跑、**第一个**异常
 *    在最后重抛；
 * ② `?1049`（备用屏幕）**归 Ink**：本模块的字面量里一条都不许有，组合根那一侧同样一条都不许有，且文件头必须
 *    留着「归 Ink」这句警告；
 * ③ **这一族字节的 owner 唯一**：鼠标上报（`?1000` / `?1003` / `?1006`）唯一一份在 `mouse.ts` 里，本模块
 *    一个都不许有；光标显隐（`?25`）在整个 `src/` 里一个都不许有 —— 它的 owner 是 Ink。
 *
 * **为什么拆掉哪一处会红**（每一条都单独做过变异实测，红/绿两次输出见交接说明）：
 * - `chainRestores` 去掉 `done` 守卫 → ① 的「结果仍幂等」转红（第二次把全部收尾又跑了一遍）。
 * - `chainRestores` 改成「前一个抛了就跳过后面的」 → ① 的「其余的照跑」转红。
 * - `chainRestores` 把重抛的异常换成后一个 → ① 的「第一个异常在最后抛出」转红。
 * - 往 `screen.ts` 里种一条 `?1049h` 字面量 → ② 的两条 1049 判据**同时**转红（扫的是**字面量**，故文件头
 *   里逐字点名它不犯规）。
 * - 把文件头那半句「`?1049` 归 Ink」删掉 → ② 的「正向存在性」转红（扫全文就放过了这种删法）。
 * - 往 `screen.ts` 里种一条 `"\u001B[?1000h"` 字面量 → ③ 的第一条转红**且**「正向锚点」那一条也转红。
 * - 在 `terminal/` 下的**另一个**文件里种一条 `?1000h` → ③ 的「正向锚点」转红（第二个 owner 就是重复发报/撤）。
 * - 往 `cli.tsx` 里种一条 `?25l` 字面量 → ③ 的「整个 `src/` 里一个都不许有」转红。
 *
 * ⚠️ 本档不碰真终端：`mouse.ts` 的字节**另有**一档走假 TTY 真渲染（`tests/input/mouse-protocol.test.ts`），
 * 而「真终端退出后干不干净」仍需一次手动验证（组合根那一侧），单测验不到那部分。
 */

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chainRestores } from "@/services/terminal/screen.js";

/** 这一族「本包自己发的控制序列」的模式号（⚠️ 四个模式号的 owner 都在本包之外：`mouse.ts` 或 Ink） */
const MOUSE_MODES = ["?1000", "?1003", "?1006", "?25"] as const;

/**
 * 取出源码里**全部字符串字面量**（模板串按整体取），顺序不变
 * @description
 * ⚠️ 扫字面量而不是扫代码面：一条转义序列**只可能以字面量的形态存在**，故「代码面里没有 1049」
 * 这种判据是**恒绿**的（把 `?1049h` 写进代码面它照样通过，因为那句话在字符串里）。
 * 反过来，文件头**正当地**逐字点名了 1049 与 `?1049h`（那正是这条约束本身），所以也不能扫全文 ——
 * 扫全文等于把「必须写清警告」判成违规。字面量这一面同时躲开这两个坑。
 */
function stringLiteralsOf(text: string): string[] {
  // 注释与字面量**同一次扫描**里按位置先到先得：注释先匹配到就整段吃掉，
  // 故注释里那些用反引号包起来的词（文件头对 1049 的点名）不会被当成字面量。
  const tokens =
    /\/\*[\s\S]*?\*\/|[ \t]*\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  const literals: string[] = [];
  for (const match of text.matchAll(tokens)) {
    const first = match[0].trimStart()[0];
    if (first === '"' || first === "'" || first === "`") literals.push(match[0]);
  }
  return literals;
}

/** 一个源码文件里**全部字符串字面量**拼成的那一长串（⚠️ 只用它做「有没有」判断，不拿它当字节序） */
function literalsIn(text: string): string {
  return stringLiteralsOf(text).join("");
}

/** 递归列出目录下全部 `.ts` / `.tsx`（路径一律自己拼成 POSIX 形，故断言里逐字可比） */
function sourceFilesIn(relativeDir: string): string[] {
  const base = new URL(`../../${relativeDir}/`, import.meta.url);
  const found: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const child = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sourceFilesIn(child));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(child);
  }
  return found.sort();
}

/** `relativeDir` 下哪些文件的**字面量**提到了 `needle`（判据形状是「这个字面量今天在哪里」，不是「没有某个符号名」） */
function literalHoldersIn(relativeDir: string, needle: string): string[] {
  return sourceFilesIn(relativeDir).filter((file) =>
    literalsIn(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")).includes(needle),
  );
}

const screenSource = readFileSync(new URL("../../src/services/terminal/screen.ts", import.meta.url), "utf8");
const screenLiterals = literalsIn(screenSource);
/** 文件头那一段（`@fileoverview` 块）：那条警告**必须**住在那里，故断言只扫它 */
const screenHeader = screenSource.slice(0, screenSource.indexOf("*/") + 2);

describe("不变量 ①：链式收尾（收尾那几件事只有**一个**调用点）", () => {
  it("全部收尾都跑，且结果仍幂等", () => {
    const order: string[] = [];
    const restore = chainRestores(
      (): void => {
        order.push("a");
      },
      (): void => {
        order.push("b");
      },
      (): void => {
        order.push("c");
      },
    );

    restore();
    expect(order).toEqual(["a", "b", "c"]);

    restore();
    restore();
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("一个收尾抛了，**其余的照跑**，第一个异常在最后抛出", () => {
    const ran: string[] = [];
    const restore = chainRestores(
      (): void => {
        ran.push("a");
        throw new Error("first failed");
      },
      (): void => {
        ran.push("b");
      },
      (): void => {
        ran.push("c");
        throw new Error("second failed");
      },
    );

    // ⚠️ 断的是「哪一个」被重抛：中途就抛会把后面那几件没收成「没人看的错误」
    expect(() => {
      restore();
    }).toThrow("first failed");
    expect(ran).toEqual(["a", "b", "c"]);
  });

  it("传零个收尾得到一个什么都不做、但仍幂等的收尾", () => {
    const restore = chainRestores();
    restore();
    restore();
  });
});

describe("不变量 ②：备用屏幕（`?1049`）归 Ink，本模块一条都不许碰", () => {
  it("本模块与组合根的**字符串字面量**里都没有 1049（发两遍会让终端的 alt screen 栈错位）", () => {
    const cliSource = readFileSync(new URL("../../src/cli.tsx", import.meta.url), "utf8");
    expect(screenLiterals + literalsIn(cliSource)).not.toContain("1049");
  });

  it("本模块的**字符串字面量**里没有 1049（发了两遍就是字面量里多了一个 1049）", () => {
    expect(screenLiterals).not.toContain("1049");
  });

  it("反向自检：`stringLiteralsOf` 真的分得开字面量与注释（否则上面那条是恒绿）", () => {
    const planted = [
      'const a = "\\u001B[?25l";',
      "// 注释里的 ?1049h",
      "/* 块注释 ?1049l */ const b = `?1049h`;",
    ].join("\n");
    expect(stringLiteralsOf(planted)).toEqual(['"\\u001B[?25l"', "`?1049h`"]);
    expect(literalsIn(planted)).toContain("1049");
  });

  it("⚠️ **文件头**必须留着「1049 归 Ink」那句警告（正向存在性）", () => {
    // 只扫文件头：散落在各常量文档里的同名措辞满足不了「下一个读代码的人在开头就看见它」这条要求，
    // 而把断言写成扫全文就正好允许有人把开头那一段删掉。
    expect(screenHeader).toContain("1049");
    expect(screenHeader).toContain("归 Ink");
  });

  it("反向自检：文件头那一段真的取到了（否则上面那条可能扫了一块空文本）", () => {
    expect(screenHeader).not.toBe("");
    expect(screenHeader.length).toBeGreaterThan(200);
    expect(screenHeader.length).toBeLessThan(screenSource.length);
    expect(screenSource.slice(screenHeader.length)).toContain("chainRestores");
  });
});

describe("不变量 ③：这一族字节的 owner 唯一（鼠标上报归 `mouse.ts`，光标显隐归 Ink）", () => {
  it("本模块的字面量里一个 `?1000` / `?1003` / `?1006` / `?25` 都不许出现", () => {
    for (const mode of MOUSE_MODES) {
      expect(screenLiterals, `screen.ts 的字面量里出现了 ${mode}`).not.toContain(mode);
    }
  });

  it("正向锚点：鼠标上报那三条今天确实**唯一一份**在 `mouse.ts` 里（否则上面那条是对着空集合断言不存在）", () => {
    const mouseSource = readFileSync(
      new URL("../../src/services/terminal/mouse.ts", import.meta.url),
      "utf8",
    );
    const mouseLiterals = literalsIn(mouseSource);
    // 开启三条 + 关闭三条（`MOUSE_REPORTING_ON` / `MOUSE_REPORTING_OFF` 写成模板串，故这里断的是它们拼出来的字节）
    for (const mode of ["?1000h", "?1003h", "?1006h", "?1006l", "?1003l", "?1000l"]) {
      expect(mouseLiterals).toContain(mode);
    }
    expect(literalHoldersIn("src/services/terminal", "?1000")).toEqual([
      "src/services/terminal/mouse.ts",
    ]);
  });

  it("光标显隐（`?25`）在整个 `src/` 里一个都不许有：它的 owner 是 Ink，本包重写一遍只是同一个幂等 set", () => {
    expect(literalHoldersIn("src", "?25")).toEqual([]);
  });

  it("反向自检：同一个探测器喂一段**故意种了这些字面量**的文本，它必须逮得到、且不把注释当字面量", () => {
    const planted = [
      'const on = "\\u001B[?1000h";',
      "// 注释里的 ?25l 不算字面量",
      "/* 块注释里的 ?1006l 也不算 */ const off = `\\u001B[?1003l`;",
    ].join("\n");
    const found = literalsIn(planted);
    expect(found).toContain("?1000h");
    expect(found).toContain("?1003l");
    expect(found).not.toContain("?25");
    expect(found).not.toContain("?1006");
  });
});