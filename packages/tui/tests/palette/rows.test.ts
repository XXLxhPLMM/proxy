/**
 * 面板开不开、列哪几行、哪一行高亮：`paletteOpen` / `paletteOf` / `commandHead` 三条只读判据。
 *
 * @description
 * 四条不变量的前三只（①开的那一条判据 / ②列的是全表而敲的东西只定高亮 / ③高亮是输入行的**纯函数**）。
 * ⚠️ 三条各挡一种退化：面板亮着而 `Tab` 什么也不做（`@/commands:complete` 与它两层不同步）、列表被敲进去
 * 的东西过滤掉于是 `↓` 只能走一步、高亮记在模块级变量里于是重渲染那一帧它自己走。
 *
 * 四条不变量与 N1–N29 / M1–M22 变异实测表见本目录 `AGENTS.md`。
 *
 * @module tests/palette
 */

import { describe, expect, it } from "vitest";

import {
  PALETTE_ROWS,
  commandHead,
  paletteFill,
  paletteOf,
  paletteOpen,
  paletteStep,
} from "@/commands/palette.js";
import { COMMAND_SPECS } from "@/commands/parse.js";

/** 面板里那一行的下标（`paletteOf` 的返回在类型上给不出这个断言要的东西，故这里取一行） */
function rowAt(line: string, index: number): string {
  const palette = paletteOf(line);
  const row = palette.rows[index];
  if (row === undefined) throw new Error(`面板里没有第 ${index} 行（共 ${palette.rows.length} 行）`);
  return row.path;
}

/* ── ① 面板的开 ──────────────────────────────────────────────────────────── */

describe("不变量 ①：面板开 ⇔ 整行以 `/` 开头（只有这一条判据）", () => {
  it("带前缀就开，空行与不带前缀的行都不开", () => {
    expect(paletteOpen("/")).toBe(true);
    expect(paletteOpen("/s")).toBe(true);
    expect(paletteOpen("/user add alice")).toBe(true);
    expect(paletteOpen("/status ")).toBe(true);
    // ⚠️ **反向自检**：不带前缀的一律不开。少了它，「面板亮着而 Tab 什么也不做」就会出现
    // （`@/commands:complete` 对同一行给零候选 —— 两层不同步）。
    expect(paletteOpen("")).toBe(false);
    expect(paletteOpen("status")).toBe(false);
    expect(paletteOpen("  /status")).toBe(false);
    expect(paletteOpen("x")).toBe(false);
  });

  it("⚠️ 光标在哪、有没有空格**都不影响**开不开（变异：加上那些条件 → 这里红）", () => {
    // 判据是「只判前缀」这件事本身：每加一个条件（光标在不在名字里、是不是刚敲完一个空格），
    // 面板就会多一种形态，而操作者看到的是「有时候有面板有时候没有」。
    for (const line of ["/", "/user", "/user ", "/user add", "/user add "]) {
      expect(paletteOpen(line)).toBe(true);
    }
  });

  it("关着的时候给的是中性值（不是 `null` 的分支）", () => {
    const closed = paletteOf("status");
    expect(closed.open).toBe(false);
    expect(closed.at).toBe(-1);
    expect(closed.rows).toEqual([]);
  });
});

/* ── ② 列全表，敲的东西只定高亮 ─────────────────────────────────────────── */

