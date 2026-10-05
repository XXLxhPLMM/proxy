/**
 * @fileoverview 键位分派（`useInput` 的那一个回调）：**唯一**那一份优先级链
 */
// ⚠️ 档位次序即优先级：**弹窗内字段编辑 → 弹窗（列表）→ 会话菜单 → 输入行**
// ⚠️ 而**同一个弹窗**里又分两档：**表单**（键归框）与**清单**（键归高亮）—— 判据是
// `formOpen` 而不是「窗口开着」，于是那五个表单与七个清单各走各的那一族键。

import { useInput } from "ink";

import { complete, enterOutcomeOf, type Palette } from "@/commands/index.js";
import type { Target } from "@/services/config/index.js";
import { isMouseReport } from "@/services/terminal/index.js";

import {
  caretDown,
  caretLeft,
  caretRight,
  caretUp,
  deleteBefore,
  deleteSelection,
  historyNext,
  historyPrev,
  insertAt,
  insertNewline,
  normalizeSelection,
  printableOnly,
  replaceSelection,
  type HistoryStep,
} from "@/lib/index.js";
import { SCROLL_STEP, type CaretActive, type EditActive, type FillActive } from "@/store/index.js";

interface KeyboardDeps {
  /* 改名框（⚠️ 它**排在弹窗之前**：它是「此刻敲的字去了哪儿」这件事，而弹窗只是浮在上面） */
  readonly renaming: boolean;
  readonly confirmRename: () => void;
  readonly cancelRename: () => void;

  /* 会话菜单（⚠️ 菜单是**浮层**而不是模态：关掉它只要一次 `Esc`，而 `↑↓`/`Enter` 走菜单） */
  readonly menuOpen: boolean;
  readonly moveMenu: (step: 1 | -1) => void;
  readonly pickMenu: () => void;
  readonly closeMenu: () => void;

  /* 弹窗（⚠️ `modalOpen` 与 `formOpen` 分开答，而那一族键的分派靠的就是这一对） */
  readonly modalOpen: boolean;
  readonly formOpen: boolean;

  /* 此刻聚焦的那个文本框（⚠️ **`textTarget === null` = 没有聚焦的框**，于是本层不必自己猜） */
  readonly textTarget: string | null;
  readonly textValue: string;
  readonly textCursor: number;
  /** 当前那一格是不是下拉（⚠️ `null` = 文本框，而下拉的档位就是 `↑↓` 换的那几档） */
  readonly textOptions: readonly string[] | null;
  readonly editText: EditActive;
  readonly caretText: CaretActive;
  /** 改**过滤框**（⚠️ 与那三个写入口分开：它属于弹窗而不是某个框，而它**只影响显示**） */
  readonly editFilter: EditActive;

  /* 表单那一族（⚠️ **`Tab` 恒在字段之间走**，而 `↑↓` 只在下拉那一格换档） */
  readonly fieldTab: (step: 1 | -1) => void;
  readonly fieldArrow: (step: 1 | -1) => void;
  readonly submitForm: () => void;

  /* 弹窗那一族（⚠️ **每一条都转调状态层同一个入口**，而「这一族归不归弹窗」由 `kind` 答） */
  readonly escapeModal: () => void;
  readonly moveModalRow: (step: 1 | -1) => void;
  readonly acceptModal: () => void;
  readonly addModalRow: () => void;
  readonly removeModalRow: () => void;
  readonly editModalRow: () => void;
  readonly modelsOfProvider: () => void;
  readonly fetchModels: () => void;
  readonly togglePin: () => void;
  readonly cycleReasoning: () => void;
  readonly setPassword: () => void;
  readonly toggleCheck: () => void;
  /** 弹窗里的 `Ctrl+R`（⚠️ 判据是 `kind` 而不是「窗口开着」：两档上是两件事） */
  readonly ctrlR: () => void;

  /* 会话与结果区 */
  readonly stepSession: (step: 1 | -1) => void;
  readonly detachActiveSession: () => void;
  readonly renameActiveSession: () => void;
  readonly scrollBy: (delta: number) => void;
  readonly scrollTo: (where: "top" | "bottom") => void;
  readonly movePalette: (step: 1 | -1) => void;
  readonly acceptPalette: () => { line: string; cursor: number } | null;
  readonly palette: Palette;

