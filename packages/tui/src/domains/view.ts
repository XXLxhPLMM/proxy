/** 视图域：一屏装配。纯推导 + 装配，不返回 JSX。 */
import { useEffect, useMemo } from "react";
import type { MutableRefObject } from "react";
import { complete, type Palette } from "@/commands/index.js";
import type { AccountBody } from "@/api/index.js";
import {
  DEFAULT_REASONING_EFFORT,
  type LedgerError,
  type ModelRecord,
  type ProviderRecord,
  type Target,
} from "@/services/config/index.js";
import {
  clampTop,
  droppedHint,
  flatten,
  normalizeSelection,
  wrapInput,
  type FlatLog,
  type HistoryStep,
} from "@/lib/index.js";
import { connectionStateOf, type ProbeSlot } from "@/ui/theme/index.js";
import type {
  FieldCell,
  LayoutProps,
  MenuView,
  ModelStatusView,
  ModalView,
  PaletteView,
  RenameField,
  SessionRow,
} from "@/ui/components/index.js";
import {
  useUiStore,
  type Bucket,
  type CaretActive,
  type EditActive,
  type FillActive,
  type FormState,
  type MenuState,
  type RenameState,
  type Session,
  type SessionRecord,
  type WindowState,
} from "@/store/index.js";
import type { useHotkeys } from "@/hooks/index.js";
import {
  NO_HISTORY_NOTE,
  asList,
  checkRows,
  filterModels,
  historyRows,
  historyTitle,
  listTitle,
  menuItemsOf,
  modelRows,
  providerIdOf,
  providerRows,
  targetRows,
  userRows,
  type Cell,
  type ModelChoice,
} from "./cells.js";

/** `useHotkeys` 的接线参数（⚠️ 以 `Parameters` 取，不另抄一份：两处各写一份就会漂） */
export type ViewHotkeysDeps = Parameters<typeof useHotkeys>[0];

export interface ViewDeps {
  /* ── 推导输入的值 ── */
  readonly sessions: readonly Session[];
  readonly targets: readonly Target[];
  readonly probes: ReadonlyMap<string, ProbeSlot>;
  readonly modal: WindowState | null;
  readonly modalAt: number;
  readonly modalPending: string | null;
  readonly form: FormState | null;
  readonly rename: RenameState | null;
  readonly menu: MenuState | null;
  readonly menuAt: number;
  readonly palette: Palette;
  readonly accounts: readonly AccountBody[];
  readonly accountsNote: string | null;
  readonly providers: readonly ProviderRecord[];
  readonly providerModels: readonly ModelRecord[];
  readonly modelsNote: string | null;
  readonly modelRefs: readonly string[];
  readonly modelCells: readonly Cell<ModelChoice>[];
  readonly historyCells: readonly Cell<SessionRecord>[];
  readonly historyOrder: readonly string[];
  readonly sidebarIds: ReadonlySet<string>;
  readonly managerNameOf: (id: string) => string | null;
  readonly providerOf: (id: string) => ProviderRecord | undefined;
  readonly filterCursor: number;
  readonly active: Session | null;
  readonly activeId: string | null;
  readonly activeInput: string;
  readonly activeCursor: number;
  readonly activeAnchor: number | null;
  readonly bucket: Bucket;
  readonly historyEntries: readonly string[];
  readonly running: string | null;
  readonly chatting: boolean;
  readonly message: string | null;
  readonly ledgerError: LedgerError | null;
  readonly current: Target | null;
  readonly textTarget: string | null;
  readonly textValue: string;
  readonly textCursor: number;
  readonly textOptions: readonly string[] | null;
  /* ── 一屏的宿主量 ── */
  readonly columns: number;
  readonly rows: number;
  readonly color: boolean;
  readonly version: string;
  readonly sidebarWidth: number;
  readonly sessionsTop: number;
  /* ── 跨帧 ref（读最新一帧 / 写回视口结果） ── */
  readonly viewportRef: MutableRefObject<{ width: number; rows: number }>;
  readonly sessionRowsRef: MutableRefObject<number>;
  readonly historyAtRef: { readonly current: number };
  /* ── 回调：键位接线 ── */
  readonly confirmRename: () => void;
  readonly cancelRename: () => void;
  readonly moveMenu: (step: 1 | -1) => void;
  readonly pickMenu: (index: number | null) => void;
  readonly closeMenu: () => void;
  readonly editText: EditActive;
  readonly caretText: CaretActive;
  readonly editFilter: EditActive;
  readonly fieldTab: (step: 1 | -1) => void;
  readonly fieldArrow: (step: 1 | -1) => void;
  readonly submitForm: () => void;
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
  readonly renameOrCycle: () => void;
  readonly stepSession: (step: 1 | -1) => void;
  readonly detachActiveSession: () => void;
  readonly renameActiveSession: () => void;
  readonly scrollBy: (delta: number) => void;
  readonly scrollTo: (where: "top" | "bottom") => void;
  readonly movePalette: (step: 1 | -1) => void;
  readonly acceptPalette: () => { line: string; cursor: number } | null;
  readonly fillActive: FillActive;
  readonly fillHistory: (step: HistoryStep) => void;
  readonly submit: (raw: string) => void;
}

