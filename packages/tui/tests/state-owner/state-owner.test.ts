/**
 * 「跨帧状态有且只有一个持有者」+「`@/store` 是零运行期依赖的纯形状层」（源码级）
 *
 * @description
 * **为什么这一档存在**：`@/store` 刻意只有形状与常量，而跨帧状态由 `@/AppState.tsx` 的 `useState` 持有 ——
 * 理由是「全包只有它一个消费者」（`@/store/AGENTS.md`）。⚠️ 而那句话**自己会腐烂**：长出第二个消费者时
 * 没有任何东西会响，于是「一个真相源」悄悄变成两个，而症状是「同一个事实有两处答案」——
 * 全屏零报错（两处都自洽，只有跨屏比对才发现它们说不同的话）。
 *
 * ## ⚠️ 判据 2 为什么按「零**值** import」写，而不是按「不许引某个库」写
 * @description
 * 「本目录不许装 zustand」是**技术锁定**：换一种实现同一个不变量就被误判成违规，于是下一个人会去改断言。
 * 真正的不变量是**依赖方向**——`@/store` 是纯形状层，故它只许 `import type` 与 barrel 的 `export … from`。
 * ⚠️ 而**任何**全局 store 都要一个**值**（store 工厂、React hook、事件发射器）—— 于是判据与库无关地把它逮住。
 *
 * ## ⚠️ 判据 1 的**已知缺口**（写出来是为了不让下一个人误以为它管得更宽）
 * @description
 * 一个 store **自己**不调 `useState` / `useRef`，故判据 1 逮不住「有人在本目录建了 store」——
 * 那是判据 2 的活。判据 1 管的是另一件事：**跨帧状态不许长出第二个持有者**（第二个组件开始自己存
 * `useState` 的那一刻）。⚠️ 而 `hooks/useTerminalSize.ts` 是**在白名单里**的：它存的是**终端宽高**，
 * 即一条外部事件源（`resize`）的镜像，而不是应用状态 —— 判据按「谁持有应用跨帧状态」列它。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(__dirname, "..", "..", "src");

/** `src/` 下全部源文件（⚠️ **列目录**而不是手写清单：新增文件自动进扫描面） */
function sources(): ReadonlyArray<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        out.push([relative(SRC_ROOT, full).split(sep).join("/"), readFileSync(full, "utf8")]);
      }
    }
  };
  walk(SRC_ROOT);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/**
 * 只留**代码**：整行 `//` 与 `/* … *\/` 块注释都剔掉
 * @description ⚠️ 逐行判（与 `tests/comment-budget/` 同一套纪律）而**不**做正则全局替换：
 * `no-control-regex` 会被触发，而**注释里提到 `useState` 就会把判据变成恒红**——
 * 那正是「探测器认错了东西」与「实现坏了」长得一样的那一类（判据自检那一档钉住它）。
 * ⚠️ 行尾 `//` 不剔（源码里有 `http://` 那样的字符串）：宁可误报也不误判成「不是持有者」。
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

/**
 * 这一份代码**调**了 `useState(` / `useRef(` 吗（持有跨帧状态的唯一可判形状）
 * @description ⚠️ **泛型调用那一份也得认**：`useState<TerminalSize>(initial)` 里 `(` 前面隔着
 * `<…>`，而本包真的有一处那么写（`hooks/useTerminalSize.ts`）。只匹配 `useState\s*\(` 的话它**恒不**被认出来，
 * 于是白名单里那一项形同虚设——而症状是「探测器坏了」与「实现变了」**长得一样**（自检那一档钉住它）。
 */
