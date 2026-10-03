/**
 * @fileoverview 键位分派（`useInput` 的那一个回调）：窗口开着时是模态，除 `Esc`/`↑↓`/`Tab`/`Enter` 全被吃掉
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
  /** 关掉**当前**会话（`Ctrl+X`；与侧边栏那枚「✕」是同一个入口，鼠标不可用的终端上只留鼠标那一路就关不掉） */
  readonly closeActiveSession: () => void;
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
    closeActiveSession,
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

  // ⚠️ 依赖逐项取（`useInput` 按 handler 身份重订阅）：只要求「读的每一项都是最新一帧的那个」
  useInput((pressed, key) => {
    // ⚠️ 第一道闸，唯一挡得住鼠标报告的那道：Ink 砍掉 ESC 后报文到这里全可打印，故必须在最前面
    // （另一道在 `./input-line.js` 剔 C0；它挡不住已认领的报文）
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
    // ⚠️ `Ctrl+C` 到不了这里（Ink 自己先处理了它），故本层不实现它
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
      if (lower === "x") {
        closeActiveSession();
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
    // ⚠️ `↑`/`↓` 不移动光标（输入折行了也不移）：面板开着时它们已经归面板了
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
      // ⚠️ Tab 补的是面板高亮那一行（否则「填进去的」与「高亮的」差一行）
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
    // ⚠️ 最后一档：可打印文本（C0 与 `DEL` 在这里被剔掉，见 `./input-line.js`）
    const typed = printableOnly(pressed);
    if (typed === "") return;
    editActive((text, at) => insertAt(text, at, typed));
  });
}
