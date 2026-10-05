/** @fileoverview 鼠标订阅与分派（⚠️ 模态开着时 `move` / 滚轮 / `down` 都先门禁） */

import { useEffect, type Dispatch, type SetStateAction } from "react";

import { paletteFill, type Palette } from "@/commands/index.js";
import type { MouseEvent, MouseSource } from "@/services/terminal/index.js";
import type { SessionRow } from "@/components/index.js";
import {
  caretFromColumn,
  caretFromWrappedPoint,
  hitTest,
  type Geometry,
  type Rect,
} from "@/lib/index.js";

import { SCROLL_STEP, type FillActive } from "@/store/index.js";

/** 拖宽手柄的起手（⚠️ 存**起点宽度**不是当前宽度：改成累计位移的话一个像素的报告会被累加成几十像素） */
export interface ResizeStart {
  readonly x: number;
  readonly width: number;
}

interface MouseDeps {
  readonly mouse: MouseSource;
  readonly geometry: Geometry;
  readonly sessionRows: readonly SessionRow[];
  /** 当前是哪个会话（⚠️ **`null` = 一个都没有** ⇒ 「点当前那一个」那一档根本不存在） */
  readonly activeId: string | null;
  readonly input: string;
  readonly cursor: number;
  readonly palette: Palette;
  readonly windowStart: number;
  readonly modalOpen: boolean;
  readonly formOpen: boolean;
  /** 此刻聚焦的那个文本框落在**第几个 `input` 槽**（⚠️ `windowInputTexts` 是**数组**，按**下标**问） */
  readonly textSlot: number;
  /** 那个框此刻装的那一串（⚠️ **点它落插入符要按显示列回查**，而那一格装的是哪一格由状态层答） */
  readonly textValue: string;
  /** 焦点此刻在**输入区**吗（⚠️ 不在的话点输入行不许抢焦点 —— 此刻焦点在弹窗里那个框上） */
  readonly inputFocused: boolean;
  readonly sidebarWidth: number;
  readonly switchSession: (id: string) => void;
  // ⚠️ `revealSession` 不在这里：命中目标按构造就在可见窗口内，且 spawn/unpinSession 内部已 reveal
  readonly scrollBy: (delta: number) => void;
  readonly scrollSessions: (step: number) => void;
  readonly openMenu: (sessionId: string | null, x: number, y: number) => void;
  readonly pickMenu: (index: number) => void;
  readonly closeMenu: () => void;
  readonly menuOpen: boolean;
  readonly unpinSession: (id: string) => void;
  readonly movePalette: (step: 1 | -1) => void;
  readonly closeWindow: () => void;
  /** 点弹窗里**第 `at` 个可选行**（⚠️ `at` 数的是**可选行**：分组标题不在其中） */
  readonly pickModalRow: (at: number) => void;
  /** 点表单里**第 `slot` 那一格** → 焦点挪过去 */
  readonly focusFormField: (slot: number) => void;
  /** 在某个文本框里按下（⚠️ **单击清空选区** —— 选区是拖出来的，不是点出来的） */
  readonly textDown: (at: number) => void;
  /** 拖动（⚠️ **锚点落在按下的那一格**；而状态层自己判「这一次拖动有没有起手」） */
  readonly textDrag: (at: number) => void;
  readonly textUp: () => void;
  readonly fillActive: FillActive;
  readonly resizingRef: { current: ResizeStart | null };
  readonly setSidebarWidth: Dispatch<SetStateAction<number>>;
  readonly setHoveredId: Dispatch<SetStateAction<string | null>>;
  readonly setSessionCloseHot: Dispatch<SetStateAction<boolean>>;
  readonly setHandleHot: Dispatch<SetStateAction<boolean>>;
}