export interface ViewDomainApi {
  readonly sessionRows: readonly SessionRow[];
  readonly managerStates: readonly ReturnType<typeof connectionStateOf>[];
  readonly filteredModels: readonly ModelRecord[];
  readonly modalNote: string | null;
  readonly closeHint: boolean;
  readonly renameField: RenameField | null;
  readonly flat: FlatLog;
  readonly top: number;
  readonly selection: { readonly start: number; readonly end: number } | null;
  readonly modelStatus: ModelStatusView;
  readonly ghost: string | null;
  readonly notice: string | null;
  readonly paletteView: PaletteView | null;
  readonly menuView: MenuView | null;
  readonly modalView: ModalView | null;
  /** 一屏 `Layout` 的全部 props */
  readonly layout: LayoutProps;
  /** `useHotkeys` 的接线参数（调用方直接展开传入） */
  readonly hotkeys: ViewHotkeysDeps;
}

export function useViewDomain(deps: ViewDeps): ViewDomainApi {
  const {
    sessions, targets, probes, modal, modalAt, modalPending, form, rename, menu, menuAt,
    palette, accounts, accountsNote, providers, providerModels, modelsNote, modelRefs,
    modelCells, historyCells, historyOrder, sidebarIds, managerNameOf, providerOf,
    filterCursor, active, activeId, activeInput, activeCursor, activeAnchor, bucket,
    historyEntries, running, chatting, message, ledgerError, current,
    textTarget, textValue, textCursor, textOptions,
    columns, rows, color, version, sidebarWidth, sessionsTop,
    viewportRef, sessionRowsRef, historyAtRef,
    confirmRename, cancelRename, moveMenu, pickMenu, closeMenu,
    editText, caretText, editFilter, fieldTab, fieldArrow, submitForm,
    escapeModal, moveModalRow, acceptModal, addModalRow, removeModalRow, editModalRow,
    modelsOfProvider, fetchModels, togglePin, cycleReasoning, setPassword, toggleCheck,
    renameOrCycle, stepSession, detachActiveSession, renameActiveSession,
    scrollBy, scrollTo, movePalette, acceptPalette, fillActive, fillHistory, submit,
  } = deps;
  const setViewport = useUiStore((s) => s.setViewport);

  /* ── 侧边栏那几行（⚠️ 认 `id` 不认下标） ──────────────────────────────────── */

  const sessionRows: readonly SessionRow[] = useMemo(
    () =>
      sessions.map((one) => ({
        id: one.id,
        name: one.name,
        manager: targets.find((t) => t.id === one.targetId)?.name ?? null,
        run: one.run,
        seen: one.seen,
      })),
    [sessions, targets],
  );

  /** 台账里每个控制面的连接状态（状态行按它数台数） */
  const managerStates = useMemo(
    () => targets.map((one) => connectionStateOf(probes.get(one.id))),
    [targets, probes],
  );

  /* ── 弹窗视图 ──────────────────────────────────────────── */

  /** `provider-models` 那一档**过滤之后**的那几行（⚠️ **过滤只影响显示**：`picked` 与它无关） */
  const filteredModels: readonly ModelRecord[] = useMemo((): readonly ModelRecord[] => {
    const list = asList(modal);
    return list !== null && list.kind === "provider-models" ? filterModels(providerModels, list.filter) : [];
  }, [modal, providerModels]);

  /** 那一档的空清单说明（`null` = 不占那一行） */
  const modalNote = useMemo((): string | null => {
    const list = asList(modal);
    if (modal === null) return null;
    if (modal.kind === "sessions") return historyOrder.length === 0 ? NO_HISTORY_NOTE : null;
    if (list === null) return null;
    if (list.kind === "targets") {
      return targets.length === 0 ? "台账里还没有控制面 · Ctrl+A 加一个（名字 / 地址 / token / 超时）" : null;
    }
    if (list.kind === "users") {
      if (accountsNote !== null) return accountsNote;
      return accounts.length === 0 ? "这台还没有账号 · Ctrl+A 建一个" : null;
    }
    if (list.kind === "providers") {
      return providers.length === 0 ? "还没有提供商 · Ctrl+A 配一个（地址 / API 格式 / id / 名称 / key）" : null;
    }
    if (list.kind === "models") {
      return modelRefs.length === 0 ? "还没有可选的模型 · 先在 /providers 里配一个提供商，再用 Ctrl+G 拉一份" : null;
    }
    if (list.busy) return "拉取中…";
    if (modelsNote !== null) return modelsNote;
    if (providerModels.length === 0) return "这个提供商还没有模型 · Ctrl+G 从它的 /models 端点拉一次";
    return filteredModels.length === 0 ? "一个都没匹配上" : null;
  }, [modal, historyOrder, targets, accountsNote, accounts, providers, modelRefs, modelsNote, providerModels, filteredModels]);

  /** `esc 关窗` 画不画 */
  const closeHint = rename === null && form === null;

  /* ── 主区宽度与结果区视口（纯 flex，不算坐标） ──────────────────────────── */

  const cols = Math.max(0, Math.trunc(columns));
  const totalRows = Math.max(0, Math.trunc(rows));
  const sidebarVisible = sessionRows.length > 0 && sidebarWidth > 0 && cols >= 60;
  const mainWidth = sidebarVisible ? Math.max(0, cols - Math.trunc(sidebarWidth) - 1) : cols;
  const outputWidth = mainWidth;
  // 输入折行用的显示列：主宽减掉左右框(2)与提示符(2)再留 1 列余量
  const textWidth = Math.max(1, outputWidth - 5);
  const inputRows = useMemo(
    () => wrapInput(activeInput, textWidth).length,
    [activeInput, textWidth],
  );
  const paletteHeight = palette.open ? palette.rows.length : 0;
  // 结果文本可用行：总行减掉输入框(输入行 + 消息 1 + 上下框 2)、模型行 1、状态行 1、滚动提示 1、面板
  const outputRows = Math.max(0, totalRows - inputRows - 6 - paletteHeight);

  useEffect(() => {
    viewportRef.current = { width: outputWidth, rows: outputRows };
    const fit = totalRows <= 0 ? 1 : Math.max(1, Math.floor((totalRows - 1 - 2) / 3) + 1);
    sessionRowsRef.current = fit;
    setViewport({ width: outputWidth, rows: outputRows });
  }, [outputWidth, outputRows, totalRows, viewportRef, sessionRowsRef, setViewport]);

  /** 改名框（原文，超宽由 Ink 截断） */
  const renameField: RenameField | null =
    rename === null
      ? null
      : {
          id: rename.id,
          text: rename.text,
          cursor: rename.cursor,
        };

  const hotkeys: ViewHotkeysDeps = {
    renaming: rename !== null,
    confirmRename,
    cancelRename,
    menuOpen: menu !== null,
    moveMenu,
    pickMenu: () => pickMenu(null),
    closeMenu,
    modalOpen: modal !== null || form !== null,
    formOpen: form !== null,
    textTarget,
    textValue,
    textCursor,
    textOptions,
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
    ctrlR: renameOrCycle,
    stepSession,
    detachActiveSession,
    renameActiveSession,
    scrollBy,
    scrollTo,
    movePalette,
    acceptPalette,
    palette,
    targets,
    input: activeInput,
    cursor: activeCursor,
    textWidth,
    historyEntries,
    historyAt: historyAtRef.current,
    editActive: editText,
    caretActive: caretText,
    fillActive,
    fillHistory,
    submit,
  };

  /* ── 一屏 ────────────────────────────────────────────────────────────────── */

  const flat: FlatLog = useMemo(
    () => flatten(bucket.entries, outputWidth),
    [bucket.entries, outputWidth],
  );
  // ⚠️ 读的时候再夹一次：越界的 `top` 让 `visibleLines` 返回空数组（界面上是「结果区空了」）
  const top = clampTop(flat.height, outputRows, bucket.top);

  /** 选中那一段（⚠️ **`null` = 无选区**；两端已排好序，呈现层不自己比大小） */
  const selection = useMemo((): { readonly start: number; readonly end: number } | null => {
    if (activeAnchor === null) return null;
    const sel = normalizeSelection(activeInput, activeAnchor, activeCursor);
    return sel.start === sel.end ? null : sel;
  }, [activeInput, activeAnchor, activeCursor]);

  /** 「提供商 · 推理强度」那一行（⚠️ **提供商名 = 当前会话那个 provider 的显示名**；`null` = 未选） */
  const modelStatus: ModelStatusView = useMemo((): ModelStatusView => ({
    provider: providers.find((one) => one.id === providerIdOf(active?.modelRef))?.name ?? null,
    reasoning: active?.reasoning ?? DEFAULT_REASONING_EFFORT,
  }), [active?.modelRef, active?.reasoning, providers]);

  /** 补全建议（⚠️ 改名框与表单那几格**一律没有**：那里装的是凭据，而 `/` 会让命令面板浮起来） */
  const focusedText = form !== null || rename !== null;
  const suggestion = focusedText
    ? { line: textValue, cursor: 0, candidates: [] as readonly string[] }
    : complete({
        line: activeInput,
        cursor: activeCursor,
        targetNames: targets.map((one) => one.name),
      });
  /** 幽灵文本 = **「按 Tab 会插进来什么」**，两条来源合成**一个**出口。 */
  const fillable = !focusedText && palette.open ? acceptPalette() : null;
  const ghost =
    fillable !== null && fillable.cursor > activeCursor
      ? fillable.line.slice(activeCursor, fillable.cursor)
      : suggestion.cursor > activeCursor && suggestion.candidates.length > 0
        ? suggestion.line.slice(activeCursor)
        : null;

  /** 输入区中间那一行：四档，⚠️ 改名那一档在弹窗里、不在这儿 */
  const notice =
    running !== null
      ? `执行中：${running}`
      : chatting
        ? "模型那一圈在跑（它可能要来回好几趟）"
        : message ?? (ledgerError === null ? null : `台账读不出来：${ledgerError.message}`);

  /** 命令面板（`null` = 没开）；⚠️ 改名框与表单开着时它**恒不开** */
  const paletteView: PaletteView | null =
    focusedText || !palette.open
      ? null
      : {
          total: palette.rows.length,
          rows: palette.rows.map((row) => ({ text: row.path, summary: row.summary })),
          at: palette.at,
          footer: null,
        };

  /** 会话菜单（`null` = 没开） */
  const menuView: MenuView | null =
    menu === null
      ? null
      : {
          sessionId: menu.sessionId,
          items: menuItemsOf(menu),
          at: menuAt,
          origin: [menu.x, menu.y],
        };

  /** 弹窗此刻是什么（⚠️ **七档判别联合**，判别字段与 `@/store:WindowState.kind` 逐字同名） */
  const modalView: ModalView | null = useMemo((): ModalView | null => {
    if (form !== null) {
      const fields: FieldCell[] = form.fields.map((spec, i) => ({
        kind: spec.options === undefined ? "input" : "select",
        label: spec.label,
        value: form.values[i] ?? "",
        focused: form.at === i,
        cursor: form.cursors[i] ?? 0,
        ...(spec.options === undefined ? {} : { options: spec.options }),
      }));
      return { kind: "provider-form", title: form.title, fields, note: form.note, closeHint: false };
    }
    const list = asList(modal);
    if (modal !== null && modal.kind === "sessions") {
      return {
        kind: "sessions",
        title: historyTitle(historyOrder.length),
        note: modalNote,
        rows: historyRows(historyCells, sidebarIds, managerNameOf, modalPending),
        at: modalAt,
        closeHint,
      };
    }
    if (list === null) return null;
    if (list.kind === "targets") {
      return {
        kind: "targets",
        title: listTitle("控制面", targets.length),
        note: modalNote,
        rows: targetRows(targets, current?.id ?? null, modalPending),
        at: modalAt,
        closeHint,
      };
    }
    if (list.kind === "users") {
      return {
        kind: "users",
        title: listTitle("账号", accounts.length),
        note: modalNote,
        rows: userRows(accounts, modalPending),
        at: modalAt,
        closeHint,
      };
    }
    if (list.kind === "providers") {
      return {
        kind: "providers",
        title: listTitle("提供商", providers.length),
        note: modalNote,
        rows: providerRows(providers, providerIdOf(active?.modelRef), modalPending),
        at: modalAt,
        closeHint,
      };
    }
    if (list.kind === "provider-models") {
      return {
        kind: "provider-models",
        title: `模型 · ${providerOf(list.id)?.name ?? list.id}`,
        filter: { kind: "input", label: "过滤", value: list.filter, focused: true, cursor: filterCursor },
        note: modalNote,
        rows: checkRows(filteredModels, list.id, list.picked, modalPending),
        at: modalAt,
        closeHint,
      };
    }
    return {
      kind: "models",
      title: "模型",
      note: modalNote,
      rows: modelRows(modelCells),
      at: modalAt,
      closeHint,
    };
  }, [
    form,
    modal,
    modalNote,
    modalAt,
    modalPending,
    filterCursor,
    closeHint,
    historyOrder,
    historyCells,
    sidebarIds,
    managerNameOf,
    targets,
    current?.id,
    accounts,
    providers,
    filteredModels,
    modelCells,
    active?.modelRef,
    providerOf,
  ]);

  const layout: LayoutProps = {
    columns: cols,
    rows: totalRows,
    color,
    version,
    sidebarWidth,
    mainWidth,
    outputWidth,
    outputRows,
    sessions: sessionRows,
    sessionsTop,
    selectedSessionId: activeId,
    managerStates,
    flat,
    top,
    input: activeInput,
    cursor: activeCursor,
    inputSelection: selection,
    modelStatus,
    ghost,
    notice,
    showLogo: !flat.any,
    palette: paletteView,
    droppedHint: droppedHint(bucket),
    view: modalView,
    rename: renameField,
    menu: menuView,
  };

  return {
    sessionRows,
    managerStates,
    filteredModels,
    modalNote,
    closeHint,
    renameField,
    flat,
    top,
    selection,
    modelStatus,
    ghost,
    notice,
    paletteView,
    menuView,
    modalView,
    layout,
    hotkeys,
  };
}
