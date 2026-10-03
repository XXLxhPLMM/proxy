/**
 * @fileoverview 键位分派（`useInput` 的那**一个**回调）
 * @module app/use-keyboard
 * @description
 * ⚠️ 窗口开着时它是**模态**：除 `Esc` / `↑↓` / `Tab` / `Enter` 之外**全部被吃掉**（含可打印文本）
 * —— 否则操作者在看不见输入结果的情况下敲出一串命令，而回车会把它们全部执行。
 *
 * ⚠️ `Ctrl+C` **到不了这里**：Ink 在把输入交给任何监听器**之前**就自己处理了它，故本层**不该**再
 * 实现一遍 —— 代价不是「重复退出」，是「两处退出路径的收尾次序可能不一致」。
 *
 * ⚠️ `↑`/`↓` **不移动光标**（输入折行了也不移）：给折行再加一套上下移动键，就得回答「光标在第一行
 * 时按 ↑ 是移到上一行还是切会话」，而那会让同一个键在两种屏上有两种意思（面板开着时 `↑`/`↓` 已经
 * 归面板了）。命令行里没必要在多行之间移动光标：`←` 能走到头，走到头再换行。
 */

import { useInput } from "ink";

import { complete, type Palette } from "@/cmd/index.js";
import type { Target } from "@/ledger/index.js";
import { isMouseReport } from "@/terminal/index.js";

import { caretLeft, caretRight, deleteAt, deleteBefore, insertAt, printableOnly } from "./input-line.js";
import { SCROLL_STEP, type CaretActive, type EditActive, type FillActive, type WindowKind } from "./state.js";

interface KeyboardDeps {
  readonly windowKind: WindowKind;
  readonly closeWindow: () => void;
  readonly moveWindow: (step: 1 | -1) => void;
  readonly pickWindow: () => void;
  readonly stepSession: (step: 1 | -1) => void;
  readonly scrollBy: (delta: number) => void;
  readonly scrollTo: (where: "top" | "bottom") => void;
  readonly movePalette: (step: 1 | -1) => void;
  readonly acceptPalette: () => { line: string; cursor: number } | null;
  readonly palette: Palette;
  readonly targets: readonly Target[];
  readonly input: string;
  readonly cursor: number;
  readonly editActive: EditActive;
  readonly caretActive: CaretActive;
  readonly fillActive: FillActive;
  readonly submit: (raw: string) => void;
}

export function useKeyboard(deps: KeyboardDeps): void {
  const {
    windowKind,
    closeWindow,
    moveWindow,
    pickWindow,
    stepSession,
    scrollBy,
    scrollTo,
    movePalette,
    acceptPalette,
    palette,
    targets,
    input,
    cursor,
    editActive,
    caretActive,
    fillActive,
    submit,
  } = deps;

  // ⚠️ 依赖是**逐项**取的而不是整个 `deps` 对象：`useInput` 自己按 handler 身份重订阅，故这里
  // 只要求「读的每一项都是最新一帧的那个」。
  useInput((pressed, key) => {
    // ⚠️ **第一道闸，也是唯一能挡住鼠标报告的那一道**：Ink 会把**未解析**的转义序列原样交给本
    // 回调，而它**顺手砍掉了那个 ESC**，于是报文到这里已经是 `[<35;64;32M` —— 一串全是可打印
    // 字符的协议报文。⚠️ 它必须在**最前面**。（另半道在 `./input-line.js`。）
    if (isMouseReport(pressed)) return;
    if (windowKind !== null) {
      if (key.escape) {
        closeWindow();
        return;
      }
      if (key.upArrow) {
        moveWindow(-1);
        return;
      }
      if (key.downArrow || key.tab) {
        moveWindow(1);
        return;
      }
      if (key.return) {
        pickWindow();
        return;
      }
      return;
    }
    if (key.ctrl || key.meta) {
      const lower = pressed.toLowerCase();
      if (lower === "n") {
        stepSession(1);
        return;
      }
      if (lower === "p") {
        stepSession(-1);
        return;
      }
      if (key.home) {
        scrollTo("top");
        return;
      }
      if (key.end) {
        scrollTo("bottom");
        return;
      }
      if (key.pageUp) {
        scrollBy(-SCROLL_STEP);
        return;
      }
      if (key.pageDown) {
        scrollBy(SCROLL_STEP);
        return;
      }
      // ⚠️ 其余 Ctrl 组合**什么都不做**
      return;
    }
    if (key.pageUp) {
      scrollBy(-SCROLL_STEP);
      return;
    }
    if (key.pageDown) {
      scrollBy(SCROLL_STEP);
      return;
    }
    if (key.upArrow) {
      if (palette.open) {
        movePalette(-1);
        return;
      }
      stepSession(-1);
      return;
    }
    if (key.downArrow) {
      if (palette.open) {
        movePalette(1);
        return;
      }
      stepSession(1);
      return;
    }
    if (key.leftArrow) {
      caretActive(caretLeft);
      return;
    }
    if (key.rightArrow) {
      caretActive(caretRight);
      return;
    }
    if (key.home) {
      caretActive(() => 0);
      return;
    }
    if (key.end) {
      caretActive((text) => text.length);
      return;
    }
    if (key.backspace || key.delete) {
      editActive((text, at) => (key.delete ? deleteAt(text, at) : deleteBefore(text, at)));
      return;
    }
    if (key.tab) {
      // ⚠️ **面板开着时 Tab 补的是高亮那一行**，而不是 `complete` 挑的「字典序第一个」：
      // 两条规则给同一次按键两个答案时，「Tab 填进去的」与「面板高亮的」会差一行。
      const accept = acceptPalette();
      if (accept !== null) {
        fillActive({ input: accept.line, cursor: accept.cursor });
        return;
      }
      const suggestion = complete({
        line: input,
        cursor,
        targetNames: targets.map((one) => one.name),
      });
      if (suggestion.candidates.length === 0) return;
      fillActive({ input: suggestion.line, cursor: suggestion.cursor });
      return;
    }
    if (key.return) {
      // ⚠️ **Enter 不接受面板的高亮**：它提交的是输入行**逐字**那一串。
      submit(input);
      return;
    }
    if (key.escape) {
      fillActive({ input: "", cursor: 0 });
      return;
    }
    // ⚠️ 最后一档：**可打印的文本**（C0 在这里被剔掉，见 `./input-line.js`）
    const typed = printableOnly(pressed);
    if (typed === "") return;
    editActive((text, at) => insertAt(text, at, typed));
  });
}
