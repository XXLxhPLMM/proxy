import { useCallback, useMemo } from "react";
import { readTraffic } from "@/commands/index.js";
import {
  DEFAULT_REASONING_EFFORT,
  DEFAULT_TIMEOUT_MS,
  MODEL_API_FORMATS,
  REDACTED_PROVIDER_KEY,
  REDACTED_TOKEN,
  TIMEOUT_BOUNDS,
  targetOf,
  joinModelRef,
  pinSession,
  readLedger,
  readProviderModels,
  readSessions,
  readSidebar,
  redactProviderView,
  redactTarget,
  removeModel,
  removeProvider,
  removeSession,
  removeTarget,
  renameSession,
  setSelected,
  splitModelRef,
  upsertProvider,
  upsertTarget,
  writeLedger,
  writeProviderModels,
  writeSessionModel,
  type ModelRecord,
  type ProviderRecord,
  type ReasoningEffort,
  type Target,
} from "@/services/config/index.js";
import { createAccount, deleteAccount, updateAccount, users, type AccountBody } from "@/api/index.js";
import { listProviderModels } from "@/services/model/index.js";
import { describe, readLedgerSafe } from "@/lib/index.js";
import {
  MODEL_TIMEOUT_MS,
  REASONING_CYCLE,
  newSession,
  useLedgerStore,
  useSessionsStore,
  useWindowStore,
  type FormState,
  type MenuState,
  type RenameState,
  type Session,
  type SessionRecord,
  type WindowState,
} from "@/store/index.js";
import {
  LABEL_FIELDS,
  MENU_DETACH,
  MENU_NEW,
  MENU_RENAME,
  NO_TARGET_NOTE,
  PASSWORD_FIELDS,
  PROVIDER_FIELDS,
  TARGET_FIELDS,
  USER_EDIT_FIELDS,
  USER_ENABLED,
  USER_FIELDS,
  asList,
  cursorsOf,
  filterModels,
  groupOrder,
  idForName,
  ledgerFailure,
  menuItemsOf,
  modelCellsOf,
  withSelect,
  type Cell,
  type ModelChoice,
} from "./cells.js";

export interface WindowDomainDeps {
  readonly ledgerFile: string;
  readonly switchSession: (id: string) => void;
  readonly revealSession: (index: number) => void;
  readonly spawnOne: () => string;
  readonly unpinFromSidebar: (id: string) => void;
  readonly forgetSessionMessages: (id: string) => void;
  readonly say: (text: string) => void;
  readonly sayIn: (sessionId: string | null, text: string) => void;
  readonly refreshProviders: () => void;
  readonly bumpModels: () => void;
  readonly bumpLedgerTick: () => void;
}

export interface WindowDomainApi {
  readonly modal: WindowState | null;
  readonly form: FormState | null;
  readonly behind: WindowState | null;
  readonly historyAt: number;
  readonly filterCursor: number;
  readonly modelsNote: string | null;
  readonly rename: RenameState | null;
  readonly menu: MenuState | null;
  readonly menuAt: number;
  readonly historyCells: readonly Cell<SessionRecord>[];
  readonly historyOrder: readonly string[];
  readonly modelChoices: readonly ModelChoice[];
  readonly pinnedRefs: readonly string[];
  readonly modelOrder: readonly ModelChoice[];
  readonly modelRefs: readonly string[];
  readonly modelCells: readonly Cell<ModelChoice>[];
  readonly modalAt: number;
  readonly modalPending: string | null;
  readonly highlightedId: string | null;
  readonly modalTotal: number;
  readonly closeMenu: () => void;
  readonly closeModal: () => void;
  readonly activateSession: (id: string) => void;
  readonly showHistory: (focus: string | null) => void;
  readonly openHistory: () => void;
  readonly renameHighlighted: () => void;
  readonly managerNameOf: (id: string) => string | null;
  readonly openRename: (id: string) => void;
  readonly confirmRename: () => void;
  readonly cancelRename: () => void;
  readonly scrollSessions: (step: number) => void;
  readonly stepSession: (step: 1 | -1) => void;
  readonly openMenu: (sessionId: string | null, x: number, y: number) => void;
  readonly moveMenu: (step: 1 | -1) => void;
  readonly pickMenu: (index?: number | null) => void;
  readonly useTarget: (sessionId: string, targetId: string) => void;
  readonly providerOf: (id: string) => ProviderRecord | undefined;
  readonly useModel: (sessionId: string | null, ref: string | null, reasoning: ReasoningEffort) => void;
  readonly setModalAt: (next: number | ((before: number) => number)) => void;
  readonly setModal: (next: import("react").SetStateAction<WindowState | null>) => void;
  readonly setForm: (next: import("react").SetStateAction<FormState | null>) => void;
  readonly setRename: (next: import("react").SetStateAction<RenameState | null>) => void;
  readonly setFilterCursor: (next: import("react").SetStateAction<number>) => void;
  readonly setPending: (id: string | null) => void;
  readonly clearPending: () => void;
  readonly loadAccounts: () => void;
  readonly openTargets: () => void;
  readonly openUsers: () => void;
  readonly openProviders: () => void;
  readonly openModels: () => void;
  readonly openProviderModels: (providerId: string) => void;
  readonly modelsOfProvider: () => void;
  readonly saveProviderModels: (models: readonly ModelRecord[]) => void;
  readonly fetchModels: () => void;
  readonly deleteHighlighted: () => void;
  readonly removeModalRow: () => void;
  readonly moveModalRow: (step: 1 | -1) => void;
  readonly escapeModal: () => void;
  readonly openForm: (next: FormState) => void;
  readonly closeFormTo: (state: WindowState) => void;
  readonly openProviderForm: (record: ProviderRecord | null) => void;
  readonly openTargetForm: (record: Target | null) => void;
  readonly openUserForm: (record: AccountBody | null) => void;
  readonly finishProvider: (record: ProviderRecord) => void;
  readonly submitProvider: (draft: FormState) => void;
  readonly submitTarget: (draft: FormState) => void;
  readonly submitUser: (draft: FormState) => void;
  readonly submitPassword: (draft: FormState) => void;
  readonly submitLabel: (draft: FormState) => void;
  readonly submitForm: () => void;
  readonly fieldTab: (step: 1 | -1) => void;
  readonly fieldArrow: (step: 1 | -1) => void;
  readonly acceptModal: () => void;
  readonly addModalRow: () => void;
  readonly editModalRow: () => void;
  readonly toggleCheck: () => void;
  readonly togglePin: () => void;
  readonly cycleReasoning: () => void;
  readonly renameOrCycle: () => void;
  readonly setPassword: () => void;
  readonly pickModalRow: (at: number) => void;
}