describe("不变量 ②：列的是**全表**，敲出来的东西只用来定高亮", () => {
  it("每一行都来自那唯一一张表，且顺序就是表的顺序（`help` 的呈现顺序）", () => {
    expect(paletteOf("/").rows.map((row) => row.path)).toEqual(
      COMMAND_SPECS.map((spec) => spec.path),
    );
    expect(paletteOf("/").rows.map((row) => row.summary)).toEqual(
      COMMAND_SPECS.map((spec) => spec.summary),
    );
  });

  it("敲了一半**不裁列表**（否则 `↓` 只能走一步）", () => {
    // ⚠️ 这是本组的核心：过滤会让高亮写成 `/clear` 之后列表塌成一行，于是第二次 `↓`
    // 无处可去 —— 症状是「面板只能选一次」。
    expect(paletteOf("/s").rows).toHaveLength(PALETTE_ROWS.length);
    expect(paletteOf("/user").rows).toHaveLength(PALETTE_ROWS.length);
  });

  it("敲的东西表里没有时：**一个都不高亮**，而列表照旧全在", () => {
    const none = paletteOf("/zzz");
    expect(none.open).toBe(true);
    expect(none.at).toBe(-1);
    expect(none.rows).toHaveLength(PALETTE_ROWS.length);
  });

  it("高亮 = 第一个名字以命令名开头的行（**表的顺序**，不是字典序）", () => {
    // ⚠️ `/c` 的两条候选是 `config`（表里第 3）与 `acl`（第 5）；按字典序会选 `acl`，
    // 而这一组断言钉的是「先查帮助、再干活」那个顺序。
    expect(paletteOf("/c").at).toBe(COMMAND_SPECS.findIndex((spec) => spec.name === "config"));
    expect(rowAt("/c", paletteOf("/c").at)).toBe("/config");
  });

  it("命令名**跨空白**取到「第一个不属于命令名的词」为止", () => {
    // ⚠️ 判据落在「**跨空白**」上：`/user add alice` 的命令名是 `user add`，而按空白截断得到
    // `user` —— 于是 `/user add `（名字已经敲完，后面那个空格就是分界）的高亮停在 `/user` 上，
    // 而屏上那个形状是「按了 `↓` 它不动」。
    expect(commandHead("/user add alice")).toBe("user add");
    expect(commandHead("/user add")).toBe("user add");
    expect(commandHead("/user add ")).toBe("user add");
    expect(commandHead("/user")).toBe("user");
    expect(commandHead("/users")).toBe("users");
    expect(commandHead("/")).toBe("");
    // ⚠️ **敲到一半的词也算**：高亮落在唯一那一条上（`/user a` → `/user add`）
    expect(commandHead("/user a")).toBe("user a");
    expect(rowAt("/user a", paletteOf("/user a").at)).toBe("/user add");
    // ⚠️ 表里没有的东西**只取第一个词**（那是「正在敲的那一段」）
    expect(commandHead("/zzz tail")).toBe("zzz");
    // ⚠️ 对照：这一段只管命令名，而**光标所在那个词**的候选是 `@/commands:complete` 的活。
    // 两者看的是不同的位置，所以它们给两个答案不是矛盾。
    expect(commandHead("/user add alice")).not.toBe("add");
  });

  it("⚠️ `↓` 走过**两段命令名**的边界时，输入行与高亮**始终**指着同一条", () => {
    // ⚠️ 这一条是上面那条判据的**可观察后果**：两段命令名一带的换行若只吃掉第一个词，输入行会
    // 变成 `/user set add` 而高亮回到 `/user` —— 于是再按 `↓` 就**再也不动了**
    // （`paletteStep` 看到 `at` 没变就直接返回）。故它必须一路走过那一段才验得出来。
    let line = "/";
    let cursor = 1;
    const walked: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const to = paletteStep(paletteOf(line).at, 1, PALETTE_ROWS.length);
      const row = PALETTE_ROWS[to];
      if (row === undefined) throw new Error(`面板里没有第 ${String(to)} 行`);
      const filled = paletteFill(line, cursor, row);
      line = filled.line;
      cursor = filled.cursor;
      // ⚠️ 换完之后的输入行**就是**刚选中的那一条（补出来的那个尾随空格也算进去）
      expect(line).toBe(`${row.path}${row.needsSpace ? " " : ""}`);
      expect(paletteOf(line).at).toBe(to);
      walked.push(row.path);
    }
    // ⚠️ **反向自检**：12 步真的走了 12 条不同的命令（一个「原地不动」的实现也满足上面两条，
    // 而屏上那一帧是「按了 `↓` 没反应」）
    expect(new Set(walked).size).toBe(12);
  });
});

/* ── ③ 高亮是输入行的纯函数 ─────────────────────────────────────────────── */

describe("不变量 ③：高亮只由输入行决定（界面上没有「高亮在第几行」这个状态）", () => {
  it("`↓` 走一步之后，写进输入行的那一行**就是**下一帧的高亮", () => {
    const at = paletteOf("/").at;
    const next = paletteStep(at, 1, PALETTE_ROWS.length);
    const row = PALETTE_ROWS[next] as (typeof PALETTE_ROWS)[number];
    const filled = paletteFill("/", 1, row);
    // ⚠️ 闭包：填完之后重新算，高亮必须落在刚填的那一行上。
    // 少了这一条，「输入行上敲的是 A、面板高亮的是 B」就会在每一次 `↓` 之后发生一次。
    expect(paletteOf(filled.line).at).toBe(next);
    expect(rowAt(filled.line, paletteOf(filled.line).at)).toBe(row.path);
  });

  it("⚠️ 同一行**算两次逐字相同**（变异：让 `at` 自己累加 → 这里红）", () => {
    // 判据是「可重复」这件事本身：一个把 `at` 记在模块级变量里的实现两次调用会给出不同的结果，
    // 而 React 重渲染时同一帧算两次那种形状（StrictMode / 双调用）就会让高亮自己走。
    expect(paletteOf("/user set bob").at).toBe(paletteOf("/user set bob").at);
    // ⚠️ 敲 `/user` 高亮的是 `/user` **本身**而不是 `/users`（表里 `users` 排在前面）——
    // 少了这条，`Tab` 会补出一条他没敲的命令，而那一条还真实存在。
    expect(rowAt("/user", paletteOf("/user").at)).toBe("/user");
    expect(rowAt("/users", paletteOf("/users").at)).toBe("/users");
  });

  it("敲了前缀就高亮那一条（`/st` → `/status`）", () => {
    expect(rowAt("/st", paletteOf("/st").at)).toBe("/status");
    expect(rowAt("/user", paletteOf("/user").at)).toBe("/user");
  });
});
