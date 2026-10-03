/**
 * @fileoverview 鼠标订阅与分派（一个订阅、一张 `switch`）
 * @module app/use-mouse
 * @description
 * ⚠️ `drag` 报告在**拖宽期间**是本包的语义，其余时候必须留给终端（拖选文本 / 框选粘贴）。判据是
 * `resizingRef` 那一个 ref：「按着最右那一列」是**起手**决定的，故拖到哪儿都不再判一次位置 —— 而它
 * 存的是**起点宽度**不是当前宽度，改成「累计位移」的话一个像素的报告会被累加成几十像素。
 *
 * ⚠️ 订阅的**依赖数组逐项照抄** `app.tsx` 拆分前那份：多一项就多一次 `off`/`on`。
 */

import { useEffect, type Dispatch, type SetStateAction } from "react";

import { paletteFill, type Palette } from "@/cmd/index.js";
import type { MouseEvent, MouseSource } from "@/terminal/index.js";
import { caretFromWrappedPoint, hitTest, type Geometry, type SessionRow } from "@/view/index.js";

import { SCROLL_STEP, type FillActive, type WindowKind } from "./state.js";

/** 拖宽手柄的起手（**起点宽度**，不是当前宽度：见文件头） */
export interface ResizeStart {
  readonly x: number;
  readonly width: number;
}

interface MouseDeps {
  readonly mouse: MouseSource;
  readonly geometry: Geometry;
  readonly sessionRows: readonly SessionRow[];
  readonly activeId: string;
  readonly input: string;
  readonly cursor: number;
  readonly palette: Palette;
  readonly windowStart: number;
  readonly windowKind: WindowKind;
  readonly sidebarWidth: number;
  readonly switchSession: (id: string) => void;
  readonly scrollBy: (delta: number) => void;
  readonly movePalette: (step: 1 | -1) => void;
  readonly closeWindow: () => void;
  readonly fillActive: FillActive;
  readonly resizingRef: { current: ResizeStart | null };
  readonly setSidebarWidth: Dispatch<SetStateAction<number>>;
  readonly setHoveredId: Dispatch<SetStateAction<string | null>>;
  readonly setHandleHot: Dispatch<SetStateAction<boolean>>;
  readonly setCloseHot: Dispatch<SetStateAction<boolean>>;
  readonly setWindowAt: Dispatch<SetStateAction<number>>;
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
    windowKind,
    sidebarWidth,
    switchSession,
    scrollBy,
    movePalette,
    closeWindow,
    fillActive,
    resizingRef,
    setSidebarWidth,
    setHoveredId,
    setHandleHot,
    setCloseHot,
    setWindowAt,
  } = deps;

  // ⚠️ 这五个 `set*` 与 `resizingRef` 不在依赖里：前四个是 React 恒定的那几个 setter，后一个是
  // 恒定的 ref，加进去只会让订阅在每次渲染后重建。
  useEffect(() => {
    return mouse.onMouse((event: MouseEvent) => {
      if (event.action === "drag" && resizingRef.current !== null) {
        const start = resizingRef.current;
        setSidebarWidth(start.width + (event.x - start.x));
        return;
      }
      switch (event.action) {
        case "move": {
          // ⚠️ **只有 `move` 认 hover**：拖宽时也换底色的话，那一项会亮着而屏上没有任何东西
          // 解释它为什么亮着。
          setHoveredId((before) => {
            // ⚠️ **同一个值就原样返回**：React 跳过重渲染，于是「手在侧边栏里划一下」一个字节
            // 都不写。
            const now =
              resizingRef.current === null
                ? hitTest(event.x, event.y, g.sidebarRows) < 0
                  ? null
                  : (sessionRows[hitTest(event.x, event.y, g.sidebarRows)]?.id ?? null)
                : null;
            return before === now ? before : now;
          });
          setHandleHot(
            resizingRef.current === null &&
              hitTest(event.x, event.y, [g.sidebarHandle].filter((r) => r !== null)) >= 0,
          );
          setCloseHot(
            windowKind !== null &&
              hitTest(event.x, event.y, [g.windowClose].filter((r) => r !== null)) >= 0,
          );
          return;
        }
        case "up":
          // ⚠️ 抬手之后**底色留着**（指针确实还在那一项上）；而 `drag` / `wheelLeft` /
          // `wheelRight` 一个都不接（除非正在拖宽，那一支在上面）—— 拖动选择必须留给终端。
          resizingRef.current = null;
          return;
        case "wheelUp":
          // ⚠️ 面板开着时滚轮**走面板**（移动高亮那一行），面板关着时才滚结果区：与 `↑`/`↓`
          // 同一个判据、同一份实现。
          if (palette.open) movePalette(-1);
          else scrollBy(-SCROLL_STEP);
          return;
        case "wheelDown":
          if (palette.open) movePalette(1);
          else scrollBy(SCROLL_STEP);
          return;
        case "down": {
          // ⚠️ **只认左键**：中键与右键各有各的含义（粘贴 / 菜单），本工具没有那两种操作。
          if (event.button !== "left") return;
          // ⚠️ **窗口是模态**：它开着时只认它自己的两处（右上角那枚 esc、它自己那几行），
          // 背后的一切点击**什么都不做** —— 包括侧边栏与输入行。
          if (windowKind !== null) {
            if (hitTest(event.x, event.y, [g.windowClose].filter((r) => r !== null)) >= 0) {
              closeWindow();
              return;
            }
            const picked = hitTest(event.x, event.y, g.windowRows);
            if (picked >= 0) setWindowAt(picked);
            return;
          }
          // ⚠️ **手柄先判**：它与那些会话项**重叠**（就是侧边栏最右那一列），反过来（先判
          // 会话）的话「按着最右那列拖宽」会在起手那一瞬把会话切掉。
          if (hitTest(event.x, event.y, [g.sidebarHandle].filter((r) => r !== null)) >= 0) {
            resizingRef.current = { x: event.x, width: sidebarWidth };
            return;
          }
          const row = hitTest(event.x, event.y, g.sidebarRows);
          if (row >= 0) {
            const pickedSession = sessionRows[row];
            // ⚠️ 点的**就是当前那个**时什么都不做：那一次点击不该产生任何后果。
            if (pickedSession !== undefined && pickedSession.id !== activeId) {
              switchSession(pickedSession.id);
            }
            return;
          }
          // ⚠️ 面板的候选行**在侧边栏右侧**：点中哪一行就把它补进输入行，**不执行**。
          const pick = hitTest(event.x, event.y, g.paletteRows);
          if (pick >= 0 && palette.open) {
            const chosen = palette.rows[windowStart + pick];
            if (chosen !== undefined) {
              const filled = paletteFill(input, cursor, chosen);
              fillActive({ input: filled.line, cursor: filled.cursor });
            }
            return;
          }
          if (g.inputTextRows.length > 0) {
            const at = caretFromWrappedPoint(event.x, event.y, g.inputTextRows, g.inputWrapped);
            if (at !== null) {
              fillActive({ cursor: at });
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
    windowKind,
    sidebarWidth,
    switchSession,
    scrollBy,
    movePalette,
    closeWindow,
    fillActive,
  ]);
}