function holdsFrameState(text: string): boolean {
  return codeOnly(text).some((line) => /\buse(State|Ref)\s*(<[^<>()]*>)?\s*\(/.test(line));
}

/** 这一份代码有**值** import 吗（⚠️ 只认 import 语句那一行，故多行 import 的续行不算） */
function hasValueImport(text: string): boolean {
  return codeOnly(text).some((line) => /^\s*import\s+(?!type\b)/.test(line));
}

const SRC = sources();

describe("跨帧状态的持有者（源码级）", () => {
  describe("覆盖面与判据自检（防「探测器坏了 → 恒绿」）", () => {
    it("扫描面覆盖到本包源文件（含 `AppState.tsx` 与 `store/`）", () => {
      const names = SRC.map(([name]) => name);
      expect(names.length).toBeGreaterThanOrEqual(40);
      expect(names).toContain("AppState.tsx");
      expect(names).toContain("store/app-store.ts");
    });

    it("探测器认得出 `useState(` / `useRef(`，而认不出普通导出", () => {
      expect(holdsFrameState("const [a, setA] = useState(0);")).toBe(true);
      expect(holdsFrameState("const r = useRef<number | null>(null);")).toBe(true);
      // ⚠️ **泛型调用**（`(` 前面隔着 `<…>`）：本包真的有一处，不认它白名单那一项就形同虚设
      expect(holdsFrameState("const [size, setSize] = useState<TerminalSize>(initial);")).toBe(true);
      expect(holdsFrameState("export const LOG_KEEP = 2000;")).toBe(false);
      expect(holdsFrameState("export const f = () => setTimeout(() => {}, 8);")).toBe(false);
      // ⚠️ 而**只差一个字母**的名字不算（`setTimeout` / `useStates` 都不该被当成 `useState`）
      expect(holdsFrameState("export const useStates = 1;")).toBe(false);
    });

    it("⚠️ **注释里提到 `useState` 不算持有者**（否则注释一改判据就恒红）", () => {
      const commented = ["/**", " * 全部状态由 `useState(` 持有", " */", "export const x = 1;"].join("\n");
      expect(holdsFrameState(commented)).toBe(false);
      expect(holdsFrameState("// const [a, setA] = useState(0);")).toBe(false);
      // ⚠️ 而**真**代码里的那一行仍然认得出（防的是「把代码也当成注释」这种反向失守）
      expect(holdsFrameState(["// 见下", "const [a, setA] = useState(0);"].join("\n"))).toBe(true);
    });

    it("值 import 探测器认得出 store 工厂，而认不出 `import type` 与 barrel", () => {
      expect(hasValueImport('import { create } from "zustand";')).toBe(true);
      expect(hasValueImport('import { useState } from "react";')).toBe(true);
      expect(hasValueImport('import type { Session } from "@/store/index.js";')).toBe(false);
      expect(hasValueImport('export { newSession } from "./app-store.js";')).toBe(false);
    });
  });

  describe("1 判据：跨帧状态有且只有那一个持有者", () => {
    it("调 `useState` / `useRef` 的文件集合恒等于那两处", () => {
      // ⚠️ **`hooks/useTerminalSize.ts` 在白名单里**：它存的是终端宽高，即 `resize` 那条外部事件源的
      // 镜像（组合根给的是**初值**），不是应用状态。少列它这一档恒红，而多列任何一处都等于承认
      // 「同一个事实有两个持有者」。
      const expected = ["AppState.tsx", "hooks/useTerminalSize.ts"];
      const owners = SRC.filter(([, text]) => holdsFrameState(text)).map(([name]) => name);
      expect(
        owners,
        `跨帧状态的持有者变成了：\n${owners.join("\n")}\n\n` +
          "判据：`@/store/AGENTS.md` 那条不变量是「全包只有一个消费者，而它就是全局 store」。\n" +
          "长出第二个持有者时，先问「第二个组件为什么需要跨帧状态」——多数场合它要的是**呈现形状**，\n" +
          "而那一层已经有投影（`sessionRows` / `paletteView` / `windowRows` / `menuView`）。\n" +
          "真的需要第二个持有者时，改这一条**并**同时改 `@/store/AGENTS.md`，别让两者说不同的话。",
      ).toEqual(expected);
    });
  });

  describe("2 判据：`@/store` 是零运行期依赖的纯形状层（它没有 store，也不需要）", () => {
    it("`src/store/` 下一个**值** import 都没有", () => {
      const offenders = SRC.filter(([name]) => name.startsWith("store/"))
        .filter(([, text]) => hasValueImport(text))
        .map(([name]) => name);
      expect(
        offenders,
        `\`@/store\` 引了运行期依赖：\n${offenders.join("\n")}\n\n` +
          "判据：本目录只答「形状与常量」，故只许 `import type` 与 barrel 的 `export … from`。\n" +
          "⚠️ **不是**「不许用某个库」——真要跨帧状态，那是「长第二个持有者」那一条（判据 1）该响，\n" +
          "而它响之前先回答：为什么第二个组件需要它，而投影层给不了？",
      ).toEqual([]);
    });
  });
});