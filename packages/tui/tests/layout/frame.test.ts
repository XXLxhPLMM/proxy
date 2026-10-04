/**
 * 整屏的**框**：每一行的显示宽度上限、整屏唯一那个圆角框、输入框随折行长高，以及框外那一行状态。
 *
 * @description
 * 这一档量两件**只在真渲染里看得见**的事：**Ink 对过宽的 `<Text>` 是静默软换行**（一换行后面所有行
 * 都往下移、边框随之错位），以及**框的高度是几何层按折行数给的、而画面上是 Ink 按它自己的布局画的**
 * —— 两者不一致的症状是「输入串第二行跑到框外面去了」。
 *
 * ⚠️ 判据一律量**显示宽度**（`stringWidth`）而不是 `String.length`：中文名的显示宽度是 ASCII 的两倍，
 * 纯 ASCII 的用例对「按 length 算」与「按显示宽度算」两种实现**零鉴别力**。
 *
 * 两条不变量的完整说明、探测器自检与变异实测表见本目录 `AGENTS.md`。
 *
 * @module tests/layout
 */

import { describe, expect, it, vi } from "vitest";

// ⚠️ 必须在 ink（因而 chalk）被 import 之前设好，否则每一档的着色判据恒为「没有序列」—— 见 `AGENTS.md`
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import stringWidth from "string-width";
import { geometry } from "@/lib/geometry.js";
import { flatten } from "@/lib/log/index.js";
import {
  COLUMNS,
  entryOf,
  geoInput,
  noteRow,
  props,
  renderFrame,
  renderRaw,
  renderScreen,
  stripAnsi,
} from "./_harness.js";
import { rowOf, screenRowOf, sidebarColumn } from "./_probe.js";

describe("不变量 ①：任何一行的显示宽度都不许超过终端列数", () => {
  it("侧边栏里有一个**超长中文会话名**时，每一行仍然等宽", async () => {
    // ⚠️ 名字刻意是**中文**：ASCII 名的显示宽度等于 `String.length`，而中文是两倍，
    // 所以一个纯 ASCII 的用例会同时通过「按 length 算」与「按显示宽度算」两种实现 ——
    // 那样的用例对这条判据**零鉴别力**。
    const lines = await renderFrame(
      props({
        sessions: [
          { id: "s1", name: "会话 1", manager: "live-ok", run: "idle" },
          { id: "s2", name: "一个非常非常非常长的会话名字", manager: "一个非常长的控制面名字", run: "idle" },
        ],
      }),
    );
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(COLUMNS);
    // 截断必须带省略标记（`ellipsis` 的契约）：被切掉的半个名字读不出来
    expect(sidebarColumn(lines).some((line) => line.includes("…"))).toBe(true);
  });

  it("⚠️ 整屏**只有输入框**有框：侧边栏与主区都**没有竖线**", async () => {
    const lines = await renderFrame(props());
    const framed = lines.filter((line) => /[╭╰│]/u.test(stripAnsi(line)));
    // ⚠️ **反向自检**：输入框**确实有**框（上下框 2 + 框内「输入行 + 消息」2 = 4 行）
    expect(framed.length).toBeGreaterThanOrEqual(4);
    expect(framed[0]).toContain("╭");
    expect(framed[framed.length - 1]).toContain("╰");
    // ⚠️ 而框**只在底部**：结果区与侧边栏那几行一个框字符都没有
    const unframed = lines.filter((line) => !/[╭╰│]/u.test(stripAnsi(line)));
    expect(unframed.length).toBeGreaterThan(0);
    for (const line of unframed) expect(line).not.toMatch(/[│╭╰]/u);
  });

  it("结果区里一段很长的散文会**换行**而不是把框顶歪", async () => {
    const long = "这是一段刻意写得很长的说明文字".repeat(12);
    const flat = flatten(
      [entryOf([noteRow(long)])],
      geometry(geoInput(props())).outputWidth,
    );
    const lines = await renderFrame(props({ flat, top: 0 }));
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(COLUMNS);
    expect(lines.filter((line) => line.includes("这是一段")).length).toBeGreaterThan(1);
  });
});

