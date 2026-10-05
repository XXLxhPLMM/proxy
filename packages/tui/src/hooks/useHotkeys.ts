/**
 * @fileoverview 键位分派（`useInput` 的那一个回调）：改名框开着时它归改名框，其次是模态窗口，其次是菜单，其余才是输入行
 */
/** ⚠️ 档位次序即优先级：改名框（框里那串字）→ 弹窗（模态）→ 菜单（浮层）→ 输入行 */

import { useInput } from "ink";

import { complete, enterOutcomeOf, type Palette } from "@/commands/index.js";
import type { Target } from "@/services/config/index.js";
import { isMouseReport } from "@/services/terminal/index.js";

import {
  caretLeft,
  caretRight,
  deleteAt,
  deleteBefore,
  insertAt,
  printableOnly,
} from "@/lib/index.js";
import {
  SCROLL_STEP,
  type CaretActive,
  type EditActive,
  type FillActive,
  type WindowKind,
} from "@/store/index.js";

interface KeyboardDeps {
  /** 改名框开着吗（⚠️ **排在窗口之前**：它是「此刻敲的字去了哪儿」这件事，而模态窗口只是浮在上面） */
  readonly renaming: boolean;
  readonly confirmRename: () => void;
  readonly cancelRename: () => void;
  /** 菜单开着吗（⚠️ 菜单是**浮层**而不是模态：关掉它只要一次 `Esc`，而 `↑↓`/`Enter` 走菜单） */
  readonly menuOpen: boolean;
  readonly moveMenu: (step: 1 | -1) => void;
  readonly pickMenu: () => void;
  readonly closeMenu: () => void;
  readonly windowKind: WindowKind;
  readonly closeWindow: () => void;
  readonly moveWindow: (step: 1 | -1) => void;
  readonly pickWindow: () => void;
  /** 永久删除高亮那一行（**只在历史会话弹窗里**；⚠️ 它与「从侧边栏移除」是两件事，见状态层那两个回调） */
  readonly deleteWindowRow: () => void;
  /** 给高亮那一行开改名框（**只在历史会话弹窗里**） */
  readonly renameWindowRow: () => void;
  readonly stepSession: (step: 1 | -1) => void;
  /** 把**当前**会话从侧边栏上移出（`Ctrl+X`；⚠️ 与「✕」/菜单那一项同一入口，且**不是**「删掉」） */
  readonly detachActiveSession: () => void;
  /** 给**当前**会话改名（`Ctrl+R`；与 `/rename`、菜单里的「重命名」同一个入口） */
  readonly renameActiveSession: () => void;
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

export function useHotkeys(deps: KeyboardDeps): void {
  const {
    renaming,
    confirmRename,
    cancelRename,
    menuOpen,
    moveMenu,
    pickMenu,
    closeMenu,
    windowKind,
    closeWindow,
    moveWindow,
    pickWindow,
    deleteWindowRow,
    renameWindowRow,
    stepSession,
    detachActiveSession,
    renameActiveSession,
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
    // （另一道在 `@/lib/input-line.js` 剔 C0；它挡不住已认领的报文）
    if (isMouseReport(pressed)) return;
    // ⚠️ **改名框那一支排在最前面**：它接管「敲字 / 移动 / 退格」这一整族，而漏判的后果是
    // 「会话名里混进了 `q`」与「`Enter` 把它当成一条命令跑了」—— 两个都在屏上看着像另一件事坏了。
    if (renaming) {
      if (key.escape) {
        cancelRename();
        return;
      }
      if (key.return) {
        confirmRename();
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
      // ⚠️ **`Ctrl+C` / `Ctrl+X` 等一切组合在改名框里什么都不做**：它们是输入行的快捷键，而此刻输入行
      // 里装的是**会话名**，按了它等于删掉半个名字而屏上没有任何解释
      if (key.ctrl || key.meta) return;
      const typed = printableOnly(pressed);
      if (typed === "") return;
      editActive((text, at) => insertAt(text, at, typed));
      return;
    }
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
      // ⚠️ **除下面两键之外，弹窗开着时其余每一个键都被吃掉** —— 面板候选、结果区滚动、当前会话
      // 全在遮罩背后，而它们的作用对象此刻一格都不许动（症状是「面板照滚照亮，操作者以为滚轮坏了」）。
      if (key.ctrl || key.meta) {
        const lower = pressed.toLowerCase();
        // ⚠️ **只有历史会话弹窗**有这两档：控制面清单里没有「会话」这一行可删可改名，
        // 而 `Ctrl+D` 漏到输入行去没有绑定、`Ctrl+R` 漏出去会弹出改名框吃掉接下来敲的每一个字。
        if (windowKind === "sessions") {
          if (lower === "d") {
            deleteWindowRow();
            return;
          }
          if (lower === "r") {
            renameWindowRow();
            return;
          }
        }
      }
      return;
    }
    // ⚠️ 菜单**不是模态**：`Esc` 只是把它收掉，背后那一层的输入照旧走下面那些判据
    if (menuOpen) {
      if (key.escape) {
        closeMenu();
        return;
      }
      if (key.upArrow) {
        moveMenu(-1);
        return;
      }
      if (key.downArrow) {
        moveMenu(1);
        return;
      }
      if (key.return) {
        pickMenu();
        return;
      }
    }
    // ⚠️ `exitOnCtrlC: false` ⇒ Ink 的两道门（`App.js:151` / `use-input.js:104`）**两道都不生效**，
    // 故 `Ctrl+C` **原样落到本层**；本层**刻意什么都不做** —— 退出只经 `/exit` 与 `/quit`
    // （牙齿：`tests/input/exit.test.ts` 那一条「喂 `Ctrl+C` 屏上零变化」）
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
        detachActiveSession();
        return;
      }
      // ⚠️ `Ctrl+R` 是「重探当前控制面」的 `/r` 那一条**故意让开**的那一格：两者同键的话
      // 「刷新一下」与「改个名字」会按同一个键，而后者会弹一个框吃掉接下来敲的每一个字
      if (lower === "r") {
        renameActiveSession();
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
      // ⚠️ **判据只有一条而它不在本层**：`enterOutcomeOf` 答「接受面板高亮会不会改变输入行那一串」——
      // 一律接受的话 `/help` 变成「按了没反应」（高亮就是它自己），一律提交的话敲半条命令就没法补。
      const outcome = enterOutcomeOf(input, cursor);
      if (outcome.kind === "fill") {
        fillActive({ input: outcome.line, cursor: outcome.cursor });
        return;
      }
      submit(input);
      return;
    }
    if (key.escape) {
      fillActive({ input: "", cursor: 0 });
      return;
    }
    // ⚠️ 最后一档：可打印文本（C0 与 `DEL` 在这里被剔掉，见 `@/lib/input-line.js`）
    const typed = printableOnly(pressed);
    if (typed === "") return;
    editActive((text, at) => insertAt(text, at, typed));
  });
}