export function useWindowDomain(deps: WindowDomainDeps): WindowDomainApi {
  const {
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
  } = deps;

  const modal = useWindowStore((s) => s.modal);
  const form = useWindowStore((s) => s.form);
  const behind = useWindowStore((s) => s.behind);
  const historyAt = useWindowStore((s) => s.historyAt);
  const filterCursor = useWindowStore((s) => s.filterCursor);
  const modelsNote = useWindowStore((s) => s.modelsNote);
  const rename = useWindowStore((s) => s.rename);
  const menu = useWindowStore((s) => s.menu);
  const menuAt = useWindowStore((s) => s.menuAt);
  const setModal = useWindowStore((s) => s.setModal);
  const setForm = useWindowStore((s) => s.setForm);
  const setBehind = useWindowStore((s) => s.setBehind);
  const setHistoryAt = useWindowStore((s) => s.setHistoryAt);
  const setFilterCursor = useWindowStore((s) => s.setFilterCursor);
  const setModelsNote = useWindowStore((s) => s.setModelsNote);
  const setRename = useWindowStore((s) => s.setRename);
  const setMenu = useWindowStore((s) => s.setMenu);
  const setMenuAt = useWindowStore((s) => s.setMenuAt);
  const closeModal = useWindowStore((s) => s.closeModal);

  const sessions = useSessionsStore((s) => s.sessions);
  const activeId = useSessionsStore((s) => s.activeId);
  const historyRecords = useSessionsStore((s) => s.historyRecords);
  const setSessions = useSessionsStore((s) => s.setSessions);
  const setActiveId = useSessionsStore((s) => s.setActiveId);
  const setHistoryRecords = useSessionsStore((s) => s.setHistoryRecords);
  const setSidebarIds = useSessionsStore((s) => s.setSidebarIds);
  const setSessionsTop = useSessionsStore((s) => s.setSessionsTop);
  const active: Session | null = useMemo(
    () => sessions.find((one) => one.id === activeId) ?? null,
    [sessions, activeId],
  );

  const ledger = useLedgerStore((s) => s.ledger);
  const providers = useLedgerStore((s) => s.providers);
  const providerModels = useLedgerStore((s) => s.providerModels);
  const modelTick = useLedgerStore((s) => s.modelTick);
  const accounts = useLedgerStore((s) => s.accounts);
  const setLedger = useLedgerStore((s) => s.setLedger);
  const setProviderModels = useLedgerStore((s) => s.setProviderModels);
  const setAccounts = useLedgerStore((s) => s.setAccounts);
  const setAccountsNote = useLedgerStore((s) => s.setAccountsNote);
  const targets: readonly Target[] = useMemo(() => ledger?.targets ?? [], [ledger]);
  const current: Target | null = useMemo(
    () => targets.find((one) => one.id === active?.targetId) ?? null,
    [targets, active?.targetId],
  );

  /* ── 写入口 ──────────────────────────────────────────────────────────────── */

  const closeMenu = useCallback((): void => setMenu(null), []);

  /** 激活某一个历史会话（弹窗里 `Enter` 或**点那一行**） */
  const activateSession = useCallback(
    (id: string): void => {
      const known = sessions.some((one) => one.id === id);
      const at = known ? sessions.findIndex((one) => one.id === id) : sessions.length;
      if (!known) {
        const name = historyRecords.find((one) => one.id === id)?.name ?? `会话 ${id}`;
        setSessions((prev) => [...prev, newSession(id, name)]);
      }
      setActiveId(id);
      revealSession(at);
      try {
        pinSession(ledgerFile, id, Date.now());
        setSidebarIds((before) => (before.has(id) ? before : new Set(before).add(id)));
      } catch (err) {
        say(`这个会话没激活进侧边栏（${describe(err)}）—— 关掉就没了`);
      }
      closeModal();
    },
    [historyRecords, ledgerFile, say, revealSession, closeModal, setSessions],
  );

  /** 弹窗里**可选会话**的 `id`，按屏上顺序（⚠️ 剔除标题槽，而高亮数的就是它们） */
  const historyCells: readonly Cell<SessionRecord>[] = useMemo(
    () => (modal === null || modal.kind !== "sessions" ? [] : groupOrder(historyRecords, Date.now())),
    [modal, historyRecords],
  );

  const historyOrder: readonly string[] = useMemo(
    () => historyCells.flatMap((cell) => (cell.kind === "row" ? [cell.item.id] : [])),
    [historyCells],
  );

  /** 弹出历史会话弹窗（⚠️ `focus` 为 `null` 时高亮落在**当前会话**那一行） */
  const showHistory = useCallback(
    (focus: string | null): void => {
      // ⚠️ **现读盘**：本会话里那份 `historyRecords` 是**启动那一刻**的快照
      let fresh: readonly SessionRecord[] = historyRecords;
      try {
        fresh = readSessions(ledgerFile);
        setHistoryRecords(fresh);
        setSidebarIds(new Set(readSidebar(ledgerFile).map((one) => one.sessionId)));
      } catch (err) {
        say(`会话清单读不出来（${describe(err)}）—— 那个弹窗显示为空`);
      }
      setForm(null);
      setBehind(null);
      setRename(null);
      // ⚠️ **下标数的是「可选会话」而不是「第几槽」**：拿槽位下标去数会把标题行算进去
      const selectable = groupOrder(fresh, Date.now()).flatMap((cell) =>
        cell.kind === "row" ? [cell.item.id] : [],
      );
      setHistoryAt(Math.max(0, selectable.indexOf(focus ?? activeId ?? "")));
      setModal({ kind: "sessions" });
      closeMenu();
    },
    [historyRecords, activeId, ledgerFile, say, closeMenu],
  );

  const openHistory = useCallback((): void => showHistory(null), [showHistory]);

  /** 弹窗里 `Ctrl+R`：给**高亮那一行**开改名框 */
  const renameHighlighted = useCallback((): void => {
    const id = historyOrder[historyAt];
    if (id === undefined) return;
    const name = sessions.find((one) => one.id === id)?.name
      ?? historyRecords.find((one) => one.id === id)?.name;
    if (name === undefined) return;
    showHistory(id);
    setRename({ id, text: name, cursor: name.length });
  }, [historyOrder, historyAt, sessions, historyRecords, showHistory]);

  /** 某个会话连的是哪台控制面（⚠️ 弹窗里那一列答的是同一件事，故**这一处**是唯一的换算） */
  const managerNameOf = useCallback(
    (id: string): string | null => {
      const one = sessions.find((row) => row.id === id);
      if (one === undefined) return null;
      return targets.find((t) => t.id === one.targetId)?.name ?? null;
    },
    [sessions, targets],
  );

  /** 给某一个会话改名（`/rename`、`Ctrl+R` 与菜单里的「重命名」是同一个入口） */
  const openRename = useCallback(
    (id: string): void => {
      const name = sessions.find((one) => one.id === id)?.name
        ?? historyRecords.find((one) => one.id === id)?.name;
      if (name === undefined) return;
      // ⚠️ **改名框只住在弹窗里**（`Composer` 不参与）：故这几个入口都得先把弹窗打开
      showHistory(id);
      setRename({ id, text: name, cursor: name.length });
    },
    [sessions, historyRecords, showHistory],
  );

  /** 确认改名（⚠️ **空串不认**：一个空名字在侧边栏上就是一个空盒子，而空盒子点不中也读不出） */
  const confirmRename = useCallback((): void => {
    if (rename === null) return;
    const name = rename.text.trim();
    if (name === "") {
      say("名字不能是空的 —— 取消就是不改");
      return;
    }
    const id = rename.id;
    setRename(null);
    if (sessions.find((one) => one.id === id)?.name === name) return;
    setSessions((prev) => prev.map((one) => (one.id === id ? { ...one, name } : one)));
    setHistoryRecords((prev) => prev.map((one) => (one.id === id ? { ...one, name, updatedAt: Date.now() } : one)));
    try {
      renameSession(ledgerFile, id, name, Date.now());
    } catch (err) {
      say(`这次改名没存进台账（${describe(err)}）—— 关掉就没了`);
    }
  }, [rename, sessions, ledgerFile, say, setSessions]);

  const cancelRename = useCallback((): void => setRename(null), []);

  /* ── 侧边栏那一列：点选 / 滚动 / 菜单 / 切会话 ────────────────────────────── */

  const scrollSessions = useCallback((step: number): void => {
    setSessionsTop((before) => Math.max(0, before + step));
  }, []);

  /** 下一个 / 上一个会话（`Ctrl+↑↓` / `Ctrl+N` `Ctrl+P`；**没有就什么都不做**） */
  const stepSession = useCallback(
    (step: 1 | -1): void => {
      const list = sessions;
      if (list.length < 2) {
        if (list.length === 1) say("只有 1 个会话，按 /new 可以再开一个");
        return;
      }
      const at = list.findIndex((one) => one.id === activeId);
      const to = (Math.max(0, at) + step + list.length) % list.length;
      const picked = list[to];
      if (picked === undefined) return;
      switchSession(picked.id);
      revealSession(to);
    },
    [activeId, switchSession, say, revealSession],
  );

  const openMenu = useCallback((sessionId: string | null, x: number, y: number): void => {
    setMenuAt(0);
    setMenu({ sessionId, x, y });
  }, []);

  const moveMenu = useCallback(
    (step: 1 | -1): void => {
      const count = menuItemsOf(menu).length;
      if (count === 0) return;
      setMenuAt((before) => Math.max(0, Math.min(count - 1, before + step)));
    },
    [menu],
  );

  const pickMenu = useCallback(
    (index: number | null = null): void => {
      if (menu === null) return;
      const items = menuItemsOf(menu);
      const at = index ?? menuAt;
      const target = menu.sessionId;
      setMenu(null);
      const label = items[at];
      if (label === undefined) return;
      if (target === null) {
        spawnOne();
        return;
      }
      if (label === MENU_DETACH) unpinFromSidebar(target);
      else if (label === MENU_RENAME) openRename(target);
      else if (label === MENU_NEW) spawnOne();
    },
    [menu, menuAt, spawnOne, unpinFromSidebar, openRename],
  );

  /** 让某一个会话连上某一个控制面（现读现写；⚠️ 写失败不回滚 —— 它确实已经发生了） */
  const useTarget = useCallback(
    (sessionId: string, targetId: string): void => {
      setSessions((prev) => prev.map((one) => (one.id === sessionId ? { ...one, targetId } : one)));
      let failure: string | null = null;
      try {
        writeLedger(ledgerFile, setSelected(readLedger(ledgerFile), targetId));
      } catch (err) {
        failure = describe(err);
      }
      setLedger(readLedgerSafe(ledgerFile));
      bumpLedgerTick();
      if (failure !== null) {
        sayIn(sessionId, `这次切换没存进台账（${failure}）—— 界面上已经切过去了，关掉就没了`);
      }
    },
    [ledgerFile, setLedger, sayIn, setSessions],
  );

  /* ── 模型选项 ────────────────────────────────────────────────────────────── */

  /** 全部可选模型（⚠️ **逐份现读**：模型清单是每个提供商自己那张表，而没有一份「全部」的读面） */
  const modelChoices: readonly ModelChoice[] = useMemo((): readonly ModelChoice[] => {
    const out: ModelChoice[] = [];
    for (const provider of providers) {
      let list: readonly ModelRecord[] = [];
      try {
        list = readProviderModels(ledgerFile, provider.id);
      } catch {
        list = [];
      }
      for (const model of list) {
        try {
          out.push({
            ref: joinModelRef(provider.id, model.modelId),
            providerId: provider.id,
            provider: provider.name,
            label: model.label,
            pinned: model.pinned,
          });
        } catch {
          // ⚠️ `joinModelRef` 抛的是编程错误（providerId 含 `/`）；跳过那一行而不是让整个弹窗起不来
        }
      }
    }
    return out;
  }, [providers, ledgerFile, modelTick]);

  const pinnedRefs: readonly string[] = useMemo(
    () => modelChoices.filter((one) => one.pinned).map((one) => one.ref),
    [modelChoices],
  );

  /** `/models` 弹窗里可选模型按屏上顺序（⚠️ **跨组连续**：置顶的一组在前，其余按提供商分组） */
  const modelOrder: readonly ModelChoice[] = useMemo(
    () => modelChoices.filter((one) => one.pinned).concat(modelChoices.filter((one) => !one.pinned)),
    [modelChoices],
  );

  const modelRefs: readonly string[] = useMemo(() => modelOrder.map((one) => one.ref), [modelOrder]);

  const modelCells: readonly Cell<ModelChoice>[] = useMemo(
    () => modelCellsOf(modelOrder, pinnedRefs),
    [modelOrder, pinnedRefs],
  );

  /** 某一个提供商（⚠️ 查找只有这一处，而它在三个地方被问） */
  const providerOf = useCallback(
    (id: string): ProviderRecord | undefined => providers.find((one) => one.id === id),
    [providers],
  );

  /** 某一个会话选的模型写进内存 + 落盘（⚠️ **那两列单独写**，而不进会话的身份那几列） */
  const useModel = useCallback(
    (sessionId: string | null, ref: string | null, reasoning: ReasoningEffort): void => {
      if (sessionId === null) return;
      setSessions((prev) => prev.map((one) => (one.id === sessionId ? { ...one, modelRef: ref, reasoning } : one)));
      try {
        writeSessionModel(ledgerFile, sessionId, ref, reasoning);
      } catch (err) {
        sayIn(sessionId, `这次的模型选择没存进台账（${describe(err)}）—— 关掉就没了`);
      }
    },
    [ledgerFile, setSessions, sayIn],
  );

  /* ── 弹窗：高亮与「待确认删除」 ──────────────────────────────────────────── */

  /** 弹窗高亮落在第几行（⚠️ `sessions` 那一档的那一格住在状态层，而窗态那一档没有它） */
  const modalAt = modal === null ? -1 : modal.kind === "sessions" ? historyAt : (asList(modal)?.at ?? -1);

  /** 待确认删除的是哪一个（⚠️ 判据是「这一格还等着第二次确认吗」，与「它被删了吗」无关） */
  // ⚠️ **六个 `kind` 共读那一格**：它住在窗态上，于是「哪一个 id 在等第二次」只有一个持有者 ——
  // 状态层再存一份的话「关窗重开那一格还在等」与「换个弹窗回来它跟着走了」两种屏面都造得出来。
  const modalPending = modal?.pending ?? null;

  const setModalAt = useCallback(
    (next: number | ((before: number) => number)): void => {
      if (modal === null) return;
      const resolve = (before: number): number => (typeof next === "function" ? next(before) : next);
      if (modal.kind === "sessions") {
        setHistoryAt(resolve);
        return;
      }
      const list = asList(modal);
      if (list === null) return;
      setModal({ ...list, at: resolve(list.at) });
    },
    [modal],
  );

  /** 记下 / 清掉「待确认删除」（⚠️ **六档共用同一格**：判据是 `kind`，而它住在窗态上） */
  const setPending = useCallback((id: string | null): void => {
    // ⚠️ **更新函数而不是闭包里那一份**：同一个事件里 `moveModalRow` 先挪 `at` 再清 `pending`，
    // 而两个 setter 在同一批里按序应用 —— 第二个若拿闭包里**旧**的那份整个覆盖回去，
    // 高亮就永远挪不动（症状是「`↓` 按一百次高亮也不动」，而代码里两处都看着对）
    setModal((before) => (before === null ? before : { ...before, pending: id ?? undefined }));
  }, []);

  /** `Esc` 的第一级：取消待确认删除（⚠️ 挂着的「确认」比误删更可怕） */
  const clearPending = useCallback((): void => setPending(null), [setPending]);

  /* ── 账号清单（⚠️ 与用户**要一个客户端**） ────────────────────────────────── */

  /** 读一遍当前控制面的账号清单（⚠️ **没选中控制面时一个请求都不许发**） */
  const loadAccounts = useCallback((): void => {
    if (current === null) {
      setAccounts([]);
      setAccountsNote(NO_TARGET_NOTE);
      return;
    }
    void users(targetOf(current))
      .then((body) => {
        // ⚠️ **按 username 升序**：同一份数据两次渲染出同一个顺序，两条路才对照着看
        setAccounts([...body.accounts].sort((a, b) => (a.username < b.username ? -1 : 1)));
        setAccountsNote(null);
      })
      .catch((err: unknown) => {
        setAccounts([]);
        setAccountsNote(`账号清单读不出来（${describe(err)}）`);
      });
  }, [current, setAccounts]);

  /* ── 弹窗：开窗 ──────────────────────────────────────────────────────────── */

  const openTargets = useCallback((): void => {
    setForm(null);
    setBehind(null);
    setRename(null);
    // ⚠️ 高亮**默认落在当前会话连的那一台**上：落在第 0 行的话「打开就回车」会静默接到另一台
    setModal({ kind: "targets", at: Math.max(0, targets.findIndex((one) => one.id === active?.targetId)) });
    closeMenu();
  }, [targets, active?.targetId, closeMenu]);

  const openUsers = useCallback((): void => {
    setForm(null);
    setBehind(null);
    setRename(null);
    setModal({ kind: "users", at: 0 });
    closeMenu();
    loadAccounts();
  }, [closeMenu, loadAccounts]);

  const openProviders = useCallback((): void => {
    refreshProviders();
    setForm(null);
    setBehind(null);
    setRename(null);
    setModal({ kind: "providers", at: 0 });
    closeMenu();
  }, [refreshProviders, closeMenu]);

  const openModels = useCallback((): void => {
    setForm(null);
    setBehind(null);
    setRename(null);
    setModal({ kind: "models", at: 0, pinned: pinnedRefs });
    closeMenu();
  }, [pinnedRefs, closeMenu]);

  /** 某一个提供商的模型清单那一档（`Ctrl+M`；⚠️ 勾选从现有清单起步，于是「全不勾」是用户自己能走到的） */
  const openProviderModels = useCallback(
    (providerId: string): void => {
      let list: readonly ModelRecord[] = [];
      try {
        list = readProviderModels(ledgerFile, providerId);
      } catch (err) {
        say(`模型清单读不出来（${describe(err)}）`);
      }
      setProviderModels(list);
      setModelsNote(null);
      setFilterCursor(0);
      setModal({
        kind: "provider-models",
        id: providerId,
        at: 0,
        filter: "",
        picked: new Set(list.map((one) => one.modelId)),
        busy: false,
      });
    },
    [ledgerFile, say],
  );

  const modelsOfProvider = useCallback((): void => {
    const list = asList(modal);
    if (list === null || list.kind !== "providers") return;
    const picked = providers[list.at];
    if (picked === undefined) return;
    openProviderModels(picked.id);
  }, [modal, providers, openProviderModels]);

  /* ── `provider-models` 那一档：整份落盘与拉取 ────────────────────────────── */

  /** 把那一档的勾选整份落盘（⚠️ **一次事务**：半份勾上就是半份模型不见了） */
  const saveProviderModels = useCallback(
    (models: readonly ModelRecord[]): void => {
      const list = asList(modal);
      if (list === null || list.kind !== "provider-models") return;
      const kept = models.filter((one) => list.picked.has(one.modelId));
      setProviderModels(kept);
      try {
        writeProviderModels(ledgerFile, list.id, kept);
        bumpModels();
      } catch (err) {
        say(`模型清单存不进去（${describe(err)}）`);
      }
    },
    [modal, ledgerFile, bumpModels, say],
  );

  /** 从该提供商的 `/models` 端点拉一次清单并**全选**（`Ctrl+G`） */
  const fetchModels = useCallback((): void => {
    const list = asList(modal);
    if (list === null || list.kind !== "provider-models" || list.busy) return;
    const provider = providerOf(list.id);
    if (provider === undefined) return;
    setModelsNote(null);
    setModal({ ...list, busy: true });
    void listProviderModels({
      api: provider.api,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: "",
      messages: [],
      reasoning: active?.reasoning ?? DEFAULT_REASONING_EFFORT,
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    })
      .then((listing) => {
        const known = new Set(providerModels.map((one) => one.modelId));
        const added = listing
          .filter((one) => !known.has(one.modelId))
          .map((one) => ({ providerId: list.id, modelId: one.modelId, label: one.label, pinned: false }));
        const picked = new Set(list.picked);
        for (const one of listing) picked.add(one.modelId);
        const merged = [...providerModels, ...added];
        setProviderModels(merged);
        try {
          writeProviderModels(ledgerFile, list.id, merged.filter((one) => picked.has(one.modelId)));
        } catch (err) {
          say(`模型清单存不进去（${describe(err)}）`);
        }
        setModal((before) => (before !== null && before.kind === "provider-models" ? { ...before, busy: false, picked } : before));
        bumpModels();
      })
      .catch((err: unknown) => {
        // ⚠️ 失败留在**说明行**上而不是只弹一句瞬时消息：这一档的成果就在这一屏里
        setModelsNote(`模型清单拉不下来（${describe(err)}）`);
        setModal((before) => (before !== null && before.kind === "provider-models" ? { ...before, busy: false } : before));
      });
  }, [modal, providerOf, providerModels, active?.reasoning, ledgerFile, bumpModels, say]);

  /* ── 弹窗：删除（两段 `Ctrl+D`） ──────────────────────────────────────────── */

  /** 高亮那一行的 id（⚠️ **判据是 `kind`** —— 而每一档的「哪一行」不是同一件事） */
  const highlightedId = useMemo((): string | null => {
    if (modal === null) return null;
    if (modal.kind === "sessions") return historyOrder[modalAt] ?? null;
    if (modal.kind === "targets") return targets[modal.at]?.id ?? null;
    if (modal.kind === "users") return accounts[modal.at]?.username ?? null;
    if (modal.kind === "providers") return providers[modal.at]?.id ?? null;
    const list = asList(modal);
    if (list === null) return null;
    if (list.kind === "models") return modelRefs[list.at] ?? null;
    if (list.kind !== "provider-models") return null;
    return filterModels(providerModels, list.filter)[list.at]?.modelId ?? null;
  }, [modal, modalAt, historyOrder, targets, accounts, providers, modelRefs, providerModels]);

  /** 弹窗里可选项一共几个（⚠️ **数的是「可选行」**；`provider-models` 数**过滤之后**的那些） */
  const modalTotal = useMemo((): number => {
    if (modal === null) return 0;
    if (modal.kind === "sessions") return historyOrder.length;
    if (modal.kind === "targets") return targets.length;
    if (modal.kind === "users") return accounts.length;
    if (modal.kind === "providers") return providers.length;
    const list = asList(modal);
    if (list === null) return 0;
    if (list.kind === "models") return modelRefs.length;
    if (list.kind !== "provider-models") return 0;
    return filterModels(providerModels, list.filter).length;
  }, [modal, historyOrder, targets, accounts, providers, modelRefs, providerModels]);

  /** 弹窗里 `Ctrl+D` 的**第二段**：真的删掉高亮那一行 */
  const deleteHighlighted = useCallback((): void => {
    const list = asList(modal);
    if (modal === null) return;
    if (modal.kind === "sessions") {
      const id = historyOrder[modalAt];
      if (id === undefined) return;
      try {
        removeSession(ledgerFile, id);
      } catch (err) {
        say(`这个会话没删掉（${describe(err)}）—— 重开一次它还在那儿`);
        return;
      }
      setHistoryRecords((prev) => prev.filter((one) => one.id !== id));
      setSidebarIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      forgetSessionMessages(id);
      const at = sessions.findIndex((one) => one.id === id);
      if (at >= 0) {
        const rest = sessions.filter((one) => one.id !== id);
        setSessions(rest);
        if (activeId === id) {
          const picked = rest[0];
          // ⚠️ **删掉最后一个会话之后没有当前会话**（不是凭空造一个）—— 侧边栏那一列因此整列让位
          setActiveId(picked?.id ?? null);
          if (picked !== undefined) revealSession(0);
        } else {
          setSessionsTop((before) => Math.max(0, before - (at < before ? 1 : 0)));
        }
      }
      // ⚠️ **高亮不许越界**：删掉一行之后下标夹回最后一行的位置
      setHistoryAt((before) => Math.min(before, Math.max(0, historyOrder.length - 2)));
      return;
    }
    if (list === null) return;
    if (list.kind === "targets") {
      const picked = targets[list.at];
      if (picked === undefined) return;
      try {
        writeLedger(ledgerFile, removeTarget(readLedger(ledgerFile), picked.id));
      } catch (err) {
        say(`这个控制面没删掉（${describe(err)}）—— 重开一次它还在那儿`);
        return;
      }
      setLedger(readLedgerSafe(ledgerFile));
      bumpLedgerTick();
      return;
    }
    if (list.kind === "providers") {
      const picked = providers[list.at];
      if (picked === undefined) return;
      try {
        removeProvider(ledgerFile, picked.id);
      } catch (err) {
        say(`这个提供商没删掉（${describe(err)}）—— 重开一次它还在那儿`);
        return;
      }
      refreshProviders();
      bumpModels();
      return;
    }
    if (list.kind === "users") {
      const picked = accounts[list.at];
      // ⚠️ **没选中控制面时一个请求都不许发**（账号表属于某一台，而那一台此刻是空的）
      if (picked === undefined || current === null) return;
      void deleteAccount(targetOf(current), picked.username)
        .then((result) => sayIn(activeId, result.message))
        .catch((err: unknown) => sayIn(activeId, `这个账号没删掉（${describe(err)}）`));
      loadAccounts();
      return;
    }
    if (list.kind === "models") {
      const ref = modelRefs[list.at];
      const split = ref === undefined ? null : splitModelRef(ref);
      if (split === null) return;
      try {
        removeModel(ledgerFile, split.providerId, split.modelId);
      } catch (err) {
        say(`这个模型没删掉（${describe(err)}）`);
        return;
      }
      bumpModels();
      return;
    }
    // ⚠️ `provider-models` 那一档的「去掉」= 从**勾选**里拿掉（整份清单由 `Esc` 那一步落盘）
    const record = filterModels(providerModels, list.filter)[list.at];
    if (record === undefined) return;
    const picked = new Set(list.picked);
    picked.delete(record.modelId);
    // ⚠️ **更新函数而不是闭包里那一份**：第二段 `Ctrl+D` 先清 `pending` 再删，而闭包里那一份还挂着
    // 那个 id —— 拿它整个覆盖回去的话刚删掉的那一行会**留在警告色上**，而下一段删的是别的那一行。
    setModal((before) =>
      before !== null && before.kind === "provider-models" ? { ...before, picked } : before,
    );
  }, [
    modal,
    modalAt,
    activeId,
    ledgerFile,
    historyOrder,
    targets,
    providers,
    accounts,
    modelRefs,
    providerModels,
    current,
    loadAccounts,
    refreshProviders,
    bumpModels,
    say,
    sayIn,
    revealSession,
    setSessions,
    setLedger,
  ]);

  /** 弹窗里 `Ctrl+D`：**两段**（第一次记下那个 id，第二次才真删） */
  const removeModalRow = useCallback((): void => {
    const id = highlightedId;
    if (id === null) return;
    if (modalPending === id) {
      setPending(null);
      deleteHighlighted();
      return;
    }
    setPending(id);
  }, [highlightedId, modalPending, setPending, deleteHighlighted]);

  /** 弹窗里 `↑`/`↓` 走一行（⚠️ 走到底就停住，不循环） */
  const moveModalRow = useCallback(
    (step: 1 | -1): void => {
      const last = Math.max(0, modalTotal - 1);
      const next = Math.max(0, Math.min(last, modalAt + step));
      setModalAt(next);
      // ⚠️ **换 `at` 清掉待确认删除**：挂着的「确认」比误删更可怕
      if (next !== modalAt) clearPending();
    },
    [modalAt, modalTotal, setModalAt, clearPending],
  );

  /** 弹窗里 `Esc`：**先取消待确认删除，再退一层**（表单 → 上一层清单 → 关窗） */
  const escapeModal = useCallback((): void => {
    if (modalPending !== null) {
      clearPending();
      return;
    }
    if (form !== null) {
      // ⚠️ **表单是盖在清单上的一层**：取消它回**上一层**清单，而不是把整个弹窗关掉
      setForm(null);
      const back = behind;
      setBehind(null);
      setModal(back);
      return;
    }
    const list = asList(modal);
    if (list !== null && list.kind === "provider-models") {
      // ⚠️ **这一档的 `Esc` 是「保存并回列表」**：勾选与整份清单在这一趟里落盘
      saveProviderModels(providerModels);
      setModal({ kind: "providers", at: 0 });
      return;
    }
    closeModal();
  }, [modalPending, form, behind, modal, clearPending, closeModal, saveProviderModels, providerModels]);

  /* ── 表单 ────────────────────────────────────────────────────────────────── */

  /** 开一份表单（⚠️ **上一层清单记在 `behind`** —— 表单不是平级窗口，而是盖在清单上的一层） */
  const openForm = useCallback(
    (next: FormState): void => {
      setBehind(modal);
      setRename(null);
      setForm(next);
    },
    [modal],
  );

  /** 提交 / 取消之后回到**上一层**清单（⚠️ 高亮跟着刚改的那一个走） */
  const closeFormTo = useCallback((state: WindowState): void => {
    setForm(null);
    setBehind(null);
    setModal(state);
  }, []);

  const openProviderForm = useCallback(
    (record: ProviderRecord | null): void => {
      const view = record === null ? null : redactProviderView(record);
      const values = [
        view?.baseUrl ?? "",
        view?.api ?? MODEL_API_FORMATS[0],
        view?.id ?? "",
        view?.name ?? "",
        // ⚠️ **凭据那一格恒是掩码或空串**：留空 = 不改这一项（不是「改成空」）
        view?.apiKey ?? "",
      ];
      openForm({
        kind: "provider",
        id: record?.id ?? null,
        title: record === null ? "新增提供商" : "编辑提供商",
        fields: PROVIDER_FIELDS,
        values,
        cursors: cursorsOf(values),
        at: 0,
        note: null,
        username: "",
        ref: "",
      });
    },
    [openForm],
  );

  const openTargetForm = useCallback(
    (record: Target | null): void => {
      const values = [
        record?.name ?? "",
        record?.baseUrl ?? "",
        // ⚠️ **token 那一格恒是掩码或空串**，而掩码 = 「不改这一项」
        record === null ? "" : redactTarget(record).token,
        String(record?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      ];
      openForm({
        kind: "target",
        id: record?.id ?? null,
        title: record === null ? "新增控制面" : "编辑控制面",
        fields: TARGET_FIELDS,
        values,
        cursors: cursorsOf(values),
        at: 0,
        note: null,
        username: "",
        ref: "",
      });
    },
    [openForm],
  );

  const openUserForm = useCallback(
    (record: AccountBody | null): void => {
      const fields = record === null ? USER_FIELDS : USER_EDIT_FIELDS;
      const values =
        record === null
          ? ["", "", "", USER_ENABLED[0]]
          : [record.username, String(record.quota?.bytes ?? 0), record.disabled ? USER_ENABLED[1] : USER_ENABLED[0]];
      openForm({
        kind: "user",
        id: record?.username ?? null,
        title: record === null ? "新增账号" : "编辑账号",
        fields,
        values,
        cursors: cursorsOf(values),
        at: 0,
        note: null,
        username: record?.username ?? "",
        ref: "",
      });
    },
    [openForm],
  );

  /** 真正落盘那一个提供商（⚠️ **现读现写**；写失败只在说明行说一句 —— 它确实已经发生过） */
  const finishProvider = useCallback(
    (record: ProviderRecord): void => {
      try {
        upsertProvider(ledgerFile, record);
      } catch (err) {
        setForm((before) => (before === null ? before : { ...before, note: ledgerFailure(err) }));
        return;
      }
      refreshProviders();
      bumpModels();
      closeFormTo({ kind: "providers", at: Math.max(0, providers.findIndex((one) => one.id === record.id)) });
    },
    [ledgerFile, refreshProviders, bumpModels, closeFormTo, providers],
  );

  /** 提供商表单提交（⚠️ **`apiKey` 留空 = 不改这一项**，而掩码那一格也等于「不改」） */
  const submitProvider = useCallback(
    (draft: FormState): void => {
      const baseUrl = draft.values[0] ?? "";
      const api = draft.values[1] ?? "";
      const id = (draft.values[2] ?? "").trim();
      const name = (draft.values[3] ?? "").trim();
      const key = draft.values[4] ?? "";
      const bad = (note: string): void => setForm({ ...draft, note });
      if (baseUrl.trim() === "") return bad("地址不能为空");
      if (id === "") return bad("提供商 id 不能为空");
      // ⚠️ **不含 `/`**：模型存储键按第一个 `/` 切，providerId 里再有一个就把键切错
      if (id.includes("/")) return bad("提供商 id 不能含「/」");
      if (name === "") return bad("提供商名称不能为空");
      const before = providers.find((one) => one.id === draft.id) ?? null;
      if (draft.id === null && key.trim() === "") return bad("key 不能为空");
      const format = MODEL_API_FORMATS.find((one) => one === api);
      if (format === undefined) return bad(`API 格式必须是 ${MODEL_API_FORMATS.join(" / ")} 之一`);
      const apiKey = key === REDACTED_PROVIDER_KEY && before !== null ? before.apiKey : key;
      finishProvider({ id, name, baseUrl, api: format, apiKey });
    },
    [providers, finishProvider],
  );

  /** 控制面表单提交（⚠️ **`token` 那一格是掩码或空串，而掩码 = 不改**） */
  const submitTarget = useCallback(
    (draft: FormState): void => {
      const name = (draft.values[0] ?? "").trim();
      const baseUrl = draft.values[1] ?? "";
      const token = draft.values[2] ?? "";
      const timeout = Number((draft.values[3] ?? "").trim());
      const bad = (note: string): void => setForm({ ...draft, note });
      if (name === "") return bad("名字不能为空");
      if (baseUrl.trim() === "") return bad("地址不能为空");
      const book = readLedgerSafe(ledgerFile);
      if (book === null) return bad("台账读不出来 —— 这一趟改不了");
      const before = targets.find((one) => one.id === draft.id) ?? null;
      if (draft.id === null && token.trim() === "") return bad("token 不能为空");
      if (!Number.isInteger(timeout) || timeout < TIMEOUT_BOUNDS.min || timeout > TIMEOUT_BOUNDS.max) {
        return bad(`超时必须是 ${String(TIMEOUT_BOUNDS.min)}–${String(TIMEOUT_BOUNDS.max)} 之间的整数毫秒`);
      }
      const wantedId = draft.id === null
        ? idForName(book.targets, name)
        : draft.id;
      try {
        writeLedger(
          ledgerFile,
          upsertTarget(
            { version: 1, selected: book.selected, targets: book.targets },
            {
              ...(draft.id === null ? {} : { id: draft.id }),
              name,
              baseUrl,
              // ⚠️ **掩码那一格 = 不改这一项**（不是「改成空」）
              token: token === REDACTED_TOKEN && before !== null ? before.token : token,
              timeoutMs: timeout,
            },
          ),
        );
      } catch (err) {
        return bad(ledgerFailure(err));
      }
      setLedger(readLedgerSafe(ledgerFile));
      bumpLedgerTick();
      closeFormTo({ kind: "targets", at: Math.max(0, targets.findIndex((one) => one.id === wantedId)) });
    },
    [ledgerFile, targets, setLedger, closeFormTo],
  );

  /** 账号表单提交（⚠️ **没选中控制面时一个请求都不许发**；⚠️ 用户名是那台机器上的身份，编辑时改不得） */
  const submitUser = useCallback(
    (draft: FormState): void => {
      if (current === null) {
        setForm({ ...draft, note: NO_TARGET_NOTE });
        return;
      }
      const editing = draft.id !== null;
      const username = editing ? draft.id : (draft.values[0] ?? "").trim();
      const password = draft.values[1] ?? "";
      const quota = draft.values[editing ? 1 : 2] ?? "";
      const enabled = draft.values[editing ? 2 : 3] ?? USER_ENABLED[0];
      const bad = (note: string): void => setForm({ ...draft, note });
      if (username === "") return bad("用户名不能为空");
      if (!editing && password === "") return bad("密码不能为空");
      let quotaBytes: number;
      try {
        quotaBytes = readTraffic(quota);
      } catch (err) {
        return bad(`流量上限读不出来（${describe(err)}）`);
      }
      const target = targetOf(current);
      const disabled = enabled === USER_ENABLED[1];
      const done = (message: string): void => {
        closeFormTo({ kind: "users", at: 0 });
        loadAccounts();
        sayIn(activeId, message);
      };
      void (editing
        ? updateAccount(target, username, { quotaBytes, disabled })
        : createAccount(target, { username, password, quotaBytes, disabled })
      )
        .then((result) => done(result.message))
        .catch((err: unknown) => setForm({ ...draft, note: `账号没写进去（${describe(err)}）` }));
    },
    [current, activeId, closeFormTo, loadAccounts, sayIn],
  );

  /** 改密码（⚠️ **单独一份表单**；密码逐字保留、永不回显，而它一个字都不打码 —— 它就是要发出去的那个） */
  const submitPassword = useCallback(
    (draft: FormState): void => {
      if (current === null) {
        setForm({ ...draft, note: NO_TARGET_NOTE });
        return;
      }
      const password = draft.values[0] ?? "";
      if (password === "") {
        setForm({ ...draft, note: "密码不能为空" });
        return;
      }
      void updateAccount(targetOf(current), draft.username, { password })
        .then((result) => {
          closeFormTo({ kind: "users", at: 0 });
          loadAccounts();
          sayIn(activeId, result.message);
        })
        .catch((err: unknown) => setForm({ ...draft, note: `密码没改掉（${describe(err)}）` }));
    },
    [current, activeId, closeFormTo, loadAccounts, sayIn],
  );

  /** 改模型的显示名（⚠️ **modelId 是协议标识，不给人改** —— 改的只有显示名那一格） */
  const submitLabel = useCallback(
    (draft: FormState): void => {
      const label = (draft.values[0] ?? "").trim();
      if (label === "") {
        setForm({ ...draft, note: "显示名不能为空" });
        return;
      }
      const split = splitModelRef(draft.ref);
      if (split === null) return;
      let list: readonly ModelRecord[] = [];
      try {
        list = readProviderModels(ledgerFile, split.providerId);
      } catch (err) {
        setForm({ ...draft, note: `模型清单读不出来（${describe(err)}）` });
        return;
      }
      const next = list.map((one) => (one.modelId === split.modelId ? { ...one, label } : one));
      try {
        writeProviderModels(ledgerFile, split.providerId, next);
      } catch (err) {
        setForm({ ...draft, note: `显示名没存进去（${describe(err)}）` });
        return;
      }
      setProviderModels(next);
      bumpModels();
      setForm(null);
      const back = behind;
      setBehind(null);
      setModal(back);
    },
    [ledgerFile, behind, bumpModels],
  );

  /** 提交整份表单（⚠️ **不是**提交当前字段 —— 而校验不过时**不关窗**，在说明行说清哪一格不对） */
  const submitForm = useCallback((): void => {
    if (form === null) return;
    if (form.kind === "provider") return submitProvider(form);
    if (form.kind === "target") return submitTarget(form);
    if (form.kind === "user") return submitUser(form);
    if (form.kind === "password") return submitPassword(form);
    return submitLabel(form);
  }, [form, submitProvider, submitTarget, submitUser, submitPassword, submitLabel]);

  /** `Tab` / `Shift+Tab` 在**字段之间**走（⚠️ 走到底就停住） */
  const fieldTab = useCallback(
    (step: 1 | -1): void => {
      if (form === null) return;
      const last = form.fields.length - 1;
      const next = Math.max(0, Math.min(last, form.at + step));
      if (next === form.at) return;
      setForm({ ...form, at: next, note: null });
    },
    [form],
  );

  /** `↑↓`：**下拉那一格换档，其余在字段之间走**（⚠️ 与清单那几档的 `↑↓` 不是同一件事） */
  const fieldArrow = useCallback(
    (step: 1 | -1): void => {
      if (form === null) return;
      if ((form.fields[form.at]?.options ?? []).length > 0) {
        setForm(withSelect(form, step));
        return;
      }
      fieldTab(step);
    },
    [form, fieldTab],
  );

  /* ── 弹窗：其余动作 ──────────────────────────────────────────────────────── */

  /** 接受高亮那一项（`Enter`；⚠️ **每一档的「接受」是不同的一件事**，判据是 `kind`） */
  const acceptModal = useCallback((): void => {
    if (modal !== null && modal.kind === "sessions") {
      const id = historyOrder[modalAt];
      if (id !== undefined) activateSession(id);
      return;
    }
    const list = asList(modal);
    if (list === null) return;
    if (list.kind === "targets") {
      const picked = targets[list.at];
      // ⚠️ **接到当前会话**：没有当前会话时那里无处可接，而凭空造一个会话不是这一键的意思
      if (picked === undefined) return;
      if (activeId === null) {
        say("还没有会话 —— 先敲一句话或 /new");
        return;
      }
      useTarget(activeId, picked.id);
      closeModal();
      return;
    }
    if (list.kind === "providers") {
      const picked = providers[list.at];
      if (picked === undefined) return;
      if (activeId === null) return;
      // ⚠️ **填满当前会话** = 切到这个提供商下的一个模型；它一个模型都还没有时说一句而不是静默
      const first = modelChoices.find((one) => one.providerId === picked.id);
      if (first === undefined) {
        say("这个提供商还没有模型 —— 用 Ctrl+M 给它配一份，或用 Ctrl+G 从它的 /models 端点拉一次");
        closeModal();
        return;
      }
      useModel(activeId, first.ref, active?.reasoning ?? DEFAULT_REASONING_EFFORT);
      closeModal();
      return;
    }
    if (list.kind === "models") {
      const ref = modelRefs[list.at];
      if (ref === undefined || activeId === null) return;
      useModel(activeId, ref, active?.reasoning ?? DEFAULT_REASONING_EFFORT);
      closeModal();
      return;
    }
    if (list.kind === "users") {
      const picked = accounts[list.at];
      if (picked !== undefined) openUserForm(picked);
    }
  }, [
    modal,
    modalAt,
    historyOrder,
    targets,
    providers,
    accounts,
    modelChoices,
    modelRefs,
    activeId,
    active?.reasoning,
    useTarget,
    useModel,
    closeModal,
    say,
    openUserForm,
  ]);

  /** 新增（`Ctrl+A`；⚠️ **`provider-models` 那一档不是「新增」而是「全选 / 取消全选」**） */
  const addModalRow = useCallback((): void => {
    const list = asList(modal);
    if (list === null) return;
    if (list.kind === "provider-models") {
      const shown = filterModels(providerModels, list.filter);
      const all = shown.length > 0 && shown.every((one) => list.picked.has(one.modelId));
      setModal({ ...list, picked: all ? new Set() : new Set(providerModels.map((one) => one.modelId)) });
      return;
    }
    if (list.kind === "targets") openTargetForm(null);
    else if (list.kind === "users") openUserForm(null);
    else if (list.kind === "providers") openProviderForm(null);
  }, [modal, providerModels, openTargetForm, openUserForm, openProviderForm]);

  /** 编辑（`Ctrl+E`；⚠️ **`provider-models` 那一档是「改高亮那格的显示名」**） */
  const editModalRow = useCallback((): void => {
    const list = asList(modal);
    if (list === null) return;
    if (list.kind === "targets") {
      const picked = targets[list.at];
      if (picked !== undefined) openTargetForm(picked);
      return;
    }
    if (list.kind === "users") {
      const picked = accounts[list.at];
      if (picked !== undefined) openUserForm(picked);
      return;
    }
    if (list.kind === "providers") {
      const picked = providers[list.at];
      if (picked !== undefined) openProviderForm(picked);
      return;
    }
    if (list.kind === "provider-models") {
      const picked = filterModels(providerModels, list.filter)[list.at];
      if (picked === undefined) return;
      openForm({
        kind: "label",
        id: null,
        title: "改显示名",
        fields: LABEL_FIELDS,
        values: [picked.label],
        cursors: [picked.label.length],
        at: 0,
        note: null,
        username: "",
        ref: joinModelRef(list.id, picked.modelId),
      });
    }
  }, [modal, targets, accounts, providers, providerModels, openTargetForm, openUserForm, openProviderForm, openForm]);

  /** `Space`：切**高亮那一个**的勾选（⚠️ **过滤只影响显示**：被过滤掉的行仍在勾里） */
  const toggleCheck = useCallback((): void => {
    const list = asList(modal);
    if (list === null || list.kind !== "provider-models") return;
    const record = filterModels(providerModels, list.filter)[list.at];
    if (record === undefined) return;
    const picked = new Set(list.picked);
    if (picked.has(record.modelId)) picked.delete(record.modelId);
    else picked.add(record.modelId);
    setModal({ ...list, picked });
  }, [modal, providerModels]);

  /** `Ctrl+F`：置顶 toggle（⚠️ **落盘且全局** —— 它在 `provider_models.pinned` 那一列，不按会话） */
  const togglePin = useCallback((): void => {
    const list = asList(modal);
    if (list === null || list.kind !== "models") return;
    const ref = modelRefs[list.at];
    const split = ref === undefined ? null : splitModelRef(ref);
    if (split === null) return;
    let list2: readonly ModelRecord[] = [];
    try {
      list2 = readProviderModels(ledgerFile, split.providerId);
    } catch (err) {
      say(`模型清单读不出来（${describe(err)}）`);
      return;
    }
    const next = list2.map((one) =>
      one.modelId === split.modelId ? { ...one, pinned: !one.pinned } : one,
    );
    try {
      writeProviderModels(ledgerFile, split.providerId, next);
    } catch (err) {
      say(`置顶没存进去（${describe(err)}）`);
      return;
    }
    bumpModels();
  }, [modal, modalAt, modelRefs, ledgerFile, bumpModels, say]);

  /** `Ctrl+R`：循环推理强度四档（⚠️ **跟着当前会话**，而落盘是那两列单独一写） */
  const cycleReasoning = useCallback((): void => {
    const list = asList(modal);
    if (list === null || list.kind !== "models" || active === null || activeId === null) return;
    const now = active.reasoning;
    const step = REASONING_CYCLE[(REASONING_CYCLE.indexOf(now) + 1) % REASONING_CYCLE.length] ?? now;
    useModel(activeId, active.modelRef, step);
  }, [modal, activeId, active, useModel]);

  /** 弹窗里的 `Ctrl+R`（⚠️ 判据是 `kind` 而不是「窗口开着」：两档上是两件事） */
  const renameOrCycle = useCallback((): void => {
    if (modal !== null && modal.kind === "sessions") {
      renameHighlighted();
      return;
    }
    cycleReasoning();
  }, [modal, renameHighlighted, cycleReasoning]);

  /** `Ctrl+P`：改密码（⚠️ **单独一份表单**） */
  const setPassword = useCallback((): void => {
    const list = asList(modal);
    if (list === null || list.kind !== "users") return;
    const picked = accounts[list.at];
    if (picked === undefined) return;
    openForm({
      kind: "password",
      id: picked.username,
      title: `改密码 · ${picked.username}`,
      fields: PASSWORD_FIELDS,
      values: [""],
      cursors: [0],      at: 0,
      note: null,
      username: picked.username,
      ref: "",
    });
  }, [modal, accounts, openForm]);

  /** 点弹窗里**第 `at` 个可选行**（⚠️ ⚠️ **`sessions` 那一档点行就是激活它**，而清单那几档只挪高亮） */
  const pickModalRow = useCallback(
    (at: number): void => {
      if (modal !== null && modal.kind === "sessions") {
        setHistoryAt(at);
        clearPending();
        const id = historyOrder[at];
        if (id !== undefined) activateSession(id);
        return;
      }
      const list = asList(modal);
      if (list === null) return;
      setModalAt(at);
      clearPending();
      if (list.kind !== "provider-models") return;
      const record = filterModels(providerModels, list.filter)[at];
      if (record === undefined) return;
      const picked = new Set(list.picked);
      if (picked.has(record.modelId)) picked.delete(record.modelId);
      else picked.add(record.modelId);
      setModal({ ...list, at, picked });
    },
    [modal, historyOrder, providerModels, setModalAt, clearPending, activateSession],
  );

  return {
    modal,
    form,
    behind,
    historyAt,
    filterCursor,
    modelsNote,
    rename,
    menu,
    menuAt,
    historyCells,
    historyOrder,
    modelChoices,
    pinnedRefs,
    modelOrder,
    modelRefs,
    modelCells,
    modalAt,
    modalPending,
    highlightedId,
    modalTotal,
    closeMenu,
    closeModal,
    activateSession,
    showHistory,
    openHistory,
    renameHighlighted,
    managerNameOf,
    openRename,
    confirmRename,
    cancelRename,
    scrollSessions,
    stepSession,
    openMenu,
    moveMenu,
    pickMenu,
    useTarget,
    providerOf,
    useModel,
    setModalAt,
    setModal,
    setForm,
    setRename,
    setFilterCursor,
    setPending,
    clearPending,
    loadAccounts,
    openTargets,
    openUsers,
    openProviders,
    openModels,
    openProviderModels,
    modelsOfProvider,
    saveProviderModels,
    fetchModels,
    deleteHighlighted,
    removeModalRow,
    moveModalRow,
    escapeModal,
    openForm,
    closeFormTo,
    openProviderForm,
    openTargetForm,
    openUserForm,
    finishProvider,
    submitProvider,
    submitTarget,
    submitUser,
    submitPassword,
    submitLabel,
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
  };
}

// ── 给指挥官接线用 ────────────────────────────────────────────────────────────
// 导出的 API 名字清单（WindowDomainApi 的全部只读字段，按返回对象顺序）：
//   状态快照：modal, form, behind, historyAt, filterCursor, modelsNote, rename, menu, menuAt,
//     historyCells, historyOrder, modelChoices, pinnedRefs, modelOrder, modelRefs, modelCells,
//     modalAt, modalPending, highlightedId, modalTotal
//   动作：closeMenu, closeModal, activateSession, showHistory, openHistory, renameHighlighted,
//     managerNameOf, openRename, confirmRename, cancelRename, scrollSessions, stepSession,
//     openMenu, moveMenu, pickMenu, useTarget, providerOf, useModel,
//     setModalAt, setPending, clearPending, loadAccounts,
//     openTargets, openUsers, openProviders, openModels, openProviderModels, modelsOfProvider,
//     saveProviderModels, fetchModels, deleteHighlighted, removeModalRow, moveModalRow, escapeModal,
//     openForm, closeFormTo, openProviderForm, openTargetForm, openUserForm,
//     finishProvider, submitProvider, submitTarget, submitUser, submitPassword, submitLabel, submitForm,
//     fieldTab, fieldArrow,
//     acceptModal, addModalRow, editModalRow, toggleCheck, togglePin, cycleReasoning, renameOrCycle,
//     setPassword, pickModalRow
// deps 需要调用方传入的字段清单（WindowDomainDeps，11 个，缺一不可）：
//   ledgerFile: string（台账文件路径，原 App 的同名 prop）
//   sessions 域回调（7 个，取自 useSessionsDomain 的返回值）：switchSession, revealSession, spawnOne,
//     unpinFromSidebar, forgetSessionMessages, say, sayIn
//   ledger 域回调（3 个，取自 useLedgerDomain 的返回值）：refreshProviders, bumpModels, bumpLedgerTick
//   其余跨域读写（sessions/activeId/historyRecords/sidebarIds/sessionsTop 的快照与 setter，
//     ledger/targets/current/providers/providerModels/modelTick/accounts 的快照与 setter）
//     本 hook 内部经 useSessionsStore/useLedgerStore/useWindowStore 直接订阅，不经 deps 传入。
//   本 hook 内部无 transient ref（序号守卫类状态）：fetchModels 的竞态由窗态上的 busy + 函数式
//     setModal 收敛，deleteHighlighted/removeModalRow/moveModalRow 的时序由 setPending 的函数式
//     更新保证，故没有需要 useRef 持有的一次性游标。
