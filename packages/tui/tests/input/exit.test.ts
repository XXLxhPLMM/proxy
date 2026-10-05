/**
 * 退出这一族：`/exit` 与 `/quit` 退得成、`Ctrl+C` **什么都不做**、`/help` 上找得到那扇门
 *
 * @description
 * ⚠️ **「`Ctrl+C` 什么都不做」是本档最要紧的一条**：组合根写着 `exitOnCtrlC: false`，而仓库里曾有
 * 文档说「`Ctrl+C` 到不了这一层（Ink 自己先处理了它）」—— 那句话与那一格**矛盾**，骗过人一次，
 * 而它此前**一条断言都没有**。判据是**喂键之后屏上零变化**，不是「源码里没有 `Ctrl+C` 分支」
 * （那种判据恒真，见根 `AGENTS.md`「写护栏时」）。
 * ⚠️ 而「零变化」的**正向对照与它在同一个 `it` 里**（同一个 handler 喂真键 ⇒ 屏面必须变）：分开放
 * 两条时谁删掉哪一条，剩下的那条都是纯装饰 —— 实测把整个 `useInput` 挂空，「零变化」照样绿。
 *
 * ⚠️ 忙时 `/exit` 不退：那些东西落地时撞上已关的台账，而组件那时已经 `unmount` ⇒ 变成一个没人接的
 * 异常。判据是「退出没被请求」**加**「屏上说了为什么」**加**「跑完之后再敲一次就退得成」。
 *
 * ⚠️ 共用的不变量与那张变异表见 `./AGENTS.md`。
 *
 * @module tests/input
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CTRL_C,
  ENTER,
  ledger,
  mount,
  sidebarOf,
  stripAnsi,
  typed,
} from "./_shared.js";

/** 组合根那个文件（源码级判据读它 —— ⚠️ 判据要钉住的是**组合根那一格**，而它不在本档能渲染的范围里） */
const CLI = readFileSync(join(__dirname, "..", "..", "src", "cli.tsx"), "utf8");

/** 状态层那个文件（同上；「这一层零 `process.*`」那条不变量钉在它身上） */
const APP_STATE = readFileSync(join(__dirname, "..", "..", "src", "AppState.tsx"), "utf8");

/** 那一帧的纯文本（判据读的是**渲染后那一帧的字节**） */
function plain(output: string): string {
  return stripAnsi(output);
}

/** 扫出源码的**代码**部分（⚠️ 逐行剔注释 —— 注释里提到 `process.` 不会让那一层碰宿主） */
function codeOf(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"))
    .join("\n");
}

/**
 * 把 `/users` 那个请求捏在手里（= 造出「一条命令在飞」的可控形状）
 * @description ⚠️ **必须捏住 fetch 而不是「敲得快点」**：`feed` 每两个键之间都等屏面稳定
 * （`settle`），而一条本地命令几十毫秒就回来了 ⇒ 「队列里还压着东西」在不捏住它时根本造不出来。
 * ⚠️ 探活也在发请求，故按**路径**分流而不是按次数（次数会被探活打乱）。
 */
function holdUsers(): { readonly release: () => void; readonly restore: () => void } {
  let open: (() => void) | null = null;
  const stub = vi.fn(async (input: unknown) => {
    if (String(input).includes("/users")) {
      await new Promise<void>((resolve) => {
        open = resolve;
      });
      return { ok: true, status: 200, text: async () => JSON.stringify({ accounts: [] }) };
    }
    return { ok: false, status: 0, text: async () => "" };
  });
  vi.stubGlobal("fetch", stub);
  return {
    release: () => open?.(),
    restore: () => {
      open?.();
      vi.unstubAllGlobals();
    },
  };
}

/* ── `/exit` 与 `/quit`：唯一的退出命令 ─────────────────────────────────────── */

