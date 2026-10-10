import { useCallback, useMemo, type MutableRefObject } from "react";
import type { SetStateAction } from "react";
import { paletteFill, paletteOf, paletteStep, type Palette } from "@/commands/index.js";
import type { HistoryStep } from "@/lib/index.js";
import {
  type CaretActive,
  type EditActive,
  type FillActive,
  type FormState,
  type Session,
  useWindowStore,
} from "@/store/index.js";
import { asList, withCursor, withValue } from "./cells.js";

export interface TextDomainDeps {
  /** 会话快照（零会话那一档 `editText` 拿它判断要不要先 `spawnOne`） */
  readonly sessions: readonly Session[];
  readonly activeId: string | null;
  readonly activeInput: string;
  readonly activeCursor: number;
  /** 会话写入口（sessions 域拥有，本 hook 只经 deps 调用） */
  readonly setSessions: (next: SetStateAction<readonly Session[]>) => void;
  /** 零会话那一档：第一个字先造一个会话出来 */
  readonly spawnOne: () => string;
  /** 把当前会话从侧边栏上移出（sessions 域拥有） */
  readonly unpinFromSidebar: (id: string) => void;
  /** 给某一个会话改名（改名框的打开入口在别处，本 hook 只转发） */
  readonly openRename: (id: string) => void;
  /** 输入历史游标（与提交清零共用，归属调用方） */
  readonly historyAtRef: MutableRefObject<number>;
}

export interface TextDomainApi {
  readonly filterText: string | null;
  readonly textTarget: FormState["kind"] | "rename" | "filter" | null;
  readonly textValue: string;
  readonly textCursor: number;
  readonly textOptions: readonly string[] | null;
  readonly editText: EditActive;
  readonly caretText: CaretActive;
  readonly fillActive: FillActive;
  readonly fillHistory: (step: HistoryStep) => void;
  readonly editFilter: EditActive;
  readonly detachActiveSession: () => void;
  readonly renameActiveSession: () => void;
  readonly palette: Palette;
  readonly movePalette: (step: 1 | -1) => void;
  readonly acceptPalette: () => { line: string; cursor: number } | null;
}