/** 点在弹窗里**第几个 `input` 槽**上（`-1` = 不在任何一格里；⚠️ 装不下的那几格是 `null`，恒不命中） */
function inputSlotAt(x: number, y: number, texts: readonly (Rect | null)[]): number {
  for (let i = 0; i < texts.length; i += 1) {
    const rect = texts[i];
    if (rect !== null && hitTest(x, y, [rect]) >= 0) return i;
  }
  return -1;
}

/** 那一格里的**字符下标**（⚠️ 整格**含提示符**，按整格算会偏掉那几列，故读的是 `windowInputTexts`） */
function columnIn(x: number, rect: Rect | null, text: string): number {
  return rect === null ? 0 : caretFromColumn(x, rect, text);
}

export function useMouse(deps: MouseDeps): void {
  const {
    mouse,
    geometry: g,
    sessionRows,
    activeId,
    input,
    cursor,
    palette,
    windowStart,
    modalOpen,
    formOpen,
    textSlot,
    textValue,
    inputFocused,
    sidebarWidth,
    switchSession,
    scrollBy,
    scrollSessions,
    openMenu,
    pickMenu,
    closeMenu,
    menuOpen,
    unpinSession,
    movePalette,
    closeWindow,
    pickModalRow,
    focusFormField,
    textDown,
    textDrag,
    textUp,
    fillActive,
    resizingRef,
    setSidebarWidth,
    setHoveredId,
    setSessionCloseHot,
    setHandleHot,
  } = deps;

  // ⚠️ `set*` 与 `resizingRef` 不在依赖里：前者是 React 恒定的 setter、后者是恒定的 ref
  useEffect(() => {
    return mouse.onMouse((event: MouseEvent) => {
      /* `drag` 现在有**第二个去处**（侧边栏拖宽之外）：拖出选区。
       * ⚠️ 判据是「那一下按在哪一处」——而**按下**那一刻已经把去处定下来了，
       * 于是本分支不必问「这一下是不是拖宽」：`resizingRef` 答前者，`textDrag` 自己答后者。 */
      if (event.action === "drag") {
        if (resizingRef.current !== null) {
          const start = resizingRef.current;
          setSidebarWidth(start.width + (event.x - start.x));
          return;
        }
        if (inputFocused && g.inputTextRows.length > 0) {
          const at = caretFromWrappedPoint(event.x, event.y, g.inputTextRows, g.inputWrapped);
          if (at !== null) {
            textDrag(at);
            return;
          }
        }
        if (textSlot < 0) return;
        textDrag(columnIn(event.x, g.windowInputTexts[textSlot] ?? null, textValue));
        return;
      }
      switch (event.action) {
        case "move": {
          // ⚠️ **模态开着时背后那一层不认悬停**（与 `down` 同一条纪律）：悬停只决定背景那一层的底色，
          // 而那一层正被遮罩压着 —— 让它改状态等于给一个看不见的东西写状态。
          if (modalOpen) return;
          // ⚠️ 只有 `move` 认 hover：拖宽时也换底色的话，那一项亮着而屏上零解释
          const row = resizingRef.current === null ? hitTest(event.x, event.y, g.sidebarRows) : -1;
          // ⚠️ 窗口内下标 → 会话下标要加 `sessionFirst`（漏加的那一族症状在屏上都看着合理）
          const now = row < 0 ? null : (sessionRows[g.sessionFirst + row]?.id ?? null);
          setHoveredId((before) => (before === now ? before : now));
          // ⚠️ 「✕」亮不亮只看**指针落在不在悬停那一项自己的那一格上**（`row` 已经把它钉住）——
          // 于是它与 `hoveredId` 不会说两件事：那一枚只画在 `now` 那一项上。
          const slot = row < 0 ? undefined : g.sidebarCloseRows[row];
          setSessionCloseHot(
            resizingRef.current === null &&
              slot !== null &&
              slot !== undefined &&
              hitTest(event.x, event.y, [slot]) >= 0,
          );
          setHandleHot(
            resizingRef.current === null &&
              hitTest(event.x, event.y, [g.sidebarHandle].filter((r) => r !== null)) >= 0,
          );
          return;
        }
        case "up":
          // ⚠️ 抬手后底色留着（指针确实还在那一项上），而**拖出去的选区也留着** ——
          // 「单击会清掉它」与「拖完它还在」是同一件事的两面，两者都由 `textUp` 收口
          textUp();
          resizingRef.current = null;
          return;
        case "wheelUp":
        case "wheelDown": {
          // ⚠️ **模态开着时滚轮也全被吞掉**：滚轮的两个去处（面板高亮、结果区滚动）都在背后那一层，
          // 屏上被遮罩压着却仍在动 —— 操作者看着一个不动的结果区以为滚轮坏了。
          if (modalOpen) return;
          // ⚠️ 两档合成一个 `case`（分开写就得改一处忘一处）；一个滚轮事件只有一个去处：侧边栏上翻
          // 会话清单（那几行与结果区那些行是两块不同的东西）
          const step = event.action === "wheelUp" ? -1 : 1;
          if (hitTest(event.x, event.y, [g.sidebar].filter((r) => r !== null)) >= 0) {
            scrollSessions(step);
            return;
          }
          if (palette.open) movePalette(step);
          else scrollBy(step * SCROLL_STEP);
          return;
        }
        case "down": {
          // ⚠️ 窗口是模态且这一判据在**按键之前**：开着时背后的一切点击什么都不做（含右键）
          if (modalOpen) {
            // ⚠️ `closeHint: false` 时 `windowClose` 是 `null`，`.filter` 之后那个数组是空的 ⇒
            // 那一格**点不中也不该点中**（零宽矩形恒不命中，而留着它会白吃掉一次点击）。
            if (hitTest(event.x, event.y, [g.windowClose].filter((r) => r !== null)) >= 0) {
              closeWindow();
              return;
            }
            // ⚠️ **输入类槽位先于那些行**：改名框、过滤框与表单那五格都排在那儿。
            // ⚠️ **`windowInputTexts` 是数组**：按**下标**问「点的是第几个槽」，
            // 而单数投影答不出「第 2 个字段的点落在哪一格」
            const slot = inputSlotAt(event.x, event.y, g.windowInputTexts);
            if (slot >= 0) {
              if (formOpen) {
                // ⚠️ 表单那一族：**点哪一格就在哪一格敲**（这是那一族唯一的鼠标动作）
                focusFormField(slot);
                return;
              }
              // ⚠️ **只有聚焦的那一格**才落插入符：过滤框不是当前字段时点了它也不动焦点
              if (slot === textSlot) textDown(columnIn(event.x, g.windowInputTexts[slot] ?? null, textValue));
              return;
            }
            // ⚠️ **`check` 槽是复选框**（模型清单那几行）：点它 = 挪高亮 + 切那一格的勾选
            const check = hitTest(event.x, event.y, g.windowChecks);
            if (check >= 0) {
              pickModalRow(check);
              return;
            }
            // ⚠️ **`select` 槽是下拉**：点它把焦点挪到那一格（换档走 `↑↓` —— 点一次换一档的话
            // 「点一下换到哪一档」在屏上答不出来）
            const select = hitTest(event.x, event.y, g.windowSelects);
            if (select >= 0) {
              focusFormField(select);
              return;
            }
            const picked = hitTest(event.x, event.y, g.windowRows);
            if (picked >= 0) pickModalRow(picked);
            return;
          }
          // ⚠️ 右键**只开菜单**（侧边栏空白处那一份只有「新建会话」）；中键留给终端（粘贴）
          if (event.button === "right") {
            // ⚠️ 手柄那一列右键什么都不做（它与每一项重叠，而它自己的含义是「拖宽」）
            if (hitTest(event.x, event.y, [g.sidebarHandle].filter((r) => r !== null)) >= 0) return;
            const at = hitTest(event.x, event.y, g.sidebarRows);
            const pickedSession = at < 0 ? undefined : sessionRows[g.sessionFirst + at];
            // ⚠️ 侧边栏**之外**右键：只收掉已经开着的那份菜单（凭空在主区里弹一个会话菜单毫无意义）
            if (pickedSession === undefined && hitTest(event.x, event.y, [g.sidebar].filter((r) => r !== null)) < 0) {
              closeMenu();
              return;
            }
            openMenu(pickedSession?.id ?? null, event.x, event.y);
            return;
          }
          // ⚠️ 其余按键（含无按键的按下报告）一个都不接
          if (event.button !== "left") return;
          // ⚠️ **菜单先判**：它浮在侧边栏与手柄**之上**，而它那一格同时落在某一项的矩形里 ——
          // 判在会话项之后的话「点菜单里那项」会变成「切到它压着的那个会话」，菜单永远点不动。
          if (menuOpen) {
            const pick = hitTest(event.x, event.y, g.menuRows);
            // ⚠️ 点它外面**只关菜单**：顺手把底下那一层也点掉的话，「关菜单」会变成「切会话」
            if (pick >= 0) pickMenu(pick);
            else closeMenu();
            return;
          }
          // ⚠️ 手柄先判：它与那些会话项重叠，反过来会让起手那一瞬把会话切掉
          if (hitTest(event.x, event.y, [g.sidebarHandle].filter((r) => r !== null)) >= 0) {
            resizingRef.current = { x: event.x, width: sidebarWidth };
            return;
          }
          const row = hitTest(event.x, event.y, g.sidebarRows);
          if (row >= 0) {
            const pickedSession = sessionRows[g.sessionFirst + row];
            // ⚠️ 「✕」先于「切到那一项」：它画在那一项上面且命中区是同一个矩形，
            // 先判会话项的话「点那枚按钮」会变成「切过去而按钮还在」
            const slot = g.sidebarCloseRows[row];
            if (
              pickedSession !== undefined &&
              slot !== null &&
              slot !== undefined &&
              hitTest(event.x, event.y, [slot]) >= 0
            ) {
              unpinSession(pickedSession.id);
              return;
            }
            // ⚠️ 点当前那一个时什么都不做（那一次点击不该产生任何后果）
            if (pickedSession !== undefined && pickedSession.id !== activeId) {
              switchSession(pickedSession.id);
            }
            return;
          }
          // ⚠️ 面板候选行在侧边栏右侧：点中哪一行就补进输入行，**不执行**
          const pick = hitTest(event.x, event.y, g.paletteRows);
          if (pick >= 0 && palette.open) {
            const chosen = palette.rows[windowStart + pick];
            if (chosen !== undefined) {
              const filled = paletteFill(input, cursor, chosen);
              fillActive({ input: filled.line, cursor: filled.cursor, anchor: null });
            }
            return;
          }
          // ⚠️ **输入区那一段选区**：按下落插入符并**清空选区**，而拖动（上面那个 `drag` 分支）形成它。
          // ⚠️ **焦点不在输入区时这一段一个字节都不许动** —— 此刻焦点在弹窗里那个框上
          if (inputFocused && g.inputTextRows.length > 0) {
            const at = caretFromWrappedPoint(event.x, event.y, g.inputTextRows, g.inputWrapped);
            if (at !== null) {
              textDown(at);
              return;
            }
          }
          // ⚠️ 点结果区**什么都不做**
          return;
        }
        default:
          return;
      }
    });
  }, [
    mouse,
    g,
    sessionRows,
    activeId,
    input,
    cursor,
    palette,
    windowStart,
    modalOpen,
    formOpen,
    textSlot,
    textValue,
    inputFocused,
    sidebarWidth,
    switchSession,
    scrollBy,
    scrollSessions,
    openMenu,
    pickMenu,
    closeMenu,
    menuOpen,
    unpinSession,
    movePalette,
    closeWindow,
    pickModalRow,
    focusFormField,
    textDown,
    textDrag,
    textUp,
    fillActive,
  ]);
}