  /* 输入行 */
  readonly targets: readonly Target[];
  readonly input: string;
  readonly cursor: number;
  /** 输入区折行用的显示列（⚠️ 取几何给的那一格宽度 —— 本层不许自己算列） */
  readonly textWidth: number;
  /** 输入历史（⚠️ **跨会话共享**的一份，最新在末尾；`null` 那一档不在历史里） */
  readonly historyEntries: readonly string[];
  readonly historyAt: number;
  readonly editActive: EditActive;
  readonly caretActive: CaretActive;
  readonly fillActive: FillActive;
  /** 从命令历史里填一行（⚠️ 与 {@link fillActive} 分开：它还得记下「正停在第几条」） */
  readonly fillHistory: (step: HistoryStep) => void;
  readonly submit: (raw: string) => void;
}

/** 那一族「移动插入符」的判据（⚠️ **不带 Shift 的移动要清空选区** —— 那就是 `anchor` 变 `null`） */
function shiftOf(key: { readonly shift?: boolean }): boolean {
  return key.shift === true;
}

export function useHotkeys(deps: KeyboardDeps): void {
  // ⚠️ 依赖逐项取（`useInput` 按 handler 身份重订阅）：只要求「读的每一项都是最新一帧的那个」
  useInput((pressed, key) => {
    // ⚠️ 第一道闸，唯一挡得住鼠标报告的那道：Ink 砍掉 ESC 后报文到这里全可打印，故必须在最前面
    if (isMouseReport(pressed)) return;

    /* ── ① 改名框（`Esc` 关框、`Enter` 确认、其余归框） ──────────────────────── */
    if (deps.renaming) {
      if (key.escape) {
        deps.cancelRename();
        return;
      }
      if (key.return) {
        deps.confirmRename();
        return;
      }
      if (key.leftArrow) {
        deps.caretText((text, at, anchor) => ({ cursor: caretLeft(text, at), anchor: shiftOf(key) ? (anchor ?? at) : null }));
        return;
      }
      if (key.rightArrow) {
        deps.caretText((text, at, anchor) => ({ cursor: caretRight(text, at), anchor: shiftOf(key) ? (anchor ?? at) : null }));
        return;
      }
      if (key.home) {
        deps.caretText((_text, at, anchor) => ({ cursor: 0, anchor: shiftOf(key) ? (anchor ?? at) : null }));
        return;
      }
      if (key.end) {
        deps.caretText((text, at, anchor) => ({ cursor: text.length, anchor: shiftOf(key) ? (anchor ?? at) : null }));
        return;
      }
      if (key.backspace || key.delete) {
        // ⚠️ **那一格是纯文本**：它没有选区（框里的状态只有三个格子），所以退格走字符算式
        deps.editText((text, at) => ({ ...(key.delete ? deleteAtFrom(text, at) : deleteBefore(text, at)), anchor: null }));
        return;
      }
      // ⚠️ **`Ctrl+C` / `Ctrl+X` 等一切组合在改名框里什么都不做**：它们是输入行的快捷键，
      // 而此刻输入行里装的是**会话名**，按了它等于删掉半个名字而屏上没有任何解释
      if (key.ctrl || key.meta) return;
      const typed = printableOnly(pressed);
      if (typed === "") return;
      deps.editText((text, at) => ({ ...insertAt(text, at, typed), anchor: null }));
      return;
    }

    /* ── ② 弹窗：表单那一档（键归框） ──────────────────────────────────────── */
    if (deps.modalOpen) {
      if (deps.formOpen) {
        if (key.escape) {
          deps.escapeModal();
          return;
        }
        if (key.return) {
          // ⚠️ **`Enter` 提交整份表单**（不是提交当前字段），而 `Ctrl+Enter` 在这一档是空转
          if (key.ctrl || key.meta) return;
          deps.submitForm();
          return;
        }
        if (key.tab) {
          // ⚠️ **`Shift+Tab` 往回走**：`Tab` 与 `↓` 因此不是同一件事（`↓` 在下拉那一格换档）
          deps.fieldTab(key.shift ? -1 : 1);
          return;
        }
        if (key.upArrow) {
          deps.fieldArrow(-1);
          return;
        }
        if (key.downArrow) {
          deps.fieldArrow(1);
          return;
        }
        if (key.leftArrow) {
          deps.caretText((text, at, anchor) => ({ cursor: caretLeft(text, at), anchor: shiftOf(key) ? (anchor ?? at) : null }));
          return;
        }
        if (key.rightArrow) {
          deps.caretText((text, at, anchor) => ({ cursor: caretRight(text, at), anchor: shiftOf(key) ? (anchor ?? at) : null }));
          return;
        }
        if (key.home) {
          deps.caretText((_text, at, anchor) => ({ cursor: 0, anchor: shiftOf(key) ? (anchor ?? at) : null }));
          return;
        }
        if (key.end) {
          deps.caretText((text, at, anchor) => ({ cursor: text.length, anchor: shiftOf(key) ? (anchor ?? at) : null }));
          return;
        }
        if (key.backspace || key.delete) {
          deps.editText((text, at) => ({ ...(key.delete ? deleteAtFrom(text, at) : deleteBefore(text, at)), anchor: null }));
          return;
        }
        if (key.ctrl || key.meta) return;
        const typed = printableOnly(pressed);
        if (typed === "") return;
        deps.editText((text, at) => ({ ...insertAt(text, at, typed), anchor: null }));
        return;
      }

      /* ── ③ 弹窗：`provider-models` 那一档（过滤框恒有焦点 ⇒ `↑↓` 归勾选行） ── */
      if (deps.textTarget === "filter") {
        if (key.escape) {
          deps.escapeModal();
          return;
        }
        if (key.upArrow) {
          deps.moveModalRow(-1);
          return;
        }
        if (key.downArrow) {
          deps.moveModalRow(1);
          return;
        }
        if (pressed === " ") {
          // ⚠️ **`Space` 归勾选**：过滤框因此收不到空格，而「靠空格筛模型」不是一个真需求
          // ⚠️ 判据是**那一个字符**而不是 `key.space` —— Ink 的 `Key` 上根本没有空格这一位
          deps.toggleCheck();
          return;
        }
        if (key.ctrl || key.meta) {
          const lower = pressed.toLowerCase();
          if (lower === "a") {
            deps.addModalRow();
            return;
          }
          if (lower === "d") {
            deps.removeModalRow();
            return;
          }
          if (lower === "e") {
            deps.editModalRow();
            return;
          }
          if (lower === "g") {
            deps.fetchModels();
            return;
          }
          return;
        }
        if (key.leftArrow) {
          deps.editFilter((text, at) => ({ text, cursor: caretLeft(text, at), anchor: null }));
          return;
        }
        if (key.rightArrow) {
          deps.editFilter((text, at) => ({ text, cursor: caretRight(text, at), anchor: null }));
          return;
        }
        if (key.home) {
          deps.editFilter((text) => ({ text, cursor: 0, anchor: null }));
          return;
        }
        if (key.end) {
          deps.editFilter((text) => ({ text, cursor: text.length, anchor: null }));
          return;
        }
        if (key.backspace || key.delete) {
          deps.editFilter((text, at) => ({ ...(key.delete ? deleteAtFrom(text, at) : deleteBefore(text, at)), anchor: null }));
          return;
        }
        const typed = printableOnly(pressed);
        if (typed === "") return;
        deps.editFilter((text, at) => ({ ...insertAt(text, at, typed), anchor: null }));
        return;
      }

      /* ── ④ 弹窗：清单那几档（↑↓ 选行 / Enter 接受 / Ctrl+A·D·E·M·G·F·P·R） ──── */
      if (key.escape) {
        deps.escapeModal();
        return;
      }
      if (key.upArrow) {
        deps.moveModalRow(-1);
        return;
      }
      if (key.downArrow) {
        deps.moveModalRow(1);
        return;
      }
      // ⚠️ **`Ctrl+Enter` 排在 `Enter` 之前**：不带 kitty 的终端上 `Ctrl+M` 与 `Enter` 是**同一个字节**
      // （`^M` = CR），而带 kitty 时它是 `{ return: true, ctrl: true }` —— 判据只能落在那一格修饰键上，
      // 落到 `Enter` 那一支的话「编辑模型列表」会变成「接受高亮那一项」。
      if (key.return && (key.ctrl || key.meta)) {
        deps.modelsOfProvider();
        return;
      }
      if (key.return) {
        deps.acceptModal();
        return;
      }
      if (pressed === " ") {
        // ⚠️ `provider-models` 之外的清单档**没有勾选** ⇒ 空格落在这里只有一种结果：什么都不做
        deps.toggleCheck();
        return;
      }
      // ⚠️ **除下面这一族之外，弹窗开着时其余每一个键都被吃掉** —— 面板候选、结果区滚动、
      // 当前会话全在遮罩背后，而它们的作用对象此刻一格都不许动（症状是「面板照滚照亮，
      // 操作者以为滚轮坏了」）。而少这道门禁**屏上零报错**。
      if (key.ctrl || key.meta) {
        const lower = pressed.toLowerCase();
        if (lower === "a") {
          deps.addModalRow();
          return;
        }
        if (lower === "d") {
          deps.removeModalRow();
          return;
        }
        if (lower === "e") {
          deps.editModalRow();
          return;
        }
        if (lower === "m") {
          deps.modelsOfProvider();
          return;
        }
        if (lower === "g") {
          deps.fetchModels();
          return;
        }
        if (lower === "f") {
          deps.togglePin();
          return;
        }
        if (lower === "r") {
          deps.ctrlR();
          return;
        }
        if (lower === "p") {
          deps.setPassword();
          return;
        }
        return;
      }
      return;
    }

    /* ── ⑤ 会话菜单（⚠️ **不是模态**：`Esc` 只是收掉它，背后那一层照旧走下面那些判据） ── */
    if (deps.menuOpen) {
      if (key.escape) {
        deps.closeMenu();
        return;
      }
      if (key.upArrow) {
        deps.moveMenu(-1);
        return;
      }
      if (key.downArrow) {
        deps.moveMenu(1);
        return;
      }
      if (key.return) {
        deps.pickMenu();
        return;
      }
    }

    /* ── ⑥ 输入行 ────────────────────────────────────────────────────────── */

    // ⚠️ **`Ctrl+Enter` / `Alt+Enter` = 插入 `\n`**：判据只有「`return` 且带那两个修饰键之一」。
    // ⚠️ **必须在下面那个 `key.ctrl || key.meta` 那一族之前** —— 否则 `Ctrl+Enter` 会落到它的
    // 尾巴上（那一族尾部什么都不做），于是换行这一键永远不生效。
    if (key.return && (key.ctrl || key.meta)) {
      deps.editActive((text, at, anchor) => {
        const sel = normalizeSelection(text, anchor, at);
        const after = insertNewline(text, sel);
        return { text: after.text, cursor: after.cursor, anchor: null };
      });
      return;
    }
    // ⚠️ `exitOnCtrlC: false` ⇒ Ink 的两道门都**不生效**，故 `Ctrl+C` **原样落到本层**；
    // 而本层**刻意什么都不做** —— 退出只经 `/exit` 与 `/quit`（牙齿：`tests/input/exit.test.ts`）
    if (key.ctrl || key.meta) {
      const lower = pressed.toLowerCase();
      // ⚠️ **`Ctrl+↑` / `Ctrl+↓` = 切会话**（需求 2）：它**排在裸 `↑↓` 之前**，
      // 而裸 `↑↓` 是输入框的行移动 + 历史（需求 1）—— 两族各有一个键位，一个都不许挪位
      if (key.upArrow) {
        deps.stepSession(-1);
        return;
      }
      if (key.downArrow) {
        deps.stepSession(1);
        return;
      }
      // ⚠️ `Ctrl+N` / `Ctrl+P` **保留为别名**：两者交出同一个动作，而「加一个别名要改几处」恒等于 1
      if (lower === "n") {
        deps.stepSession(1);
        return;
      }
      if (lower === "p") {
        deps.stepSession(-1);
        return;
      }
      if (lower === "x") {
        // ⚠️ **`Ctrl+X` 是「从侧边栏移出」而不是删除**：它只动 `sidebar_sessions` 那一张表
        deps.detachActiveSession();
        return;
      }
      // ⚠️ `Ctrl+R` 是「重探当前控制面」的 `/r` 那一条**故意让开**的这一格
      if (lower === "r") {
        deps.renameActiveSession();
        return;
      }
      if (key.home) {
        deps.scrollTo("top");
        return;
      }
      if (key.end) {
        deps.scrollTo("bottom");
        return;
      }
      if (key.pageUp) {
        deps.scrollBy(-SCROLL_STEP);
        return;
      }
      if (key.pageDown) {
        deps.scrollBy(SCROLL_STEP);
        return;
      }
      // ⚠️ 其余 Ctrl 组合**什么都不做**（而 `Ctrl+C` 正是其中之一）
      return;
    }
    if (key.pageUp) {
      deps.scrollBy(-SCROLL_STEP);
      return;
    }
    if (key.pageDown) {
      deps.scrollBy(SCROLL_STEP);
      return;
    }
    // ⚠️ **面板开着时 `↑↓` 归面板**（现有纪律）：面板是「敲到哪一条命令」的那一层，
    // 而输入框的行移动会让面板高亮停在一条命令上而输入行已经跑到下一段去了
    if (key.upArrow) {
      if (deps.palette.open) {
        deps.movePalette(-1);
        return;
      }
      const to = caretUp(deps.input, deps.cursor, deps.textWidth);
      if (to !== null) {
        deps.caretActive(() => ({ cursor: to, anchor: shiftOf(key) ? deps.cursor : null }));
        return;
      }
      // ⚠️ **到首行才去问历史**：判据是 {@link caretUp} 给不给 `null`（两处各判一次就会有一处判错）
      const older = historyPrev(deps.historyEntries, deps.input);
      if (older !== null) deps.fillHistory(older);
      return;
    }
    if (key.downArrow) {
      if (deps.palette.open) {
        deps.movePalette(1);
        return;
      }
      const to = caretDown(deps.input, deps.cursor, deps.textWidth);
      if (to !== null) {
        deps.caretActive(() => ({ cursor: to, anchor: shiftOf(key) ? deps.cursor : null }));
        return;
      }
      // ⚠️ **恒不返回 `null`**：到头了本身就是答案（清空输入行）
      deps.fillHistory(historyNext(deps.historyEntries, deps.historyAt));
      return;
    }
    if (key.leftArrow) {
      deps.caretActive((text, at, anchor) => ({ cursor: caretLeft(text, at), anchor: shiftOf(key) ? (anchor ?? at) : null }));
      return;
    }
    if (key.rightArrow) {
      deps.caretActive((text, at, anchor) => ({ cursor: caretRight(text, at), anchor: shiftOf(key) ? (anchor ?? at) : null }));
      return;
    }
    if (key.home) {
      deps.caretActive((_text, at, anchor) => ({ cursor: 0, anchor: shiftOf(key) ? (anchor ?? at) : null }));
      return;
    }
    if (key.end) {
      deps.caretActive((text, at, anchor) => ({ cursor: text.length, anchor: shiftOf(key) ? (anchor ?? at) : null }));
      return;
    }
    if (key.backspace || key.delete) {
      // ⚠️ **退格与删除吃掉整段选区**，而那一段的算法只有一个出口（`deleteSelection`）
      deps.editActive((text, at, anchor) => {
        const sel = normalizeSelection(text, anchor, at);
        const after = key.delete
          ? deleteSelection(text, sel)
          : sel.start === sel.end
            ? deleteBefore(text, sel.start)
            : deleteSelection(text, sel);
        return { text: after.text, cursor: after.cursor, anchor: null };
      });
      return;
    }
    if (key.tab) {
      // ⚠️ Tab 补的是面板高亮那一行（否则「填进去的」与「高亮的」差一行）
      const accept = deps.acceptPalette();
      if (accept !== null) {
        deps.fillActive({ input: accept.line, cursor: accept.cursor, anchor: null });
        return;
      }
      const suggestion = complete({
        line: deps.input,
        cursor: deps.cursor,
        targetNames: deps.targets.map((one) => one.name),
      });
      if (suggestion.candidates.length === 0) return;
      deps.fillActive({ input: suggestion.line, cursor: suggestion.cursor, anchor: null });
      return;
    }
    if (key.return) {
      // ⚠️ **判据只有一条而它不在本层**：`enterOutcomeOf` 答「接受面板高亮会不会改变输入行那一串」
      const outcome = enterOutcomeOf(deps.input, deps.cursor);
      if (outcome.kind === "fill") {
        deps.fillActive({ input: outcome.line, cursor: outcome.cursor, anchor: null });
        return;
      }
      deps.submit(deps.input);
      return;
    }
    if (key.escape) {
      deps.fillActive({ input: "", cursor: 0, anchor: null });
      return;
    }
    // ⚠️ 最后一档：可打印文本（C0 与 `DEL` 在这里被剔掉，见 `@/lib/input-line.js`）
    const typed = printableOnly(pressed);
    if (typed === "") return;
    // ⚠️ **打印替换掉整段选区**（标准编辑器语义），而那是与退格 / 提交同一个出口
    deps.editActive((text, at, anchor) => {
      const sel = normalizeSelection(text, anchor, at);
      const after = replaceSelection(text, sel, typed);
      return { text: after.text, cursor: after.cursor, anchor: null };
    });
  });
}

/** 删掉插入符**右边**那一个字符（⚠️ 框里那几格是纯文本，没有选区，所以走字符算式） */
function deleteAtFrom(text: string, at: number): { text: string; cursor: number } {
  return { text: text.slice(0, at + 1) + text.slice(at + 2), cursor: at };
}