describe("退出：`/exit` 与 `/quit` 是**唯一**的门", () => {
  it("⚠️ 敲 `/exit` ⇒ 退出被请求，且屏上一个字都没多", async () => {
    const ui = await mount({ interactive: false });
    await ui.feed([...typed("/exit"), ENTER]);
    // ⚠️ **核心判据**：那个注入点被调了一次（它是 `cli.tsx` 里 `finish(0, null)` 的唯一落点）
    expect(ui.exits()).toBe(1);
    // ⚠️ **不留痕**：`/exit` 与 `/new` / `/managers` 同族（`leavesTrace` 说它们不留痕），
    // 而「它退了」由终端回到提示符那一件事自己回答
    const output = plain(await ui.finish());
    expect(output).not.toContain("退出 TUI");
    expect(output).toContain("会话 1");
  });

  it("⚠️ `/quit` 退得成，且退得**一模一样**（两个名字、一条实现）", async () => {
    const quit = await mount({ interactive: false });
    await quit.feed([...typed("/quit"), ENTER]);
    // ⚠️ **反向自检**：`/exit` 那一条先钉住「这个注入点真会被调到」（少了它，下面那条恒绿）
    const exit = await mount({ interactive: false });
    await exit.feed([...typed("/exit"), ENTER]);
    expect(exit.exits()).toBe(1);
    expect(quit.exits()).toBe(1);
  });

  it("⚠️ **忙的时候 `/exit` 不退出**，而屏上说了为什么", async () => {
    const held = holdUsers();
    try {
      const ui = await mount({ interactive: false, ledgerFile: ledger() });
      // ⚠️ 三条命令依次敲进去，而 `feed` 每两个键之间都等屏面稳定 ⇒ 队列里**真**压着东西：
      // `/users` 在飞（fetch 被本档捏住）、`/exit` 排在它后面、`/new` 排在 `/exit` 后面
      await ui.feed([...typed("/users"), ENTER]);
      await ui.feed([...typed("/exit"), ENTER]);
      await ui.feed([...typed("/new"), ENTER]);
      // ⚠️ 此刻 `/exit` **还在队列里**（`/users` 没回来）：断言「退都没退」那就成了「还没轮到它」
      expect(ui.exits()).toBe(0);
      // ⚠️ **放行 `/users`** ⇒ 轮到 `/exit` 了，而它落地时 `/new` **仍**排在后面 ⇒ 拒绝
      held.release();
      await ui.feed([]);
      const refused = plain(await ui.finish());
      // ⚠️ **核心判据一**：退出**没有被请求**（不是「退了但屏上不好看」）
      expect(ui.exits()).toBe(0);
      // ⚠️ **核心判据二**：屏上那句话 —— 静默不响应与「说了话」在屏上完全不是一件事
      expect(refused).toContain("还有命令在跑");
      // ⚠️ **正向对照**：队列真的走完了（`/new` 建出了会话 2）—— 否则上面两条与「整个界面死了」分不开
      expect(sidebarOf(refused).join("\n")).toContain("会话 2");
    } finally {
      held.restore();
    }
  });

  it("⚠️ **跑完之后**再敲一次 `/exit` 就退得成（那句「跑完再退」是真的）", async () => {
    const held = holdUsers();
    try {
      const ui = await mount({ interactive: false, ledgerFile: ledger() });
      await ui.feed([...typed("/users"), ENTER]);
      await ui.feed([...typed("/exit"), ENTER]);
      await ui.feed([...typed("/new"), ENTER]);
      held.release();
      await ui.feed([]);
      expect(ui.exits()).toBe(0);
      // ⚠️ 队列空了 ⇒ 再敲一次就退得成；只断言 `> 0` 的话，一个「永远退不出去」的界面也照样绿
      await ui.feed([...typed("/exit"), ENTER]);
      expect(ui.exits()).toBe(1);
      await ui.finish();
    } finally {
      held.restore();
    }
  });
});

/* ── `Ctrl+C`：刻意什么都不做（这一族存在的理由） ────────────────────────────── */

