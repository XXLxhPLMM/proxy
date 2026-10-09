/**
 * @fileoverview 根组件：全屏 console 的应用状态层（唯一持有跨帧状态，唯一把一次动作翻成若干次 `setState`）
 */
// ⚠️ `AppProps` 上那**一个**函数字段（`exit`）是组合根边界而不是呈现契约：`LayoutProps`「零个函数字段」
// 那条纪律不许它长到 props 里，而退出必须汇进 `cli.tsx` 那个幂等 `finish(0, null)` ⇒ 状态层只能接一个回调

import { useRef } from "react";

import { type MouseSource } from "@/services/terminal/index.js";
import { Layout } from "@/ui/app.js";

import {
  useSessionsStore,
  useUiStore,
} from "@/store/index.js";
import { useLedgerDomain } from "@/domains/ledger.js";
import { useExecDomain } from "@/domains/exec.js";
import { useViewDomain } from "@/domains/view.js";
import { useTextDomain } from "@/domains/text.js";
import { useWindowDomain } from "@/domains/window.js";
import { useSessionsDomain } from "@/domains/sessions.js";
import { useHotkeys, useMouse, useTerminalSize, type ResizeStart } from "@/hooks/index.js";

export interface AppProps {
  /** 台账文件路径（`@/services/config/path.ts:dbPath` 的产物，由组合根算好） */
  readonly ledgerFile: string;
  /** 终端总列数（组合根那次快照，⚠️ 只是**初值**：屏上用的是 `useTerminalSize` 的当前值） */
  readonly columns: number;
  /** 终端总行数（同上；⚠️ 缺了它就画不出上下分栏） */
  readonly rows: number;
  /** 要不要上色（`NO_COLOR` / `TERM=dumb` / `CI` 由组合根判好） */
  readonly color: boolean;
  /** 版本号（组合根从构建期注入的 `APP_VERSION` 取；空串 = 不知道，状态行右半**整个**不显示它） */
  readonly version: string;
  /** 鼠标事件源（生命周期归组合根；本组件只订阅） */
  readonly mouse: MouseSource;
  /** 退出（`cli.tsx` 把它接到那个幂等 `finish(0, null)` 上；⚠️ **本层零 `process.*`**，故退出码与收尾都在那一侧） */
  readonly exit: () => void;
}

