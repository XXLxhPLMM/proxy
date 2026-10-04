/**
 * @fileoverview 鼠标订阅与分派；⚠️ 模态开着时 `move` / 滚轮 / `down` **三个分支都先门禁**，而 `down` 的判据次序：窗口 → 按键 → 菜单 → 手柄 → 「✕」→ 会话项 → 面板 → 输入行
 */

import { useEffect, type Dispatch, type SetStateAction } from "react";

import { paletteFill, type Palette } from "@/commands/index.js";
import type { MouseEvent, MouseSource } from "@/services/terminal/index.js";
import type { SessionRow } from "@/components/index.js";
import { caretFromWrappedPoint, hitTest, type Geometry } from "@/lib/index.js";

import { SCROLL_STEP, type FillActive, type WindowKind } from "@/store/index.js";

/** 拖宽手柄的起手（⚠️ 存**起点宽度**不是当前宽度：改成累计位移的话一个像素的报告会被累加成几十像素） */
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
  // ⚠️ `revealSession` 不在这里：命中目标按构造就在可见窗口内，且 spawn/closeSession 内部已 reveal
  readonly scrollBy: (delta: number) => void;
  /** 侧边栏那一列翻几项（**一项 = 一会话**，不是一行）；指针落在侧边栏上时滚轮走它 */
  readonly scrollSessions: (step: number) => void;
  /** 在那次右键的落点上弹出会话菜单（⚠️ **右键只开菜单、不直接动手**：菜单才是「有哪些动作」的那份清单） */
  readonly openMenu: (sessionId: string | null, x: number, y: number) => void;
  /** 选中菜单里第 `index` 项（`index` 是**窗口内**下标，与 `Geometry.menuRows` 同序） */
  readonly pickMenu: (index: number) => void;
  /** 关掉菜单（点它外面、`Esc`、或者任何一次重新弹出的右键） */
  readonly closeMenu: () => void;
  readonly menuOpen: boolean;
  /** 关掉某一个会话（那枚「✕」与**菜单里的「删除会话」**都走它；⚠️ 最后一个会话关不掉，由它自己拒绝） */
  readonly closeSession: (id: string) => void;
  readonly movePalette: (step: 1 | -1) => void;
  readonly closeWindow: () => void;
  readonly fillActive: FillActive;
  readonly resizingRef: { current: ResizeStart | null };
  readonly setSidebarWidth: Dispatch<SetStateAction<number>>;
  readonly setHoveredId: Dispatch<SetStateAction<string | null>>;
  /** 「悬停那一项的『✕』上」（⚠️ 只由 `move` 写：`down` 的命中测试**不看**悬停，见文件头） */
  readonly setSessionCloseHot: Dispatch<SetStateAction<boolean>>;
  readonly setHandleHot: Dispatch<SetStateAction<boolean>>;
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
    scrollSessions,
    openMenu,
    pickMenu,
    closeMenu,
    menuOpen,
    closeSession,
    movePalette,
    closeWindow,
    fillActive,
    resizingRef,
    setSidebarWidth,
    setHoveredId,
    setSessionCloseHot,
    setHandleHot,
    setWindowAt,
  } = deps;

  // ⚠️ `set*` 与 `resizingRef` 不在依赖里：前者是 React 恒定的 setter、后者是恒定的 ref
  useEffect(() => {
    return mouse.onMouse((event: MouseEvent) => {
      if (event.action === "drag" && resizingRef.current !== null) {
        const start = resizingRef.current;
        setSidebarWidth(start.width + (event.x - start.x));
        return;
      }
      switch (event.action) {
        case "move": {
          // ⚠️ **模态开着时背后那一层不认悬停**（与 `down` 同一条纪律）：悬停只决定背景那一层的
          // 底色，而那一层正被遮罩压着 —— 让它改状态等于给一个看不见的东西写状态。
          if (windowKind !== null) return;
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
          // ⚠️ 抬手后底色留着（指针确实还在那一项上）；`drag` / `wheel*` 一个都不接，必须留给终端
          resizingRef.current = null;
          return;
        case "wheelUp":
        case "wheelDown": {
          // ⚠️ **模态开着时滚轮也全被吞掉**：滚轮的两个去处（面板高亮、结果区滚动）都在背后那一层，
          // 屏上被遮罩压着却仍在动 —— 操作者看着一个不动的结果区以为滚轮坏了。
          if (windowKind !== null) return;
          // ⚠️ 两档合成一个 `case`（分开写就得改一处忘一处）；⚠️ 一个滚轮事件只有一个去处：侧边栏上翻
          // 会话清单（那几行与结果区那些行是两块不同的东西），别的位置上翻面板高亮或滚结果区
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
          if (windowKind !== null) {
            if (hitTest(event.x, event.y, [g.windowClose].filter((r) => r !== null)) >= 0) {
              closeWindow();
              return;
            }
            const picked = hitTest(event.x, event.y, g.windowRows);
            if (picked >= 0) setWindowAt(picked);
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
          // 判在会话项之后的话「点菜单里那项」会变成「切到它压着的那一个会话」，菜单永远点不动。
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
              closeSession(pickedSession.id);
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
    scrollSessions,
    openMenu,
    pickMenu,
    closeMenu,
    menuOpen,
    closeSession,
    movePalette,
    closeWindow,
    fillActive,
  ]);
}