describe("不变量 ④：输入框随折行长高；状态行在框**外**且不含链接", () => {
  it("输入串折成几行，框就多几行（每一行都不越出终端宽度）", async () => {
    const short = await renderFrame(props({ input: "/status" }));
    const long = await renderFrame(
      props({
        input: "/target add live http://10.0.0.9:18080 0123456789abcdef0123456789abcdef 5000",
      }),
    );
    for (const set of [short, long]) {
      for (const line of set) expect(stringWidth(line)).toBeLessThanOrEqual(COLUMNS);
    }
    // 折行的那一档：框**更高**（上边框出现在更靠上的一行）
    const gShort = geometry(geoInput(props({ input: "/status" })));
    const gLong = geometry(
      geoInput(
        props({
          input: "/target add live http://10.0.0.9:18080 0123456789abcdef0123456789abcdef 5000",
        }),
      ),
    );
    expect(gLong.inputRows).toBeGreaterThan(gShort.inputRows);
    expect(gLong.input!.y).toBeLessThan(gShort.input!.y);
  });

  it("折出来的每一行都在**框内**（第二行不跑到框外）", async () => {
    const input = "/target add live http://10.0.0.9:18080 0123456789abcdef0123456789abcdef 5000";
    const p = props({ input });
    const lines = await renderScreen(p);
    const g = geometry(geoInput(p));
    const top = screenRowOf(lines, "╭");
    const bottom = screenRowOf(lines, "╰");
    expect(g.inputRows).toBeGreaterThan(1);
    // 折出来的那些字符必须**落在框内那几行里**
    const fragment = input.slice(0, 20);
    const at = screenRowOf(lines, fragment);
    expect(at).toBeGreaterThan(top);
    expect(at).toBeLessThan(bottom);
  });

  it("提示符只在第一行；续行与第一行的字**左对齐**（悬挂缩进）", async () => {
    const p = props({
      input: `/user pass charlie ${"汉字".repeat(20)}`,
    });
    const raw = await renderRaw(p);
    const g = geometry(geoInput(p));
    expect(g.inputRows).toBeGreaterThan(1);
    const promptRow = raw[g.inputTextRows[0]!.y] ?? "";
    const secondRow = raw[g.inputTextRows[1]!.y] ?? "";
    // 第 0 行有 `❯ `，第 1 行没有 —— 而两行的第一个字落在**同一列**
    expect(stripAnsi(promptRow)).toContain("❯");
    expect(stripAnsi(secondRow)).not.toContain("❯");
    expect(g.inputTextRows[0]!.x).toBe(g.inputTextRows[1]!.x);
  });

  it("状态行在框**外**：它比上边框更靠下，而它那几行不在框内", async () => {
    const p = props();
    const lines = await renderFrame(p);
    const g = geometry(geoInput(p));
    expect(g.statusLine!.y).toBeGreaterThan(g.input!.y + g.input!.height - 1);
    // 状态行是**最底**那一行
    const bottom = rowOf(lines, "╰");
    expect(g.statusLine!.y).toBeGreaterThan(bottom);
    // ⚠️ **渲染出来的那一行 == 几何给的 y**：只断言几何值的话，一个把状态行画在别的行的
    // 实现照样全绿（几何与绘制是两条路，而这一条量的正是「绘制有没有跟着几何走」）
    const screen = await renderScreen(p);
    expect(screenRowOf(screen, "● 2")).toBe(g.statusLine!.y);
    expect(screenRowOf(screen, "╰")).toBe(g.statusLine!.y - 1);
  });

  it("状态行左半是各状态的台数（各自上色），右半是版本号", async () => {
    const p = props({ version: "5.2.0", managerStates: ["connected", "connected", "unauthorized"] });
    const lines = await renderFrame(p);
    const last = lines[lines.length - 1] ?? "";
    // `● 2` 与 `▲ 1`（各状态一个字形 + 它的台数），而版本号在右半
    expect(last).toContain("● 2");
    expect(last).toContain("▲ 1");
    expect(last).toContain("v5.2.0");
  });

  it("台数为空时那一句**也没有链接**（零台那一档走的就是它）", async () => {
    const lines = await renderFrame(props({ managerStates: [], version: "5.2.0" }));
    const last = lines[lines.length - 1] ?? "";
    expect(last).toContain("台账里没有控制面");
    expect(last).not.toContain("http");
  });

  it("窄到放不下时那句 fallback 里也没有链接", async () => {
    const p = props({
      columns: 60,
      sidebarWidth: 20,
      managerStates: ["connected", "unauthorized", "unreachable", "connecting", "unknown"],
      version: "5.2.0",
    });
    const lines = await renderFrame(p);
    const last = lines[lines.length - 1] ?? "";
    expect(last).not.toContain("http");
  });

  it("状态行**不显示链接**（链接在 /managers 窗口里）", async () => {
    const lines = await renderFrame(
      props({ sessions: [{ id: "s1", name: "会话 1", manager: "http://10.0.0.9:18080", run: "idle" }] }),
    );
    const last = lines[lines.length - 1] ?? "";
    expect(last).not.toContain("http://");
  });

  it("零台的那些状态档**不出现**（一个恒为 0 的「连接中 0」只占地方）", async () => {
    const lines = await renderFrame(props({ managerStates: ["connected", "connected"] }));
    const last = lines[lines.length - 1] ?? "";
    expect(last).toContain("● 2");
    expect(last).not.toContain("◌");
    expect(last).not.toContain("▲");
  });

  it("一个控制面都没有时说一句人话（空行与「忘了画」在屏上同形）", async () => {
    const lines = await renderFrame(props({ managerStates: [] }));
    expect(lines[lines.length - 1]).toContain("台账里没有控制面");
  });
});