export function useTextDomain(deps: TextDomainDeps): TextDomainApi {
  const { sessions, activeId, activeInput, activeCursor, setSessions, spawnOne, unpinFromSidebar, openRename, historyAtRef } =
    deps;
  const modal = useWindowStore((s) => s.modal);
  const setModal = useWindowStore((s) => s.setModal);
  const form = useWindowStore((s) => s.form);
  const setForm = useWindowStore((s) => s.setForm);
  const rename = useWindowStore((s) => s.rename);
  const setRename = useWindowStore((s) => s.setRename);
  const filterCursor = useWindowStore((s) => s.filterCursor);
  const setFilterCursor = useWindowStore((s) => s.setFilterCursor);

  /* ── 三个写入口（键位共用，⚠️ 按「此刻聚焦的是哪个框」分流） ─────────── */

  /** 过滤框此刻装的那一串（⚠️ **`null` = 那一档没开**，而空串是「开着、词是空的」—— 两者屏上分得开） */
  const filterText: string | null = useMemo((): string | null => {
    const list = asList(modal);
    return list !== null && list.kind === "provider-models" ? list.filter : null;
  }, [modal]);

  /** 此刻聚焦的是哪个框（⚠️ **`null` = 没有聚焦的框**，于是键位不必自己猜） */
  // ⚠️ **过滤框也答得出「是哪个框」**：那一档只有它收键，答成「没有框」的话键位分派拿它当
  // 清单那一族，而打印键落在那一族的空操作上 ⇒ 过滤框一个字都敲不进去而屏上零解释。
  const textTarget: FormState["kind"] | "rename" | "filter" | null =
    form !== null ? form.kind : rename !== null ? "rename" : filterText !== null ? "filter" : null;

  /** 那个框此刻装的那一串 */
  const textValue =
    form !== null
      ? (form.values[form.at] ?? "")
      : rename !== null
        ? rename.text
        : (filterText ?? activeInput);
  /** 那个框里的插入符 */
  const textCursor =
    form !== null
      ? (form.cursors[form.at] ?? 0)
      : rename !== null
        ? rename.cursor
        : filterText !== null
          ? filterCursor
          : activeCursor;
  /** 那个框是不是下拉（⚠️ 只有表单里那几格可能是） */
  const textOptions = form === null ? null : (form.fields[form.at]?.options ?? null);

  /** 改**文本**（⚠️ **退格 / 删除 / 打印吃掉整段选区**，而那一段的算法只有一个出口） */
  const editText = useCallback<EditActive>(
    (change) => {
      if (form !== null) {
        const after = change(form.values[form.at] ?? "", form.cursors[form.at] ?? 0, null);
        setForm(withValue(form, form.at, after.text, after.cursor));
        return;
      }
      if (rename !== null) {
        const after = change(rename.text, rename.cursor, null);
        setRename({ id: rename.id, text: after.text, cursor: after.cursor });
        return;
      }
      // ⚠️ **零会话那一档：第一个字就先造一个会话出来**（输入消息 / 敲命令 / `/new` 都先于那一次操作新建）。
      // ⚠️ 不这么做的话那些字**无处可去**（输入行住在会话上），症状是「敲了一串字再按回车什么都没发生」
      const sessionId = sessions.some((one) => one.id === activeId) ? activeId : spawnOne();
      // ⚠️ **锚点是那一改的第三格**：不带它的话退格与提交就不知道要吃掉整段选区
      setSessions((prev) =>
        prev.map((one) =>
          one.id !== sessionId
            ? one
            : (() => {
                const after = change(one.input, one.cursor, one.anchor);
                return { ...one, input: after.text, cursor: after.cursor, anchor: after.anchor };
              })(),
        ),
      );
    },
    [form, rename, activeId, sessions, setSessions, spawnOne],
  );

  /** 移插入符（⚠️ **交回 `{ cursor, anchor }` 两格**：不带 Shift 的移动要清空选区） */
  const caretText = useCallback<CaretActive>(
    (pick) => {
      if (form !== null) {
        setForm(withCursor(form, form.at, pick(form.values[form.at] ?? "", form.cursors[form.at] ?? 0, null).cursor));
        return;
      }
      if (rename !== null) {
        const at = pick(rename.text, rename.cursor, null).cursor;
        setRename((before) => (before === null ? before : { ...before, cursor: at }));
        return;
      }
      setSessions((prev) =>
        prev.map((one) =>
          one.id !== activeId
            ? one
            : (() => {
                const after = pick(one.input, one.cursor, one.anchor);
                return { ...one, cursor: after.cursor, anchor: after.anchor };
              })(),
        ),
      );
    },
    [form, rename, activeId, setSessions],
  );

  /** 写死的那一改（补全已算好的结果 / `Esc` 清行） */
  const fillActive = useCallback<FillActive>(
    (patch) => {
      historyAtRef.current = -1;
      setSessions((prev) => prev.map((one) => (one.id === activeId ? { ...one, ...patch } : one)));
    },
    [activeId, setSessions],
  );

  /** 从命令历史里填一行（⚠️ **与 `fillActive` 分开**：它还得记下「正停在第几条」） */
  const fillHistory = useCallback(
    (step: HistoryStep): void => {
      historyAtRef.current = step.at;
      setSessions((prev) =>
        prev.map((one) =>
          one.id === activeId ? { ...one, input: step.line, cursor: step.cursor, anchor: null } : one,
        ),
      );
    },
    [activeId, setSessions],
  );

  /** 改**过滤框**（⚠️ **只影响显示**：`picked` 一个字节都不动） */
  // ⚠️ **交回来的插入符要存住**：`filter` 只是那一串字，而这一格的插入符在窗态上没有第二格可住。
  // ⚠️ **交回来的 `anchor` 这一格忽略**：单行一个插入符没有选区可言（`Shift+←` 在这一档不存在）。
  const editFilter = useCallback<EditActive>(
    (change) => {
      const list = asList(modal);
      if (list === null || list.kind !== "provider-models") return;
      const after = change(list.filter, filterCursor, null);
      setModal({ ...list, filter: after.text });
      setFilterCursor(after.cursor);
    },
    [modal, filterCursor, setModal, setFilterCursor],
  );

  /** 把**当前**会话从侧边栏上移出（`Ctrl+X`） */
  const detachActiveSession = useCallback((): void => {
    if (activeId === null) return;
    unpinFromSidebar(activeId);
  }, [unpinFromSidebar, activeId]);

  /** 给**当前**会话改名（`Ctrl+R`） */
  const renameActiveSession = useCallback((): void => {
    if (activeId === null) return;
    openRename(activeId);
  }, [openRename, activeId]);

  /* ── 命令面板 ────────────────────────────────────────────────────────────── */

  const palette = useMemo(() => paletteOf(activeInput), [activeInput]);

  const movePalette = useCallback(
    (step: 1 | -1): void => {
      const to = paletteStep(palette.at, step, palette.rows.length);
      const row = palette.rows[to];
      if (row === undefined || to === palette.at) return;
      const filled = paletteFill(activeInput, activeCursor, row);
      fillActive({ input: filled.line, cursor: filled.cursor });
    },
    [palette, activeInput, activeCursor, fillActive],
  );

  const acceptPalette = useCallback((): { line: string; cursor: number } | null => {
    const row = palette.rows[palette.at];
    return row === undefined ? null : paletteFill(activeInput, activeCursor, row);
  }, [palette, activeInput, activeCursor]);

  return {
    filterText,
    textTarget,
    textValue,
    textCursor,
    textOptions,
    editText,
    caretText,
    fillActive,
    fillHistory,
    editFilter,
    detachActiveSession,
    renameActiveSession,
    palette,
    movePalette,
    acceptPalette,
  };
}

/* ── 给指挥官接线用 ──────────────────────────────────────────────────────────
 * 导出的 API 名字清单（TextDomainApi 的字段）：
 *   推导：filterText, textTarget, textValue, textCursor, textOptions
 *   写入口：editText, caretText, fillActive, fillHistory, editFilter
 *   会话快捷动作：detachActiveSession, renameActiveSession
 *   命令面板：palette, movePalette, acceptPalette
 * 调用方需传入的 deps 字段（TextDomainDeps）：
 *   会话快照：sessions, activeId, activeInput, activeCursor
 *   会话写入口：setSessions, spawnOne, unpinFromSidebar, openRename
 * 本 hook 内部自持（调用方不需传）：
 *   跨帧状态经 zustand 选择器直读：modal/setModal, form/setForm,
 *     rename/setRename, filterCursor/setFilterCursor（useWindowStore）
 *   transient 经内部 useRef：historyAtRef（-1 = 不在历史里）
 * 注意：调用方把 AppState 里 modal/form/rename/filterCursor 那四组 useState
 *   迁到 useWindowStore 后，本 hook 读到的才是同一份；接线前两处各持一份会分叉。
 */