export function App({ ledgerFile, columns, rows, color, version, mouse, exit }: AppProps) {
  /** 终端当前的宽高（props 那两个只是初值；本层零 `process.*`） */
  const size = useTerminalSize({ columns, rows });

  /* ── 跨帧状态（⚠️ 全包只有这一个持有者） ──────────────────────────────────── */

  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const hoveredId = useUiStore((s) => s.hoveredId);
  const setHoveredId = useUiStore((s) => s.setHoveredId);
  const sessionCloseHot = useUiStore((s) => s.sessionCloseHot);
  const setSessionCloseHot = useUiStore((s) => s.setSessionCloseHot);
  const handleHot = useUiStore((s) => s.handleHot);
  const setHandleHot = useUiStore((s) => s.setHandleHot);

  /* 这些 ref 的唯一理由：异步回调要读到「下一次渲染的视角」 */

  const viewportRef = useRef({ width: 0, rows: 0 });
  const sessionRowsRef = useRef(1);
  const resizingRef = useRef<ResizeStart | null>(null);
  /** 输入历史里正停在第几条（⚠️ **`-1` = 不在历史里**；它是一次性游标，故住在 ref 而不是 state） */
  const historyAtRef = useRef(-1);
  /** 正在拖出选区吗（⚠️ **一次 `down` 之后 `drag` 才知道自己在拖框**，而 `up` 收掉它） */
  const textDragRef = useRef(false);

  const {
    sessions,
    activeId,
    active,
    activeInput,
    activeCursor,
    activeAnchor,
    bucket,
    push,
    sayIn,
    say,
    scrollBy,
    scrollTo,
    switchSession,
    revealSession,
    spawnOne,
    ensureSession,
    unpinFromSidebar,
    forgetSessionMessages,
    resetSessionMessages,
  } = useSessionsDomain({ ledgerFile, viewportRef, sessionRowsRef });
  const setSessions = useSessionsStore((s) => s.setSessions);
  const sidebarIds = useSessionsStore((s) => s.sidebarIds);
  const sessionsTop = useSessionsStore((s) => s.sessionsTop);
  const message = useUiStore((s) => s.message);
  const history = useUiStore((s) => s.inputHistory);
  const {
    ledgerError,
    targets,
    current,
    probes,
    providers,
    providerModels,
    accounts,
    accountsNote,
    reprobe,
    refreshProviders,
    bumpModels,
    bumpLedgerTick,
  } = useLedgerDomain({ ledgerFile });
  const {
    modal,
    form,
    filterCursor,
    modelsNote,
    rename,
    menu,
    menuAt,
    historyCells,
    historyOrder,
    modelRefs,
    modelCells,
    modalAt,
    modalPending,
    closeMenu,
    closeModal,
    openHistory,
    managerNameOf,
    openRename,
    confirmRename,
    cancelRename,
    scrollSessions,
    stepSession,
    openMenu,
    moveMenu,
    pickMenu,
    providerOf,
    openTargets,
    openUsers,
    openProviders,
    openModels,
    modelsOfProvider,
    fetchModels,
    removeModalRow,
    moveModalRow,
    escapeModal,
    submitForm,
    fieldTab,
    fieldArrow,
    acceptModal,
    addModalRow,
    editModalRow,
    toggleCheck,
    togglePin,
    cycleReasoning,
    renameOrCycle,
    setPassword,
    pickModalRow,
  } = useWindowDomain({
    ledgerFile,
    switchSession,
    revealSession,
    spawnOne,
    unpinFromSidebar,
    forgetSessionMessages,
    say,
    sayIn,
    refreshProviders,
    bumpModels,
    bumpLedgerTick,
  });

  const {
    textTarget,
    textValue,
    textCursor,
    textOptions,
    editText,
    caretText,
    fillActive,
    fillHistory,
    editFilter,
    textDown,
    textDrag,
    textUp,
    focusFormField,
    detachActiveSession,
    renameActiveSession,
    palette,
    movePalette,
    acceptPalette,
  } = useTextDomain({
    sessions,
    activeId,
    activeInput,
    activeCursor,
    setSessions,
    spawnOne,
    unpinFromSidebar,
    openRename,
    historyAtRef,
    textDragRef,
  });

  const { running, chatting, submit } = useExecDomain({
    ledgerFile,
    exit,
    viewportRef,
    historyAtRef,
    push,
    sayIn,
    spawnOne,
    ensureSession,
    resetSessionMessages,
    openRename,
    openHistory,
    openTargets,
    openUsers,
    openProviders,
    openModels,
    current,
    reprobe,
  });

  const view = useViewDomain({
    sessions,
    targets,
    probes,
    modal,
    modalAt,
    modalPending,
    form,
    rename,
    menu,
    menuAt,
    palette,
    accounts,
    accountsNote,
    providers,
    providerModels,
    modelsNote,
    modelRefs,
    modelCells,
    historyCells,
    historyOrder,
    sidebarIds,
    managerNameOf,
    providerOf,
    filterCursor,
    active,
    activeId,
    activeInput,
    activeCursor,
    activeAnchor,
    bucket,
    historyEntries: history,
    running,
    chatting,
    message,
    ledgerError,
    current,
    textTarget,
    textValue,
    textCursor,
    textOptions,
    columns: size.columns,
    rows: size.rows,
    color,
    version,
    mouse,
    sidebarWidth,
    sessionsTop,
    hoveredId,
    sessionCloseHot,
    handleHot,
    viewportRef,
    sessionRowsRef,
    historyAtRef,
    resizingRef,
    confirmRename,
    cancelRename,
    moveMenu,
    pickMenu,
    closeMenu,
    editText,
    caretText,
    editFilter,
    fieldTab,
    fieldArrow,
    submitForm,
    escapeModal,
    moveModalRow,
    acceptModal,
    addModalRow,
    removeModalRow,
    editModalRow,
    modelsOfProvider,
    fetchModels,
    togglePin,
    cycleReasoning,
    setPassword,
    toggleCheck,
    renameOrCycle,
    stepSession,
    detachActiveSession,
    renameActiveSession,
    scrollBy,
    scrollTo,
    movePalette,
    acceptPalette,
    fillActive,
    fillHistory,
    submit,
    switchSession,
    scrollSessions,
    openMenu,
    unpinFromSidebar,
    closeModal,
    pickModalRow,
    focusFormField,
    textDown,
    textDrag,
    textUp,
    setSidebarWidth,
    setHoveredId,
    setSessionCloseHot,
    setHandleHot,
  });

  useHotkeys(view.hotkeys);
  useMouse(view.mouseDeps);

  return <Layout {...view.layout} />;
}