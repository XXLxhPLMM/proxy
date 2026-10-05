/**
 * 引导屏：那一屏必须说清「控制面在哪选」，而那块艺术字标记**居中、逐行一色、放不下就不画**。
 *
 * @description
 * ⚠️ 判据是「屏上第 `welcome.y` 行的内容 == 素材第一行」——它把「画在哪一行」与「画的是什么」绑在一起，
 * 而分开断言两次（找行 + 比字）的话，行号算错而字对的情形会被放过去。
 * ⚠️ **横向判据量的是「那一行有字的那一段」的起止列**（显示列）而不是那句提示的宽度：抄一份整句会随文案漂，
 * 而抄一个前缀算不出末列（有中文时字宽不是 1）。
 * ⚠️ **奇偶两档屏宽都验**：只在偶数宽上成立的话是巧合。
 *
 * 两条不变量的完整说明与变异实测表见本目录 `AGENTS.md`。
 *
 * @module tests/layout
 */

import { describe, expect, it, vi } from "vitest";

// ⚠️ 必须在 ink（因而 chalk）被 import 之前设好，否则每一档的着色判据恒为「没有序列」—— 见 `AGENTS.md`
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { widthOf } from "@/lib/format.js";
import { SIDEBAR_GAP, geometry } from "@/lib/geometry.js";
import { flatten } from "@/lib/log/index.js";
import { LOGO, LOGO_TAG, LOGO_WIDTH } from "@/features/output/logo.js";
import type { LayoutProps } from "@/app.js";
import { COLUMNS, SIDEBAR, geoInput, props, renderFrame, renderRaw, renderScreen } from "./_harness.js";
import { fgSgrOf, indexOfText, screenRowOf, sgrColorAt } from "./_probe.js";

describe("不变量 ⑦：引导屏回答「控制面在哪选」", () => {
  it("有控制面但当前会话没有输出时出 logo，且引导语提到 /managers", async () => {
    const lines = await renderFrame(
      props({ showLogo: true, flat: flatten([], 100), managerStates: ["connected"] }),
    );
    const joined = lines.join("\n");
    expect(joined).toContain("/managers");
    expect(joined).toContain("会话");
  });

  it("台账为空时引导语说怎么加一个控制面", async () => {
    const lines = await renderFrame(
      props({ showLogo: true, flat: flatten([], 100), managerStates: [] }),
    );
    expect(lines.join("\n")).toContain("target add");
  });

  it("**logo 让位给输出**：当前会话有输出时不出 logo（两者同一位置）", async () => {
    const lines = await renderFrame(props({ showLogo: false }));
    const joined = lines.join("\n");
    expect(joined).toContain("已改");
    expect(joined).not.toContain("TAGLINE-anchor");
  });
});

