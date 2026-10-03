/**
 * `@/terminal/screen` 的序列对称性与幂等收尾断言
 *
 * **锁什么**：
 * ① 开闭**逐条配对**且**关闭的顺序是开启的逆序**（`ENTER` / `EXIT` 是两个独立字面量，测试从 `ENTER`
 *    推导出期望的 `EXIT`，不是拿 `EXIT` 自己比自己）；
 * ② 收尾**幂等**：第二次调用一个字节都不写；
 * ③ `?1049`（备用屏幕）**归 Ink**：本模块的源码里一条都不许有，且文件头必须留着「归 Ink」这句警告。
 *
 * **为什么拆掉哪一处会红**（每条都做过变异实测，红/绿两次输出见交接说明）：
 * - `EXIT_SEQUENCE` 改成与 `ENTER` **同序** → ① 的第二条转红（条数与内容都对，只有顺序错）。
 * - `enterFullScreen` 的收尾去掉 `if (restored) return;` → ② 转红（第二次写了一遍完整 EXIT）。
 * - `chainRestores` 改成「前一个抛了就跳过后面的」 → 「一个收尾抛了仍要跑完其余的」那条转红。
 * - 往 `ENTER_SEQUENCE` 里塞一条 `?1049h` → ③ 转红（那条断言扫的是源码，注释里也逃不掉）。
 *
 * ⚠️ 本档不碰真终端：`enterFullScreen` 只往一个**计数的 fake stdout** 上写，故「真终端退出后干不干净」
 * 仍需一次手动验证（组合根那一侧），单测验不到那部分。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chainRestores, enterFullScreen, ENTER_SEQUENCE, EXIT_SEQUENCE } from "@/terminal/screen.js";

/** 同一个模式号、`h` ↔ `l` 互换（`?25` 是 `l` 藏 / `h` 显，两侧都是「set」而不是 toggle） */
function flipTerminalFlag(sequence: string): string {
  return sequence.replace(/[hl]$/, (flag) => (flag === "h" ? "l" : "h"));
}

/** 一个只在内存里计数的 stdout：写什么它记什么，且**不写进真终端** */
function fakeOut(): { out: { write(chunk: string): boolean }; writes: string[] } {
  const writes: string[] = [];
  return {
    out: {
      write(chunk: string): boolean {
        writes.push(chunk);
        return true;
      },
    },
    writes,
  };
}

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

const screenSource = readFileSync(new URL("../src/terminal/screen.ts", import.meta.url), "utf8");
const screenLiterals = stringLiteralsOf(screenSource).join("");
/** 文件头那一段（`@fileoverview` 块）：这条警告**必须**住在那里，故断言只扫它 */
const screenHeader = screenSource.slice(0, screenSource.indexOf("*/") + 2);

describe("不变量 ①：开启与退出逐条配对，且关闭是开启的逆序", () => {
  it("进入的是「藏光标 + 开鼠标」，退出的是「关鼠标 + 显光标」", () => {
    expect(ENTER_SEQUENCE).toEqual([
      "\u001B[?25l",
      "\u001B[?1000h",
      "\u001B[?1003h",
      "\u001B[?1006h",
    ]);
    expect(EXIT_SEQUENCE).toEqual(["[?1006l", "[?1003l", "[?1000l", "[?25h"]);
  });

  it("每一条开启都有配对的关闭，且**关闭的顺序是开启的逆序**", () => {
    // 期望值从 ENTER 推导：同序同内容会红，只有顺序错也会红。
    expect(EXIT_SEQUENCE).toEqual([...ENTER_SEQUENCE].reverse().map(flipTerminalFlag));
  });

  it("配对数相等（多一条开启就等于有一条模式永远撤不掉）", () => {
    expect(EXIT_SEQUENCE).toHaveLength(ENTER_SEQUENCE.length);
  });
});

describe("不变量 ②：收尾幂等（退出路径有两条，重复收尾不许多写一个字节）", () => {
  it("进入时写一次，退出收尾写一次，再调一次收尾**什么都不写**", () => {
    const { out, writes } = fakeOut();
    const restore = enterFullScreen(out);

    expect(writes).toEqual([ENTER_SEQUENCE.join("")]);

    restore();
    expect(writes).toEqual([ENTER_SEQUENCE.join(""), EXIT_SEQUENCE.join("")]);

    const afterFirstRestore = writes.length;
    restore();
    restore();
    expect(writes).toHaveLength(afterFirstRestore);
  });

  it("每次 `enterFullScreen` 拿到的收尾**各自**独立（第二次收尾不因第一次已收而空转）", () => {
    const { out, writes } = fakeOut();
    enterFullScreen(out)();
    enterFullScreen(out)();
    expect(writes).toEqual([
      ENTER_SEQUENCE.join(""),
      EXIT_SEQUENCE.join(""),
      ENTER_SEQUENCE.join(""),
      EXIT_SEQUENCE.join(""),
    ]);
  });
});

describe("不变量 ③：链式收尾（`finally` 里只有一个调用点）", () => {
  it("全部收尾都跑，且结果仍幂等", () => {
    const { out, writes } = fakeOut();
    const order: string[] = [];
    const restore = chainRestores(
      (): void => {
        order.push("a");
      },
      enterFullScreen(out),
      (): void => {
        order.push("c");
      },
    );

    restore();
    expect(order).toEqual(["a", "c"]);
    // `enterFullScreen` 在被串起来的那一刻就写了 ENTER，故这里是两条
    expect(writes).toEqual([ENTER_SEQUENCE.join(""), EXIT_SEQUENCE.join("")]);

    restore();
    expect(order).toEqual(["a", "c"]);
    expect(writes).toHaveLength(2);
  });

  it("一个收尾抛了，**其余的照跑**，第一个异常在最后抛出", () => {
    const ran: string[] = [];
    const restore = chainRestores(
      (): void => {
        ran.push("a");
        throw new Error("close failed");
      },
      (): void => {
        ran.push("b");
      },
    );

    expect(() => {
      restore();
    }).toThrow("close failed");
    expect(ran).toEqual(["a", "b"]);
  });

  it("传零个收尾得到一个什么都不做、但仍幂等的收尾", () => {
    const restore = chainRestores();
    restore();
    restore();
  });
});

describe("不变量 ④：备用屏幕（`?1049`）归 Ink，本模块一条都不许碰", () => {
  it("进入/退出序列里没有 1049（发两遍会让终端的 alt screen 栈错位）", () => {
    expect(ENTER_SEQUENCE.join("")).not.toContain("1049");
    expect(EXIT_SEQUENCE.join("")).not.toContain("1049");
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
    expect(stringLiteralsOf(planted).join("")).toContain("1049");
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
    expect(screenSource.slice(screenHeader.length)).toContain("ENTER_SEQUENCE");
  });
});
