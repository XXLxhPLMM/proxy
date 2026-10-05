/**
 * 需求 7 §5.2：「提供商 · 推理强度」那一行在**输入框框外**、底部状态行之上，
 * 两段各有各的色档，而「没选模型」是一个**中性档**的「未选择」。
 *
 * @description
 * ⚠️ 这一档量三件**屏上看着没毛病、其实错了**的事：① 那一行是不是画在几何给的那一行上
 * （夹进框内的话它与输入串抢同一行）；② 两段是不是**两档不同**（同色的话「问话发去哪」与
 * 「这一次的推理强度」在屏上读起来是同一件事）；③ **竖直对齐**（它与输入框里的字差着两列的话
 * 「这是同一次输入的说明」这个形状就没了）。
 *
 * @module tests/render
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// ⚠️ 必须在 ink（因而 chalk）被 import 之前设好，否则着色判据恒为「没有序列」—— 见本目录 `AGENTS.md`
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

import { PROMPT_COLUMNS, geometry } from "@/lib/geometry.js";
import { themeOf, toneColor, type Theme } from "@/theme/index.js";
import {
  columnOfIndex,
  fgSgrOf,
  geoInput,
  indexOfText,
  props,
  renderRaw,
  renderScreen,
  sgrColorAt,
} from "./_harness.js";

/** **不盖遮罩**时的那份主题（那一行在框外，而框吃的就是这个主题） */
const card = (): Theme => themeOf({ color: true, scrimmed: false });

/** 那一行上某个词的显示列（`-1` = 没找到） */
function columnOfWord(line: string, word: string): number {
  const at = indexOfText(line, word);
  return at < 0 ? -1 : columnOfIndex(line, at);
}

/** 只留**代码**（剔整行 `//` 与 `/* … *\/` 块注释；与 `tests/contract` 那一族同一套纪律） */
// ⚠️ 不剔的话注释里提一句 `warn` 就会让「不许有那一档」恒红，而那种失守看着像「实现变了」
function codeOnly(text: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split(/\r?\n/u)) {
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
  return out.join("\n");
}