describe("不变量 ⑧：引导屏那块标记（几何说它在哪，它就在哪）", () => {
  const empty = { showLogo: true, flat: flatten([], 100), managerStates: ["connected"] } as const;

  /**
   * 一句**短到不会撑满内容区**的提示（居中那一档的探针）
   * @description ⚠️ 不用引导屏自己那句：它在 100 列上**恰好被 `ellipsis` 裁到内容区宽**（量到
   * 「首列 = 内容区左缘」），而一个撑满的盒子**居中等于没居中** —— 拿它当探针的话，那条判据在
   * 实现回到「不居中」时也照样绿（实测踩过一次：两档里有一档直接 `left === 0`）。
   * ⚠️ 它经 `mouseHint` 进去，于是它是**第二条**提示，而「每一条各自居中」正是要判的那件事。
   */
  const SHORT_HINT = "鼠标不可用";

  /**
   * 那一行**有字的那一段**的首列与末列（**显示列**，半开区间的两个端点）
   * @description ⚠️ 按显示列扫而**不是** `trim()` 的字符下标：提示里有汉字，而一个汉字占两列 ——
   * 少这一层的话末列会算成一半（症状是「右边留白多出一截，而看起来只差一点点」）。
   */
  function inkColumns(line: string): [number, number] {
    let first = -1;
    let last = -1;
    let at = 0;
    for (const ch of line) {
      const w = widthOf(ch);
      if (ch !== " ") {
        if (first < 0) first = at;
        last = at + w - 1;
      }
      at += w;
    }
    return [first, last];
  }

  /** 那份 props 喂进 {@link geometry} 得到的那一份几何（「画与点同源」在断言里的形状） */
  const geoOf = (p: LayoutProps) =>
    geometry(
      geoInput({
        columns: p.columns,
        rows: p.rows,
        sidebarWidth: p.sidebarWidth,
        input: p.input,
        palette: p.palette,
        view: p.view,
        rename: p.rename,
        sessions: p.sessions,
        sessionsTop: p.sessionsTop,
        menu: p.menu,
      }),
    );

  it("⚠️ 艺术字**逐行逐字**与素材一致，且**上下都没有**服务端 banner 那两条分割线", async () => {
    const lines = await renderFrame(props(empty));
    const joined = lines.join("\n");
    for (const line of LOGO) expect(joined).toContain(line.text);
    expect(joined).toContain(LOGO_TAG);
    // ⚠️ 那两条 `─…✦…─` 是服务端启动画面的排版，界面上没有第二块横向区域放它
    expect(joined).not.toContain("✦");
    expect(joined).not.toContain("THE BEST PROXY SERVER");
  });

  it("⚠️ 那块标记**纵向居中**在结果区里（期望值从纯函数取，不写死屏幕行号）", async () => {
    const p = props(empty);
    const g = geoOf(p);
    expect(g.welcome).not.toBeNull();
    // ⚠️ 判据是「屏上第 `welcome.y` 行的内容 == 素材第一行」——它把「画在哪一行」与「画的是什么」
    // 绑在一起，而分开断言两次（找行 + 比字）的话，行号算错而字对的情形会被放过去。
    // ⚠️ 走 `renderScreen` 而不是 `renderFrame`：后者**滤掉空行**（它答的是「这一行有字吗」），
    // 而「第几行」这类判据要的是屏行号 —— 用前者当下标的话结果区里有几个空行就错几行。
    const screen = await renderScreen(p);
    expect(screen[g.welcome!.y] ?? "").toContain(LOGO[0]!.text);
    expect(screen[g.welcome!.y + LOGO.length] ?? "").toContain(LOGO_TAG);
  });

  it("⚠️ 艺术字**横向居中**（左右留白由那一行内容的实际起点决定）", async () => {
    const p = props(empty);
    const screen = await renderScreen(p);
    const row = screenRowOf(screen, LOGO[0]!.text);
    expect(row).toBeGreaterThanOrEqual(0);
    const ink = (screen[row] ?? "").search(/\S/);
    const mainX = SIDEBAR + SIDEBAR_GAP;
    expect(ink).toBe(mainX + Math.floor((COLUMNS - mainX - LOGO_WIDTH) / 2));
  });

  it("⚠️ 底下那几行提示**在内容区居中**（奇偶两档屏宽都验：只在偶数宽上成立的话是巧合）", async () => {
    // ⚠️ 判据是**左右留白相等**，而**不是**「起点等于某个算出来的数」：后者等于把实现的算术抄一份，
    // 实现改一个取整方式断言就跟着红，而屏上看着没变。
    // ⚠️ **量的是那一行「有字的那一段」的起止列**而不是那句提示的宽度：抄一份整句会随文案漂，
    // 而抄一个前缀算不出末列（有中文时字宽不是 1）。
    // ⚠️ **奇偶两档都要**：内容区宽 = 屏宽 − 侧边栏 − 间隔，两档差一列，于是「居中」在两档上落到取整的
    // 两边；只跑一档的话 `Math.floor` 与 `Math.ceil` 的差别在另一档上会长成「偏了一列」。
    for (const columns of [100, 101]) {
      const p = props({ ...empty, columns, mouseHint: SHORT_HINT });
      const screen = await renderScreen(p);
      const area = geoOf(p).output!;
      const row = screenRowOf(screen, SHORT_HINT);
      expect(row, `屏上没有那条短提示（${String(columns)} 列）`).toBeGreaterThanOrEqual(0);
      const [first, last] = inkColumns(screen[row] ?? "");
      const left = first - area.x;
      const right = area.x + area.width - (last + 1);
      // ⚠️ **反向自检**：它**不是**靠左的（左右留白一大一小 ⇒ 判据恒假；两侧都是 0 ⇒ 「居中」没发生）
      expect(left, `${String(columns)} 列：左侧留白`).toBeGreaterThan(0);
      expect(Math.abs(left - right), `${String(columns)} 列：左右留白`).toBeLessThanOrEqual(1);
    }
  });

  it("⚠️ 放不下就**如实不画**（艺术字不裁、不缩），而底下那几行提示仍然在", async () => {
    // ⚠️ 窄到装不下 {@link LOGO_WIDTH} 列：截断的 ASCII 艺术字比没有更糟
    const lines = await renderFrame(props({ ...empty, columns: SIDEBAR + SIDEBAR_GAP + LOGO_WIDTH - 1 }));
    const joined = lines.join("\n");
    expect(joined).not.toContain(LOGO[0]!.text);
    // ⚠️ 提示**会被裁**（`ellipsis` 到那一屏的宽度），故判据取它**必然还在**的那个开头 ——
    // 「提示整句都在」在这种窄屏上恒假，而那与「提示没了」长得一样
    expect(joined).toContain("左边点一个会");
  });

  it("⚠️ 上色时**逐行一色**（六档渐变自上而下），不上色时一个字都不上色", async () => {
    const colored = await renderRaw(props({ ...empty, color: true }));
    const row = colored.findIndex((line) => line.includes(LOGO[0]!.text));
    expect(row).toBeGreaterThanOrEqual(0);
    const at = indexOfText(colored[row] as string, LOGO[0]!.text);
    expect(sgrColorAt(colored[row] as string, at, "fg")).toBe(fgSgrOf(LOGO[0]!.color));
    const plain = await renderRaw(props(empty));
    const plainRow = plain.findIndex((line) => line.includes(LOGO[0]!.text));
    const plainAt = indexOfText(plain[plainRow] as string, LOGO[0]!.text);
    expect(sgrColorAt(plain[plainRow] as string, plainAt, "fg")).toBeNull();
  });
});