describe("`Ctrl+C`：刻意**什么都不做**", () => {
  it("⚠️ 喂 `Ctrl+C` ⇒ **屏上零变化**，而**同一个** handler 喂真键**动得了屏面**", async () => {
    // ⚠️ **必须 interactive 档**：非交互档一帧都不排，于是「零字节」恒真（假绿）
    const ui = await mount({ interactive: true });
    // ⚠️ 先敲半句命令：输入行**有内容**时「什么都没动」才不是一句空话
    await ui.feed([...typed("/sta")]);
    const before = ui.snapshot();
    await ui.feed([CTRL_C]);
    // ⚠️ **核心判据**：整条字节流逐字不变（而「重排一帧」就够让这一条红）
    expect(ui.snapshot()).toBe(before);
    // ⚠️ 单独断一遍「没退出」：帧没变**证明不了**退出没发生（退出那一帧可能是空的）
    expect(ui.exits()).toBe(0);
    // ⚠️ **同一个 handler 的正向对照，与「零变化」在同一个 `it` 里**：再喂一个真键，屏面**必须**变。
    // ⚠️ 判据落在「这个 handler 真的改变过屏面」上，而**不是**「源码里有某个分支」（后者恒真）：
    // 把整个 `useInput` 挂空时上面那半仍会绿（它只说「没动」），而这一半立刻红。
    await ui.feed(["x"]);
    expect(ui.snapshot()).not.toBe(before);
    // ⚠️ 而那一下动的是**输入行**：判据是那一串字真的长了一格，而不是「屏上恰好重排了一帧」
    expect(stripAnsi(ui.snapshot())).toContain("❯ /stax");
    await ui.finish();
  });

  it("⚠️ 会话弹窗开着时按 `Ctrl+C` 既不关窗也不进输入行", async () => {
    const ui = await mount({ interactive: true });
    await ui.feed([...typed("/sessions"), ENTER]);
    const before = ui.snapshot();
    await ui.feed([CTRL_C]);
    expect(ui.snapshot()).toBe(before);
    expect(ui.exits()).toBe(0);
    const after = plain(await ui.finish());
    // ⚠️ **反向自检**：那一帧真的有字，而弹窗**还在**（`Ctrl+C` 关不掉它）
    expect(after).toContain("历史会话");
  });

  it("⚠️ `exitOnCtrlC: false` **仍在**组合根那一格里（源码级，带扫描面与反向自检）", () => {
    // ⚠️ **扫描面非空自检**：这份源码里确实有 `exitOnCtrlC` 字面量 —— 否则下一条「匹配到零次」
    // 恒绿，而症状是「探测器认错了东西」与「那一格被删了」长得一样
    expect(CLI).toContain("exitOnCtrlC");
    // ⚠️ **反向自检**：喂 `true` 必须判不中（判据不能是「文件里出现过 exitOnCtrlC 就绿」）
    expect(CLI.includes("exitOnCtrlC: true")).toBe(false);
    expect(CLI).toContain("exitOnCtrlC: false");
  });
});

/* ── 可发现性：唯一的门必须在那份清单上 ─────────────────────────────────────── */

describe("可发现性：`/help` 上找得到那扇门", () => {
  it("⚠️ `/help` 的输出里**两个名字都在**（只有隐藏后门才能出去的界面是陷阱）", async () => {
    const ui = await mount({ interactive: false });
    await ui.feed([...typed("/help"), ENTER]);
    const output = plain(await ui.finish());
    // ⚠️ **判据是屏上逐字找那两行**（`/help` 那一屏是操作者唯一能看到的那份清单）
    expect(output).toContain("/exit");
    expect(output).toContain("/quit");
    // ⚠️ **反向自检**：那张表**真的跑出来了**（表没跑与「行不在表里」在屏上长得一样）
    expect(output).toContain("看用法与形参");
  });
});

/* ── 层边界：退出码归组合根、退出**必须**经那一个幂等 `finish` ─────────────── */

describe("退出码 0 与「退出只经那一个 `finish`」", () => {
  it("⚠️ 状态层那一层零 `process.*`（退出码与收尾都归组合根）", () => {
    const code = codeOf(APP_STATE);
    expect(code).not.toContain("process.");
    // ⚠️ **探测器自检**：喂一份真的 `process.` 它必须认得出来（否则上面那条是空壳）
    expect(codeOf("const x = process.exitCode;")).toContain("process.");
    // ⚠️ **注释自检**：注释里提到 `process.` 不算碰宿主（今天那一层真的提到了）
    expect(codeOf("// 退出码归 process 那一侧\nexport const x = 1;")).not.toContain("process.");
  });

  it("⚠️ `exit` 那个注入点在组合根被接到 `finish(0, null)` 上（源码级）", () => {
    // ⚠️ 锚点是**今天活着的形状**（`<App … />` 里那一行），不是某个符号名 ——
    // 点名一个已删掉的符号会让这条断言恒真（根 `AGENTS.md`「写护栏时」）
    expect(CLI).toContain("exit={() => finish(0, null)}");
    // ⚠️ **反向自检**：那个形状今天真的在这份源码里（探测面非空自检）
    expect(CLI).toContain("finish(0, null)");
  });
});