describe("需求 7 §5.2：「提供商 · 推理强度」那一行", () => {
  it("⚠️ 三段**各有各的色档**，而提供商名与推理强度**读自己那一份**", async () => {
    const p = props({ color: true, modelStatus: { provider: "OpenRouter", reasoning: "high" } });
    const g = geometry(geoInput(p));
    expect(g.modelStatus).not.toBeNull();
    const raw = await renderRaw(p);
    const line = raw[g.modelStatus!.y] ?? "";
    const theme = card();
    // ⚠️ **先自检**：探针给 `-1` 时 `sgrColorAt` 恒给 `null`，而「`null` ≠ 那个色」恒成立
    const providerAt = columnOfWord(line, "OpenRouter");
    const dotAt = columnOfWord(line, "·");
    const effortAt = columnOfWord(line, "high");
    expect(providerAt).toBeGreaterThanOrEqual(0);
    expect(dotAt).toBeGreaterThanOrEqual(0);
    expect(effortAt).toBeGreaterThan(providerAt);
    // ⚠️ **期望值取的是主题里那几档**：呈现层不许自己挑颜色，而「挑了另一档」在屏上只是「字浅一点」
    expect(sgrColorAt(line, indexOfText(line, "OpenRouter"), "fg")).toBe(
      fgSgrOf(toneColor("muted", theme)!),
    );
    expect(sgrColorAt(line, indexOfText(line, "·"), "fg")).toBe(fgSgrOf(toneColor("idle", theme)!));
    expect(sgrColorAt(line, indexOfText(line, "high"), "fg")).toBe(
      fgSgrOf(toneColor("reasoning", theme)!),
    );
    // ⚠️ 而**三档真的两两不同**（`reasoning` 与 `warn` 同值，而那一行没有 `warn` 在场）
    // ⚠️ 判的是**屏上量到的那三个值**而不是主题表：查表的话「呈现层挑了另一档」会照样绿。
    const seen = new Set([
      sgrColorAt(line, indexOfText(line, "OpenRouter"), "fg"),
      sgrColorAt(line, indexOfText(line, "·"), "fg"),
      sgrColorAt(line, indexOfText(line, "high"), "fg"),
    ]);
    expect(seen.size).toBe(3);
  });

  // ⚠️ **`reasoning` 与 `warn` 在三张表里逐字同值**（见 `@/theme/AGENTS.md`：那是两处语境里的两个语义）
  // ⇒ 判「推理强度那一段读的是哪一档」**不能靠颜色**。故这一档从**源码现取**那一档名：
  // 拿常量当判据的话「换一档」与「改常量」同时发生 ⇒ 恒绿；而点名一个已删的符号则永远绿。
  it("⚠️ **推理强度那一段读的是 `reasoning` 那一档**（它与 `warn` 同值 ⇒ 判据只能从源码取）", () => {
    expect(toneColor("reasoning", card())).toBe(toneColor("warn", card()));
    const file = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "src",
      "features",
      "chat",
      "ModelStatusLine.tsx",
    );
    const code = codeOnly(readFileSync(file, "utf8"));
    // ⚠️ **正向对照**：探测器今天真的取得到那一行（取不到的话下面那两条恒真）
    expect(code).toContain("tone(theme, ");
    expect(code).toContain('tone(theme, "reasoning")');
    expect(code).not.toContain('tone(theme, "warn")');
    // ⚠️ 而「提供商名」那一档**也**读自己的那一档（浅灰）—— 没选模型时才是中性档
    expect(code).toContain('tone(theme, chosen ? "muted" : "idle")');
  });

  it("⚠️ **没选模型**时显示「未选择」而它是**中性档**（它答的是「这一格还没有值」）", async () => {
    const p = props({ color: true, modelStatus: { provider: null, reasoning: "medium" } });
    const g = geometry(geoInput(p));
    const raw = await renderRaw(p);
    const line = raw[g.modelStatus!.y] ?? "";
    const at = columnOfWord(line, "未选择");
    // ⚠️ **反向自检**：同一帧里**推理强度那一段还在**（它恒有一档，而「没选模型」不是「这一行没有东西」）
    expect(at).toBeGreaterThanOrEqual(0);
    expect(columnOfWord(line, "medium")).toBeGreaterThan(at);
    expect(sgrColorAt(line, indexOfText(line, "未选择"), "fg")).toBe(fgSgrOf(toneColor("idle", card())!));
  });

  it("⚠️ 那一行画在**几何给的那一行**上，且它的字与输入框里的字**竖直对齐**", async () => {
    const p = props({ color: true, input: "/targets", cursor: 8, modelStatus: { provider: "P1", reasoning: "low" } });
    const g = geometry(geoInput(p));
    const raw = await renderRaw(p);
    const statusLine = raw[g.modelStatus!.y] ?? "";
    const inputLine = raw[g.inputTextRows[0]!.y] ?? "";
    // ⚠️ **两个探针都先自检**：给 `-1` 时「两者相等」对两个 `-1` 恒成立
    const statusAt = columnOfWord(statusLine, "P1");
    const inputAt = columnOfWord(inputLine, "/targets");
    expect(statusAt).toBeGreaterThanOrEqual(0);
    expect(inputAt).toBeGreaterThanOrEqual(0);
    expect(statusAt).toBe(inputAt);
    // ⚠️ 而那一列**恒等于输入区那个悬挂缩进**（拿常量当期望值 ⇒ 改常量与改实现同时发生 ⇒ 恒绿）
    expect(PROMPT_COLUMNS).toBe(2);
    expect(inputAt).toBe(g.inputContent!.x + PROMPT_COLUMNS);
  });

  it("⚠️ 那一行在**框外**、**状态行之上**（框里那一格是「正在敲的东西」）", async () => {
    const p = props({ color: true, modelStatus: { provider: "P1", reasoning: "low" } });
    const g = geometry(geoInput(p));
    const screen = await renderScreen(p);
    // ⚠️ **渲染位置 == 几何给的 y**：只断言几何值的话，一个把那一行画在别处的实现照样全绿
    expect(g.modelStatus!.y).toBe(g.input!.y + g.input!.height);
    expect(g.statusLine!.y).toBe(g.modelStatus!.y + 1);
    expect(screen[g.input!.y + g.input!.height - 1]).toContain("╰");
    expect(screen[g.modelStatus!.y]).toContain("P1");
    expect(screen[g.statusLine!.y]).toContain("● 2");
  });

  it("⚠️ 极矮的屏上几何给 `null` ⇒ **整行不画**（先丢的是常驻信息而不是框里那一行）", async () => {
    // ⚠️ 屏矮到 5 行：输入区把「模型状态行 + 状态行」之外的全占了，于是 `modelStatus` 是 `null`
    const p = props({ color: true, rows: 5, modelStatus: { provider: "P1", reasoning: "low" } });
    expect(geometry(geoInput(p)).modelStatus).toBeNull();
    // ⚠️ 而屏上**一个字都没有**（判据落在「那一段文字」上，而不是「那一行的底色」）
    expect((await renderScreen(p)).join("\n")).not.toContain("P1");
  });
});