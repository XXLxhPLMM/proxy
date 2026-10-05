/**
 * @fileoverview 根组件：全屏 console 的应用状态层（唯一持有跨帧状态，唯一把一次动作翻成若干次 `setState`）
 */
// ⚠️ `AppProps` 上那**一个**函数字段（`exit`）是组合根边界而不是呈现契约：`LayoutProps`「零个函数字段」
// 那条纪律不许它长到 props 里，而退出必须汇进 `cli.tsx` 那个幂等 `finish(0, null)` ⇒ 状态层只能接一个回调

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ALL_TARGETS,
  COMMAND_PREFIX,
  complete,
  paletteFill,
  paletteOf,
  paletteStep,
  paletteWindow,
  parseLine,
  type ParseResult,
} from "@/commands/index.js";
import {
  DEFAULT_TIMEOUT_MS,
  LedgerError,
  appendMessages,
  clearMessages,
  clientFor,
  pinSession,
  probeTarget,
  readLedger,
  readMessages,
  readProvider,
  readSessions,
  readSidebar,
  redactProvider,
  removeSession,
  removeTarget,
  renameSession,
  saveSession,
  selectedTarget,
  setSelected,
  trimMessages,
  unpinSession,
  upsertTarget,
  writeLedger,
  writeProvider,
  type Ledger,
  type ProviderSettings,
  type Target,
} from "@/services/config/index.js";
import {
  append,
  clampTop,
  flatten,
  trim,
  type FlatLog,
  type LogEntry,
  type LogRow,
  type Turn,
} from "@/lib/log/index.js";
import { exec, fanOut, type BatchPeer, type BatchReport, type Effect, type ExecDeps } from "@/lib/exec/index.js";
import { ask } from "@/lib/agent.js";
import { connectionStateOf, type ProbeSlot } from "@/theme/index.js";
import { mouseUnsupportedHintOf, type MouseSource } from "@/services/terminal/index.js";
import { Layout } from "@/app.js";
import {
  type MenuView,
  type PaletteView,
  type SessionHistoryRow,
  type SessionHistoryView,
  type SessionRow,
  type WindowRow,
  type WindowView,
} from "@/components/index.js";
import {
  SIDEBAR_WIDTH,
  WINDOW_INPUT_PROMPT_COLUMNS,
  dayGroupLabel,
  describe,
  droppedHint,
  ellipsis,
  geometry,
  idOfName,
  readLedgerSafe,
  rowsOfFailure,
  type Rect,
  type WindowSlot,
} from "@/lib/index.js";
import {
  EMPTY_PROVIDER,
  LOG_KEEP,
  MESSAGE_TTL_MS,
  MODEL_TIMEOUT_MS,
  SEED_SESSION,
  emptyBucket,
  newSession,
  restoredSessions,
  sessionSeqOf,
  type Bucket,
  type CaretActive,
  type EditActive,
  type FillActive,
  type Job,
  type Session,
  type SessionRecord,
  type SidebarEntry,
  type WindowKind,
} from "@/store/index.js";
import { useHotkeys, useMouse, useTerminalSize, type ResizeStart } from "@/hooks/index.js";

/** 菜单里那三项的文案（⚠️ **文案在这里、几何按它算宽度**：两处各写一份的话卡片宽度与画出来的字对不上） */
// ⚠️ 第一项**必须说清是「移出侧边栏」而不是「删除」**：那个动作只改「侧边栏上有没有它」，
// 会话与它的对话都留着 —— 而破坏性的那一个（级联删三张表）挂在弹窗里的 `Ctrl+D` 上。
const MENU_DETACH = "从侧边栏移出";
const MENU_RENAME = "重命名";
const MENU_NEW = "新建会话";

/** 一次弹出的菜单有哪几项（⚠️ **空白处那一份只有「新建会话」**：那里没有「它」可以删除或改名） */
// ⚠️ **「新建会话」刻意也在会话项那一份里**：只在空白处才有的话，侧边栏被会话填满时（每项 3 行）
// 鼠标那一路整个消失，而删除与改名都还在 —— 三个动作不该有两个与清单密度绑在一起
function menuItemsOf(menu: { readonly sessionId: string | null } | null): readonly string[] {
  if (menu === null) return [];
  return menu.sessionId === null ? [MENU_NEW] : [MENU_DETACH, MENU_RENAME, MENU_NEW];
}

/**
 * 弹窗里一个**没有历史会话**时的那一句（⚠️ 一句人话而不是空串：空串与「有会话而它们装不下」在屏上一样）
 */
const NO_HISTORY_NOTE = "台账里一个历史会话都没有 · 用 /new 开一个，它会自动进侧边栏";

/** 弹窗里右侧那枚「已在侧边栏上」的记号占几列（⚠️ **恒预留**：`pinned` 为假时那里是一个空格，两帧的列位必须一样） */
const PINNED_MARK_COLUMNS = 2;

/** 弹窗里「这个会话连着哪台」那一截的裁剪预算（⚠️ 名字与它分那一行，不许各自吃掉整行） */
const HISTORY_MANAGER_COLUMNS = 14;

/** 历史会话弹窗的标题（⚠️ **台数放在标题里**而不是每一行：那一行还有名字与两个记号） */
function historyTitle(count: number): string {
  return `历史会话（${String(count)}）`;
}

/** 全部历史会话 → 分好组的逐槽内容（**四条纯函数里唯一的那个入口**，别处一律转调它） */
function groupOrder(records: readonly SessionRecord[], now: number): readonly HistoryCell[] {
  const sorted = [...records].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
  const out: HistoryCell[] = [];
  let header: string | null = null;
  for (const record of sorted) {
    const label = dayGroupLabel(record.updatedAt, now);
    if (label !== header) {
      out.push({ header: label, record: null });
      header = label;
    }
    out.push({ header: null, record });
  }
  return out;
}

/** 分组之后弹窗逐槽装什么（`header === null` 的那一槽就是一个可选会话） */
export interface HistoryCell {
  /** 分组标题（`null` = 这一槽是一个可选会话） */
  readonly header: string | null;
  readonly record: SessionRecord | null;
}

/** 全部会话 → 侧边栏那几行，**按激活顺序**（⚠️ 不在 `sidebar_sessions` 清单上的会话不进这一列） */
function sidebarRecords(
  records: readonly SessionRecord[],
  entries: readonly SidebarEntry[],
): readonly SessionRecord[] {
  const known = new Map(records.map((one) => [one.id, one]));
  // ⚠️ **按 `entries` 的次序**而不是按 `records` 的：`records` 是建成序（`rowid`），而这一列
  // 的顺序是**激活序** —— 两处各排一次的话，重开之后那一列就会重排一次
  const onSidebar = entries.flatMap((one) => {
    const found = known.get(one.sessionId);
    return found === undefined ? [] : [found];
  });
  return onSidebar.length > 0 ? onSidebar : records.slice(0, 1);
}

/** 分好组的那一串（⚠️ **标题与可选会话同处一个数组** —— 拆开就得两处各算一次算术） */
function groupedHistory(
  records: readonly SessionRecord[],
  now: number,
): readonly HistoryCell[] {
  return groupOrder(records, now);
}

/**
 * 分好组的那一串 → 呈现形状（⚠️ **裁剪预算一律取几何给的那一格** —— 状态层不许算列宽）
 */
function historyRows(
  cells: readonly HistoryCell[],
  sidebar: ReadonlySet<string>,
  managerOf: (id: string) => string | null,
  slots: readonly (Rect | null)[],
): readonly SessionHistoryRow[] {
  return cells.map((cell, i) => {
    // ⚠️ 分组标题行的 `id` / `name` 恒是空串而 `manager` 恒 `null`：它不对应任何会话，
    // 而一个非空 `id` 会让回查把它当成一个可选会话（`windowRows` 里并没有它那一槽）
    if (cell.header !== null) {
      return { id: "", name: "", header: cell.header, pinned: false, manager: null, at: 0, label: cell.header };
    }
    const record = cell.record as SessionRecord;
    const rect = slots[i] ?? null;
    const room = rect === null ? 0 : Math.max(0, rect.width - PINNED_MARK_COLUMNS - HISTORY_MANAGER_COLUMNS);
    return {
      id: record.id,
      name: record.name,
      header: null,
      pinned: sidebar.has(record.id),
      manager: managerOf(record.id),
      at: record.updatedAt,
      label: ellipsis(record.name, room),
    };
  });
}

/** 那一串的**槽位**（⚠️ 与 {@link groupedHistory} 同序同长，而改名的 `input` 槽恒排在**最后**） */
function historySlots(cells: readonly HistoryCell[], renaming: boolean): readonly WindowSlot[] {
  const rows = cells.map((cell) => (cell.header === null ? { kind: "row" as const } : { kind: "group" as const }));
  return renaming ? [...rows, { kind: "input" as const }] : rows;
}

/** 改名输入框里那串字的裁剪预算（⚠️ **让开提示符那几列**：`Geometry.windowInputText` 已经扣过一次，这里只兜宽度为 0 的那一档） */
function renameBudget(rect: Rect | null): number {
  return rect === null ? 0 : Math.max(0, rect.width - WINDOW_INPUT_PROMPT_COLUMNS);
}

/** 那一串字加上框里落着的插入符（⚠️ **裁剪只动呈现那一份**，会话名字本身一个字都不改） */
function renameView(
  rename: { readonly id: string; readonly text: string; readonly cursor: number } | null,
  rect: Rect | null,
): { readonly id: string; readonly text: string; readonly cursor: number } | null {
  if (rename === null) return null;
  return { id: rename.id, text: ellipsis(rename.text, renameBudget(rect)), cursor: rename.cursor };
}



/** 读 provider（**不抛**：⚠️ 库读不出来不该让整个界面起不来，那一句屏上已经有了）—— 这一份是**真凭据** */
function readProviderSafe(file: string): ProviderSettings {
  try {
    return readProvider(file);
  } catch {
    return EMPTY_PROVIDER;
  }
}

/** provider → 连接参数（⚠️ **`null` = 没配齐**，屏上说「还没配」而不是「失败了」）；判据是**三格都非空** */
function modelEndpointOf(provider: ProviderSettings): { baseUrl: string; model: string; apiKey: string } | null {
  if (provider.baseUrl === null || provider.model === null || provider.apiKey === null) return null;
  return { baseUrl: provider.baseUrl, model: provider.model, apiKey: provider.apiKey };
}

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

  /** 侧边栏上的会话（⚠️ **至少一个**：没有输入行就没有任何命令）—— 而它**就是**已激活进侧边栏的那些 */
  const [sessions, setSessions] = useState<readonly Session[]>(() => [
    newSession(SEED_SESSION.id, SEED_SESSION.name),
  ]);
  /** 当前是哪个会话（⚠️ 它是 `id` 不是下标：`/new` 之后下标全变，而按下标存的 hover 会指着另一个） */
  // ⚠️ **宽泛成 `string`**（而不是 `SEED_SESSION.id` 的字面量类型）：`useState` 从那个常量推出来的
  // 是 `"s1"` —— 于是每一个 `setActiveId(别的 id)` 都编译期红，而那正是 `/new` 与激活要做的事
  const [activeId, setActiveId] = useState<string>(SEED_SESSION.id);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [ledgerError, setLedgerError] = useState<LedgerError | null>(null);
  /** 改台账后触发重读盘（`target add` / `target del` 之后） */
  const [ledgerTick, setLedgerTick] = useState(0);
  /** 每个控制面最近一次探活持有的那个值（`undefined` = 还没探过） */
  const [probes, setProbes] = useState<ReadonlyMap<string, ProbeSlot>>(
    () => new Map<string, ProbeSlot>(),
  );
  /** 输入区中间那一行（执行中 / 一条瞬时消息） */
  const [message, setMessage] = useState<string | null>(null);
  /** 正在跑的那条命令的原文（`null` = 队列空着） */
  const [running, setRunning] = useState<string | null>(null);
  const [windowKind, setWindowKind] = useState<WindowKind>(null);
  /** 窗口里高亮**第几个可选项**（⚠️ **数的是可选会话** —— `Geometry.windowRows` 只含 `row` 槽） */
  const [windowAt, setWindowAt] = useState(0);
  /** `sessions` 表里的**全部**历史会话（⚠️ 它**不是**侧边栏那几行：前者是「有过哪些会话」，后者是「眼下开着哪些」） */
  const [historyRecords, setHistoryRecords] = useState<readonly SessionRecord[]>([]);
  /** 库里的侧边栏清单（`id` 集合；⚠️ 弹窗里「已在侧边栏上」那一枚记号读它，而 `Session` 身上**没有**这一位） */
  const [sidebarIds, setSidebarIds] = useState<ReadonlySet<string>>(() => new Set());
  /** 侧边栏宽度（**用户拖出来的那个值**，允许越界；合法区间由几何层算） */
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_WIDTH);
  /** 侧边栏会话清单滚到第几项（下标）；⚠️ 唯一一份「窗口停在哪」，而「当前会话必须留在窗口里」由 `revealSession` 维持（几何层故意只夹不推） */
  const [sessionsTop, setSessionsTop] = useState(0);
  // ⚠️ **框里的文本不写进会话的 `input`** —— 取消之后那个输入行必须还是取消之前那一串；
  // 而它**只**住在弹窗里（`Composer` 不参与改名），故四个入口打开的是同一个框
  const [rename, setRename] = useState<{ readonly id: string; readonly text: string; readonly cursor: number } | null>(null);
  /** 会话菜单（`null` = 没开；`sessionId` 为 `null` = 空白处那一份，只有「新建会话」） */
  const [menu, setMenu] = useState<{
    readonly sessionId: string | null;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  /** 菜单高亮第几项（下标；⚠️ 键盘与鼠标**共用**它，于是「鼠标指的」与「`↓` 走的」不会说两个高亮） */
  const [menuAt, setMenuAt] = useState(0);

  /* 这些 ref 的唯一理由：异步回调要读到「下一次渲染的视角」 */

  /** 内存里那份台账（与 `ledger` **同一个写入口**） */
  const ledgerRef = useRef<Ledger | null>(null);
  /** 每个 id 的探活序号（⚠️ 回来的那次探活靠它判新旧，见 {@link reprobe}） */
  const probeSeq = useRef(new Map<string, number>());
  /** 排队中还没跑的命令（**只进不出**，故不需要 state） */
  const queueRef = useRef<Job[]>([]);
  /** 此刻是不是正在跑一条（`true` 时 {@link pump} 拒绝启动下一条） */
  const busyRef = useRef(false);
  /** {@link pump} 自己（串行化要它回调自己，而 `useCallback` 的空依赖版本看不到自己） */
  const pumpRef = useRef<() => void>(() => {});
  /** {@link applyEffect} 自己（`/batch` 那支与它互相调用，理由同 {@link pumpRef}） */
  const applyEffectRef = useRef<(sessionId: string, effect: Effect) => void>(() => {});
  /** 视口（结果区内容宽度与视口行数）；异步回调里要用**当下**的那一份 */
  const viewportRef = useRef({ width: 0, rows: 0 });
  /** 侧边栏放得下几项会话（⚠️ 同上：{@link revealSession} 是回调，读不到下一次渲染的那一份） */
  const sessionRowsRef = useRef(1);
  /** 会话序号（造新会话 id 的唯一发号处） */
  const sessionSeq = useRef(1);
  /** provider 的**真**那一份（⚠️ **只有**发模型请求与 `/provider show` 的打码读它；它**不进**任何 props / 文案 / 日志） */
  const providerRef = useRef<ProviderSettings>(EMPTY_PROVIDER);
  /** 正在跑那条对话（`null` = 没在跑） */
  const [chatting, setChatting] = useState(false);
  /** 台账读出来之后**只**给第一个会话播种一次（⚠️ 种子不是「当前目标」，见那处 effect） */
  const seededRef = useRef(false);
  /** 启动恢复只此一次（⚠️ 跟着 `ledgerTick` 重跑会把用户刚删掉的会话从库里捞回来） */
  const restoredRef = useRef(false);
  /** 已经从 `messages` 表读回过的会话 `id`（⚠️ 每次挂载一份；判据是「读回来过」而**不是**「盘上有」） */
  const loadedMessagesRef = useRef(new Set<string>());
  /** 每个会话桶里**落盘那一侧**的格子（⚠️ `push` 的发号依据，**不读 `sessions`**：同一帧会重号） */
  const entriesRef = useRef(new Map<string, readonly LogEntry[]>());
  /** 正在拖宽侧边栏吗（`null` = 没拖）。⚠️ **存起点而不存当前宽度**：见 `@/hooks/useMouse.js` */
  const resizingRef = useRef<ResizeStart | null>(null);

  /** 内存里那份台账的**唯一**写入口（`state` 与 {@link ledgerRef} 在这里一起落） */
  const holdLedger = useCallback((next: Ledger | null): void => {
    ledgerRef.current = next;
    setLedger(next);
  }, []);

  /** 内存里那份 provider 的**唯一**写入口（⚠️ 只存**真**那一份，而打码发生在**读**的那一处） */
  const holdProvider = useCallback((next: ProviderSettings): void => {
    providerRef.current = next;
  }, []);

  /** 收掉会话菜单（⚠️ 它**不是模态**：收掉它只是把那一层拿掉，背后那一层照旧可点） */
  const closeMenu = useCallback((): void => setMenu(null), []);

  /**
   * 收掉模态窗口（⚠️ **改名框一起收掉**：留着它的话「关窗」之后框还在，而它的宿主就是那个弹窗）
   */
  const closeWindow = useCallback((): void => {
    setWindowKind(null);
    setRename(null);
  }, []);

  useEffect(() => {
    try {
      holdLedger(readLedger(ledgerFile));
      setLedgerError(null);
    } catch (err) {
      // ⚠️ 读失败**不碰**内存里那份：当成空台账，下一次写就会覆盖掉存着凭据的那份
      setLedgerError(err instanceof LedgerError ? err : new LedgerError("unreadable", "台账读不出来"));
    }
    // ⚠️ provider 与台账**同一个库**，而它读不出来时**不报错**：屏上那一句是「还没配 provider」，
    // 而「库里读不出来」与「没配」在界面上是同一句话 —— 报错反而会让用户去查一个没坏的东西
    holdProvider(readProviderSafe(ledgerFile));
  }, [ledgerFile, ledgerTick, holdLedger, holdProvider]);

  // ⚠️ **启动恢复只此一次，且不等台账**：它在第一个 effect 趟里跑完，于是后面那支播种（依赖 `ledger`）
  // 看到的必然是恢复之后那份清单 —— 顺序反了的话它把「上次用的那个控制面」播种给一个马上要被替换掉的会话。
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    let records: readonly SessionRecord[];
    let sidebar: readonly SidebarEntry[];
    try {
      records = readSessions(ledgerFile);
      sidebar = readSidebar(ledgerFile);
    } catch (err) {
      // ⚠️ 读不出来就只用内存里那一个，且**一个字都不写** —— 写会把存着凭据的那份库覆盖掉
      setMessage(`会话清单读不出来（${describe(err)}）—— 这一趟只有起步那一个会话`);
      return;
    }
    setHistoryRecords(records);
    const pinned = new Set(sidebar.map((one) => one.sessionId));
    setSidebarIds(pinned);
    // ⚠️ **库里已经有会话时不再凭空造一个**（那是「关掉一次就多一个」的那种积累）
    if (records.length === 0) {
      const now = Date.now();
      try {
        saveSession(ledgerFile, { id: SEED_SESSION.id, name: SEED_SESSION.name, createdAt: now, updatedAt: now });
        // ⚠️ 起步那一个**同时**激活进侧边栏：侧边栏清单是另一张表，而「起手就有那一行」是那条不变量的另一半
        pinSession(ledgerFile, SEED_SESSION.id, now);
      } catch (err) {
        setMessage(`起步会话没存进台账（${describe(err)}）—— 关掉就没了`);
      }
      return;
    }
    // ⚠️ **先抬序号再谈别的**：不抬的话 `/new` 会插一个库里已有的 `id`，症状是屏上多一项而库里没多
    sessionSeq.current = sessionSeqOf(records);
    // ⚠️ **侧边栏那几行按激活顺序**（`sidebar_sessions` 的 `rowid`），而**不是**按 `created_at`：
    // 激活顺序才是「侧边栏上从上到下」那一列的唯一定义，而建库顺序只是一个副作用
    setSessions(restoredSessions(sidebarRecords(records, sidebar)));
    // ⚠️ **当前那个由侧边栏清单答**：不在清单上的会话（被移出过）不该一恢复就变成当前那一个，
    // 否则「从侧边栏移出」在重开之后等于没做
    setActiveId(sidebar[0]?.sessionId ?? records[0]?.id ?? SEED_SESSION.id);
  }, [ledgerFile]);

  const targets: readonly Target[] = useMemo(() => ledger?.targets ?? [], [ledger]);

  /** 当前会话（永远有一个：清单空了是 bug，不是「没有当前会话」） */
  const active: Session = useMemo(() => {
    const found = sessions.find((one) => one.id === activeId);
    return found ?? sessions[0] ?? newSession(SEED_SESSION.id, SEED_SESSION.name);
  }, [sessions, activeId]);

  /** 当前会话连的是哪个控制面（`null` = 还没选）；⚠️ 认 `id` 不认名字（名字可重复）；它与台账的 `selected` 是两件事（后者是「上次用的」） */
  const current: Target | null = useMemo(
    () => targets.find((one) => one.id === active.targetId) ?? null,
    [targets, active.targetId],
  );

  /** 台账读出来之后给第一个会话播种一次；⚠️ 只播种一次（`seededRef`），否则每次重读都把「`target switch` 切过去的那台」盖回台账的旧值 */
  useEffect(() => {
    if (seededRef.current || ledger === null) return;
    seededRef.current = true;
    const seed = selectedTarget(ledger);
    if (seed === null) return;
    setSessions((prev) =>
      prev.map((one, i) => (i === 0 && one.targetId === null ? { ...one, targetId: seed.id } : one)),
    );
  }, [ledger]);

  /** 切到某一个会话 ⇒ 它那一枚「跑完了」的记号**清掉**（看过就不再提醒；⚠️ 只清 `done`，`running` 照旧亮着） */
  useEffect(() => {
    setSessions((prev) =>
      prev.map((one) => (one.id === activeId && one.run === "done" ? { ...one, run: "idle" } : one)),
    );
  }, [activeId]);

  /** 每个会话桶里**落盘那一侧**的格子（⚠️ `push` 的发号依据：同一帧两次追加会算出同一个 `seq`） */
  // ⚠️ 入参是 `Turn` 而不是 `LogRow`：**「谁说的」与「画成什么形状」是两层**，摊平那一层由
  // `@/lib/log/rows.js` 管。于是「本包自己说的话」与「控制面的回答」在类型上就分得开。
  // ⚠️ **落盘的是 `messages` 表**（一格一行，`seq` 恒等于 `LogEntry.id`），见下面那个 `try`。
  const push = useCallback(
    (sessionId: string, turns: readonly Turn[], at: number): void => {
      if (turns.length === 0) return;
      const viewport = viewportRef.current;
      // ⚠️ `before` 取自 {@link entriesRef} 而不是 `sessions`：后者是**上一帧**那一份，
      // 而同一帧里的第二次 `push` 会从同一个旧值发号 ⇒ 撞 `(session_id, seq)` 主键
      const before = entriesRef.current.get(sessionId) ?? [];
      const added = append(before, turns, at);
      // ⚠️ **只把新追加的那几格交出去**，不是整个桶：整个桶交出去会撞 `(session_id, seq)` 主键
      const fresh = added.slice(before.length);
      let entries: readonly LogEntry[];
      try {
        appendMessages(ledgerFile, sessionId, fresh);
        entries = trim(added, LOG_KEEP);
        // ⚠️ 环形缓冲丢掉最老的之后**盘上那一份也得跟着收**，否则库里会攒出比桶里多的历史
        // （而「桶里第一格的 id」就是那条收口的下界）
        if (entries.length < added.length && entries[0] !== undefined) {
          trimMessages(ledgerFile, sessionId, entries[0].id);
        }
      } catch (err) {
        // ⚠️ 失败不回滚（那些格子确实发生过），而那一句**追加进同一个桶**：
        // 说进「当前会话」的话，此刻 `setActiveId` 可能已经排进队列了（症状是「保存失败」出现在别人的会话里）
        const failure = `这几格对话没存进台账（${describe(err)}）—— 关掉就没了`;
        entries = trim(append(added, [{ kind: "notice", rows: [{ kind: "note", text: failure }] }], at), LOG_KEEP);
        setMessage(failure);
      }
      entriesRef.current.set(sessionId, entries);
      setSessions((prev) =>
        prev.map((one) => {
          if (one.id !== sessionId) return one;
          const height = flatten(entries, viewport.width).height;
          const bottom = clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
          const top = one.bucket.follow ? bottom : clampTop(height, viewport.rows, one.bucket.top);
          return { ...one, bucket: { entries, top, follow: one.bucket.follow } };
        }),
      );
    },
    [ledgerFile],
  );

  /** 一条命令的结果之外的那句话；⚠️ 落在**当前会话**的桶里，且**同时**进中间那一行（那行会自己消失，这条不会） */
  // ⚠️ 走 `notice` 那一档而不是 `error`：「拒绝」不是故障，染上危险色就是一句假事实
  const say = useCallback(
    (text: string): void => {
      setMessage(text);
      push(activeId, [{ kind: "notice", rows: [{ kind: "note", text }] }], Date.now());
    },
    [push, activeId],
  );

  // ⚠️ 计时器**跟着消息走**（依赖是 `message` 本身）：写成 `[message !== null]` 会让「换一条消息」
  // 不重启计时器，于是第二条只显示第一段剩余时间。
  useEffect(() => {
    if (message === null) return;
    const timer = setTimeout(() => setMessage(null), MESSAGE_TTL_MS);
    return () => clearTimeout(timer);
  }, [message]);

  /** 滚一段（`delta` 为正是往下）—— **只作用于当前会话** */
  const scrollBy = useCallback(
    (delta: number): void => {
      const viewport = viewportRef.current;
      setSessions((prev) =>
        prev.map((one) => {
          if (one.id !== activeId) return one;
          const height = flatten(one.bucket.entries, viewport.width).height;
          const top = clampTop(height, viewport.rows, one.bucket.top + delta);
          const bottom = clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
          // ⚠️ 滚回最底下时重新贴底：否则新输出在「我明明已经看到最新了」的屏幕上静默地不出现
          return { ...one, bucket: { ...one.bucket, top, follow: top >= bottom } };
        }),
      );
    },
    [activeId],
  );

  /** 直接定位到顶 / 底 */
  const scrollTo = useCallback(
    (where: "top" | "bottom"): void => {
      const viewport = viewportRef.current;
      setSessions((prev) =>
        prev.map((one) => {
          if (one.id !== activeId) return one;
          const height = flatten(one.bucket.entries, viewport.width).height;
          const top =
            where === "top" ? 0 : clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
          return { ...one, bucket: { ...one.bucket, top, follow: where === "bottom" } };
        }),
      );
    },
    [activeId],
  );

  /** 探**任意一个**控制面一次（探活的唯一发起方）；⚠️ 回来的那次靠 `probeSeq` 判新旧（**不是** effect 清理标志：那拦不住已在飞的请求）；⚠️ 在飞要写进去，否则「连接中」与「还没探过」分不开 */
  const reprobe = useCallback((id: string): void => {
    const target = ledgerRef.current?.targets.find((one) => one.id === id);
    if (target === undefined) return;
    const seq = (probeSeq.current.get(id) ?? 0) + 1;
    probeSeq.current.set(id, seq);
    const fresh = (): boolean => probeSeq.current.get(id) === seq;
    setProbes((prev) => new Map(prev).set(id, { pending: true }));
    void probeTarget(clientFor(target))
      .then((result) => {
        if (!fresh()) return;
        setProbes((prev) => new Map(prev).set(id, result));
      })
      .catch(() => {
        // ⚠️ 什么也不写：`ProbeResult` 表达不了「本包有 bug」，而永远兑现不了的「连接中」最坏
        if (!fresh()) return;
        setProbes((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
      });
  }, []);

  useEffect(() => {
    if (current === null) return;
    reprobe(current.id);
    // ⚠️ 依赖只有这两项：挂载与切换会话连的那台（按 `r` 重探活的走的不是这里）
  }, [current?.id, reprobe]);

  /** 把一个会话的对话从 `messages` 表读回来灌进它的桶（⚠️ 每个会话只读一次；**滚动位置不落盘**） */
  const loadMessages = useCallback(
    (sessionId: string): void => {
      if (loadedMessagesRef.current.has(sessionId)) return;
      loadedMessagesRef.current.add(sessionId);
      let restored: readonly LogEntry[];
      try {
        restored = readMessages(ledgerFile, sessionId);
      } catch (err) {
        // ⚠️ 坏内容即拒而**不崩、不静默**：说一句话、那个会话的历史显示为空（且那一格**不落盘**）
        const failure = `这个会话的对话读不出来（${describe(err)}）—— 这一趟它显示为空`;
        setMessage(failure);
        setSessions((prev) =>
          prev.map((one) =>
            one.id === sessionId
              ? {
                  ...one,
                  bucket: {
                    ...one.bucket,
                    entries: append(one.bucket.entries, [{ kind: "notice", rows: [{ kind: "note", text: failure }] }], Date.now()),
                  },
                }
              : one,
          ),
        );
        return;
      }
      if (restored.length === 0) return;
      // ⚠️ **ref 与渲染那一份一起落**：它是下一次 `push` 的发号起点，而两者必须同值
      // （不同值的话下一次 `appendMessages` 拿到的 `seq` 与盘上不符 ⇒ 撞主键）
      entriesRef.current.set(sessionId, restored);
      const viewport = viewportRef.current;
      setSessions((prev) =>
        prev.map((one) => {
          if (one.id !== sessionId) return one;
          // ⚠️ **`id` 必须与盘上的 `seq` 对齐**：`append` 发的是「最后一格 id + 1」，
          // 而盘上那些行的 `seq` 就是读回来的 `id` —— 不对齐的话下一次追加会撞主键
          const height = flatten(restored, viewport.width).height;
          const top = clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
          return { ...one, bucket: { entries: restored, top, follow: true } };
        }),
      );
    },
    [ledgerFile],
  );

  /** 当前会话的对话**第一次成为当前**时读回来（`activeId` 变一次跑一次，重复由那个 ref 兜住） */
  // ⚠️ 判据是 **`activeId` 变了**而不是「在哪个回调里切」—— 四条入口都只改它，而这是唯一的汇合点；
  // 而它**不在 `switchSession` 里**：那个回调是闭包，读不到下一次渲染的那一份
  useEffect(() => {
    loadMessages(activeId);
  }, [activeId, loadMessages]);

  /** 切到某一个会话（⚠️ 什么都不落盘：台账只记「有哪些会话」，不记「现在停在哪一个」） */
  const switchSession = useCallback((id: string): void => {
    setActiveId((before) => (before === id ? before : id));
  }, []);

  /** 把第 `index` 项带进可见窗口（切 / 建 / 关会话后都要走它）；⚠️ `index` 是**侧边栏**下标（隐藏的会话不在其中）；⚠️ 已经在窗口里就一个字节都不改（否则滚轮翻看别的会话会被下一帧拽回来）；落在窗口之下时**顶到 `index`**，不自己算「往回推几格」 */
  const revealSession = useCallback((index: number): void => {
    const fit = Math.max(1, sessionRowsRef.current);
    setSessionsTop((before) => {
      if (index >= before && index < before + fit) return before;
      return index;
    });
  }, []);

  /** 新开一个会话并切过去（`/new` 与菜单里的「新建会话」是同一个入口，发号只有一处） */
  const spawnSession = useCallback((): void => {
    sessionSeq.current += 1;
    const at = sessions.length;
    const id = `s${String(sessionSeq.current)}`;
    const name = `会话 ${String(sessionSeq.current)}`;
    // ⚠️ 从 `null` 开始连（继承当前那个的话「/new 之后还在操作同一台机器」屏上看不出来）
    setSessions((prev) => [...prev, newSession(id, name)]);
    setActiveId(id);
    // ⚠️ 那一项在清单末尾，而清单可能装不下：不带进窗口就是零反馈
    revealSession(at);
    // ⚠️ **落盘是同步的**（`@/services/config` 那几条都直接返回 `void`），而回调里不许 `await` 一个
    // 同步函数 —— 那会让「建好了」这件事推迟一帧，症状是侧边栏上多了一项而盘上没有
    const now = Date.now();
    try {
      saveSession(ledgerFile, { id, name, createdAt: now, updatedAt: now });
      // ⚠️ **新会话立刻进侧边栏**（它就在屏上，不进侧边栏等于「有一个会话屏上却看不到」）
      pinSession(ledgerFile, id, now);
      setSidebarIds((before) => new Set(before).add(id));
    } catch (err) {
      // ⚠️ 这一句**落在新会话自己的桶里**而不是 {@link say} 的「当前会话」：这一刻 `setActiveId` 已经
      // 排进队列了，而闭包里的 `activeId` 还是**上一个** —— 说进上一个的桶等于「新建失败」出现在别人的会话里
      const failure = `这个新会话没存进台账（${describe(err)}）—— 关掉就没了`;
      setMessage(failure);
      push(id, [{ kind: "notice", rows: [{ kind: "note", text: failure }] }], now);
    }
  }, [sessions, ledgerFile, revealSession, push]);

  /** 弹窗里逐槽装什么（⚠️ **高度纯函数**：读的是那三份会话事实，而 `now` 是现读的一帧） */
  const historyCells: readonly HistoryCell[] = useMemo(
    () => groupedHistory(historyRecords, Date.now()),
    [historyRecords],
  );

  /** 弹窗里**可选会话**的 `id`，按屏上顺序（⚠️ 剔除标题槽，而 `windowAt` 数的就是它们） */
  const historyOrder: readonly string[] = useMemo(
    () => historyCells.flatMap((cell) => (cell.record === null ? [] : [cell.record.id])),
    [historyCells],
  );

  /** 把某一个会话从侧边栏上移出（⚠️ 「✕」/`Ctrl+X`/菜单那一项同一个入口，且**不是**「删掉」） */
  const unpinFromSidebar = useCallback(
    (id: string): void => {
      if (sessions.length <= 1) {
        say("至少留一个会话在侧边栏上 —— 没有那一行就说不清「我现在打给谁」");
        return;
      }
      const at = sessions.findIndex((one) => one.id === id);
      if (at < 0) return;
      const rest = sessions.filter((one) => one.id !== id);
      setSessions((prev) => prev.filter((one) => one.id !== id));
      try {
        unpinSession(ledgerFile, id);
        setSidebarIds((before) => {
          const next = new Set(before);
          next.delete(id);
          return next;
        });
      } catch (err) {
        // ⚠️ 同 {@link spawnSession}：这一句说的是「摘不掉」，落进**当前**会话（可能不是被摘的那个）
        say(`这个会话没从侧边栏上移掉（${describe(err)}）—— 重开一次它还在那儿`);
      }
      if (activeId !== id) {
        setSessionsTop((before) => Math.max(0, before - (at < before ? 1 : 0)));
        return;
      }
      const to = Math.max(0, at - 1);
      const picked = rest[to] ?? rest[0];
      if (picked === undefined) return;
      setActiveId(picked.id);
      revealSession(to);
    },
    [sessions, activeId, ledgerFile, say, revealSession],
  );

  /** 激活某一个历史会话（弹窗里 `Enter` 或**点那一行**；⚠️ 已在侧边栏上的那个**只切不重排**） */
  const activateSession = useCallback(
    (id: string): void => {
      const known = sessions.some((one) => one.id === id);
      const at = known ? sessions.findIndex((one) => one.id === id) : sessions.length;
      if (!known) {
        // ⚠️ 库里有记录而内存里没有 ⇒ 它被移出过侧边栏（或这一趟才刚读进来）：造一份新的
        const name = historyRecords.find((one) => one.id === id)?.name ?? `会话 ${id}`;
        setSessions((prev) => [...prev, newSession(id, name)]);
      }
      setActiveId(id);
      revealSession(at);
      // ⚠️ **对话由那支 `activeId` effect 读回来**（它可能从没有被读过：被移出过侧边栏的那一趟，
      // 而盘上那份还在 —— 「切过去看到空的」会被读成「它没说过话」）
      try {
        pinSession(ledgerFile, id, Date.now());
        setSidebarIds((before) => (before.has(id) ? before : new Set(before).add(id)));
      } catch (err) {
        say(`这个会话没激活进侧边栏（${describe(err)}）—— 关掉就没了`);
      }
      closeWindow();
    },
    [sessions, historyRecords, ledgerFile, say, revealSession, closeWindow],
  );

  /** 弹出历史会话弹窗（⚠️ `focus` 为 `null` 时高亮落在**当前会话**那一行 —— 落在第 0 行的话「打开就回车」会静默切到另一个会话） */
  const showHistory = useCallback(
    (focus: string | null): void => {
      // ⚠️ **现读盘**：这一个弹窗的题目是「有过哪些会话」，而本会话里那份 `historyRecords` 是
      // **启动那一刻**的快照 —— 别的挂载写进去的那些它都不知道（症状是「刚 `/new` 出来的会话不在列表里」）
      const wanted = focus ?? activeId;
      let fresh: readonly SessionRecord[] = historyRecords;
      try {
        fresh = readSessions(ledgerFile);
        setHistoryRecords(fresh);
        setSidebarIds(new Set(readSidebar(ledgerFile).map((one) => one.sessionId)));
      } catch (err) {
        say(`会话清单读不出来（${describe(err)}）—— 那个弹窗显示为空`);
      }
      // ⚠️ **下标数的是「可选会话」而不是「第几槽」**：判据是 `historyOrder`（剔掉标题槽的那一串），
      // 而拿 `groupOrder` 的槽位下标去数会把标题行算进去 —— 症状是「高亮落在标题上，
      // 而 `Enter` 删的是另一个会话」（两者在屏上完全不像一件事）
      const selectable = groupOrder(fresh, Date.now()).flatMap((cell) =>
        cell.record === null ? [] : [cell.record.id],
      );
      setWindowAt(Math.max(0, selectable.indexOf(wanted)));
      setWindowKind("sessions");
      // ⚠️ 顺手收掉会话菜单：两个浮层同时开着的话鼠标分派先撞上哪一个全看命中测试的次序，
      // 而屏上没有任何东西解释「为什么点菜单点不动」
      closeMenu();
    },
    [historyOrder, activeId, closeMenu],
  );

  /** `/sessions`（⚠️ **`open-rename` 走的是 {@link openRename} 而不是这里**：那条还要开改名框） */
  const openHistory = useCallback((): void => showHistory(null), [showHistory]);

  /** 弹窗里 `Ctrl+R`：给**高亮那一行**开改名框（⚠️ 与 `/rename` 与菜单里那一项是同一个入口） */
  const renameHighlighted = useCallback((): void => {
    const id = historyOrder[windowAt];
    if (id === undefined) return;
    // ⚠️ 转调同一个 {@link openRename}：它认的是 `id` 而不是「高亮那一行」，
    // 于是删掉一行之后高亮停在别的会话上时不会改错名字
    const found = sessions.find((one) => one.id === id);
    const name = found?.name ?? historyRecords.find((one) => one.id === id)?.name;
    if (name === undefined) return;
    showHistory(id);
    setRename({ id, text: name, cursor: name.length });
  }, [historyOrder, windowAt, sessions, historyRecords, showHistory]);

  /** 弹窗里 `Ctrl+D`：**永久删掉**高亮那一行（⚠️ 三张表一次事务，不在侧边栏上的也在内） */
  const deleteHighlighted = useCallback((): void => {
    const id = historyOrder[windowAt];
    if (id === undefined) return;
    // ⚠️ **侧边栏永远至少有一行**：那一条只约束「从侧边栏移出」，而这里是删库里的行 ——
    // 但删到零行会让侧边栏空掉、当前会话指着一个不存在的 `id`（症状是「一格都没加粗」）
    if (sessions.length <= 1 && sessions[0]?.id === id) {
      say("至少留一个会话 —— 删掉这一个就没有任何一个会话说得清「我在跟谁说话」");
      return;
    }
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
    loadedMessagesRef.current.delete(id);
    entriesRef.current.delete(id);
    const at = sessions.findIndex((one) => one.id === id);
    if (at < 0) {
      // ⚠️ 它本来就不在侧边栏上：屏上那几行一个字都不用改，而高亮要**停在同一串的下标上**
      setWindowAt((before) => Math.min(before, Math.max(0, historyOrder.length - 2)));
      return;
    }
    const rest = sessions.filter((one) => one.id !== id);
    setSessions((prev) => prev.filter((one) => one.id !== id));
    if (activeId !== id) {
      setSessionsTop((before) => Math.max(0, before - (at < before ? 1 : 0)));
      setWindowAt((before) => Math.min(before, Math.max(0, historyOrder.length - 2)));
      return;
    }
    const picked = rest[0];
    if (picked !== undefined) {
      setActiveId(picked.id);
      revealSession(0);
    }
    setWindowAt((before) => Math.min(before, Math.max(0, historyOrder.length - 2)));
  }, [historyOrder, windowAt, sessions, activeId, ledgerFile, say, revealSession]);

  /** 给某一个会话改名（`/rename`、`Ctrl+R` 与菜单里的「重命名」是同一个入口）；⚠️ 打开时框里装的是**它现在的名字**，插入符在末尾 */
  const openRename = useCallback(
    (id: string): void => {
      const name = sessions.find((one) => one.id === id)?.name
        ?? historyRecords.find((one) => one.id === id)?.name;
      if (name === undefined) return;
      // ⚠️ **改名框只住在弹窗里**（`Composer` 不参与）：于是这四个入口都得先把弹窗打开，
      // 而高亮要跟着 `id` 走 —— 不跟的话弹窗开着而框改的是另一个会话
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
    // ⚠️ 弹窗里那一行也要跟着变：它读的是 `historyRecords` 而不是 `sessions`（前者是「有过哪些会话」）
    setHistoryRecords((prev) => prev.map((one) => (one.id === id ? { ...one, name, updatedAt: Date.now() } : one)));
    try {
      renameSession(ledgerFile, id, name, Date.now());
    } catch (err) {
      say(`这次改名没存进台账（${describe(err)}）—— 关掉就没了`);
    }
  }, [rename, sessions, ledgerFile, say]);

  /** 取消改名（⚠️ 只关框：弹窗里那一行与会话自己的输入行一个字都不动，故取消之后还是取消之前那一串） */
  const cancelRename = useCallback((): void => setRename(null), []);

  /** 侧边栏那一列翻几项（指针落在侧边栏上时；`delta` 为正是往下）；⚠️ 只挪窗口，不改当前会话（翻看别的会话不该把「我现在打给谁」也换掉）；一项 = 一会话 */
  const scrollSessions = useCallback(
    (step: number): void => {
      setSessionsTop((before) => Math.max(0, before + step));
    },
    [],
  );

  /** 下一个 / 上一个会话（`Ctrl+N` / `Ctrl+P` / `↑` `↓`；**没有就什么都不做**；⚠️ 循环的是**侧边栏清单那些**，不在 `sidebar_sessions` 上的不参与） */
  const stepSession = useCallback(
    (step: 1 | -1): void => {
      if (sessions.length < 2) {
        if (sessions.length === 1) say("只有 1 个会话，按 /new 可以再开一个");
        return;
      }
      const at = sessions.findIndex((one) => one.id === active.id);
      const to = (Math.max(0, at) + step + sessions.length) % sessions.length;
      const picked = sessions[to];
      if (picked === undefined) return;
      switchSession(picked.id);
      // ⚠️ 循环切换时 `to` 可能绕回窗口之外，故每一次都过一遍「带进窗口」
      revealSession(to);
    },
    [sessions, active.id, switchSession, say, revealSession],
  );

  /** 弹出会话菜单（⚠️ **重新弹出会把高亮清回第 0 项**：那是一次新的选择，旧的高亮指向另一份清单） */
  const openMenu = useCallback((sessionId: string | null, x: number, y: number): void => {
    setMenuAt(0);
    setMenu({ sessionId, x, y });
  }, []);

  /** 菜单高亮上下挪（⚠️ 走到底**就停住**，不循环：`Tab` 是「接受」，绕回去会按错一项） */
  const moveMenu = useCallback(
    (step: 1 | -1): void => {
      const count = menuItemsOf(menu).length;
      if (count === 0) return;
      setMenuAt((before) => Math.max(0, Math.min(count - 1, before + step)));
    },
    [menu],
  );

  /** 选中菜单里第 `index` 项（`null` index = 高亮那一项，键位走它；鼠标按命中的那一格给下标） */
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
        spawnSession();
        return;
      }
      if (label === MENU_DETACH) unpinFromSidebar(target);
      else if (label === MENU_RENAME) openRename(target);
      else if (label === MENU_NEW) spawnSession();
    },
    [menu, menuAt, spawnSession, unpinFromSidebar, openRename],
  );

  /** 让某一个会话连上某一个控制面（现读现写）；⚠️ 现读是因为 {@link push} 之后内存里那份可能比磁盘旧；⚠️ 写失败不回滚（它确实发生了、只是没存下来） */
  const useTarget = useCallback(
    (sessionId: string, targetId: string): void => {
      setSessions((prev) =>
        prev.map((one) => (one.id === sessionId ? { ...one, targetId } : one)),
      );
      let failure: string | null = null;
      try {
        writeLedger(ledgerFile, setSelected(readLedger(ledgerFile), targetId));
      } catch (err) {
        failure = describe(err);
      }
      holdLedger(readLedgerSafe(ledgerFile) ?? ledgerRef.current);
      setLedgerTick((tick) => tick + 1);
      if (failure !== null) {
        say(`这次切换没存进台账（${failure}）—— 界面上已经切过去了，关掉就没了`);
      }
    },
    [ledgerFile, holdLedger, say],
  );

  /** 执行层要用的依赖（**现造**，故它读到的是调用那一刻的最新状态） */
  const depsFor = useCallback(
    (job: Job): ExecDeps => ({
      client: current === null ? null : clientFor(current),
      width: viewportRef.current.width,
      line: job.line,
      // ⚠️ **台账的写一律经这几个回调**：直接 `writeLedger` 会造出「内存与磁盘漂移」
      onTargetAdd: (request): void => {
        const next = upsertTarget(readLedger(ledgerFile), {
          name: request.name,
          baseUrl: request.baseUrl,
          token: request.token,
          // ⚠️ 缺省超时在这里补，且**只**在这里补（真值只有 `@/services/config:DEFAULT_TIMEOUT_MS` 一处）
          timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        holdLedger(next);
        writeLedger(ledgerFile, next);
        setLedgerTick((tick) => tick + 1);
      },
      onTargetDel: (name): void => {
        const next = removeTarget(readLedger(ledgerFile), idOfName(ledgerRef.current, name));
        holdLedger(next);
        writeLedger(ledgerFile, next);
        setLedgerTick((tick) => tick + 1);
      },
      onTargetSwitch: (name): void => {
        const id = idOfName(ledgerRef.current, name);
        useTarget(job.sessionId, id);
      },
      onProviderSet: (input): void => {
        writeProvider(ledgerFile, input);
        holdProvider(readProviderSafe(ledgerFile));
      },
      onProviderKey: (apiKey): void => {
        // ⚠️ **读出另外两样再整体写回**：那样「配了一半」在库里永远不存在（判据在 `validateProviderInput`）
        const before = readProviderSafe(ledgerFile);
        writeProvider(ledgerFile, { ...before, apiKey });
        holdProvider(readProviderSafe(ledgerFile));
      },
      // ⚠️ **打码只有这一处**：`/provider show` 拿到的那一份恒是掩码过的
      provider: () => redactProvider(providerRef.current),
      // ⚠️ `/batch` 的「名字 → 客户端」在**这里**解：执行层不读台账（理由见 `ExecDeps.peers`）
      peers: (names) => peersOf(names, ledgerRef.current),
    }),
    [current, ledgerFile, holdLedger, useTarget, holdProvider],
  );

  /** `/batch`：一条命令 → N 个控制面 */
// ⚠️ **串行**且**逐台追加**（三条取舍见 `@/lib/exec/AGENTS.md`）；结果**当场**落桶，不攒完了一次性给
const runBatch = useCallback(
  (sessionId: string, effect: Extract<Effect, { kind: "batch" }>): void => {
    if (effect.peers.length === 0) {
      push(sessionId, [{ kind: "error", rows: [{ kind: "err", text: BATCH_NO_TARGET }] }], Date.now());
      return;
    }
    void fanOut(effect.command, effect.peers, (peer) => ({
      ...depsFor({ sessionId, line: effect.line, command: effect.command }),
      client: peer.client,
    })).then(({ reports, effects }) => {
      const turns: Turn[] = [];
      for (const report of reports) {
        turns.push({ kind: "tool-call", echo: { kind: "echo", text: `${report.name} · ${effect.line}` } });
        turns.push(
          report.ok
            ? { kind: "tool-result", rows: report.rows }
            : { kind: "error", rows: report.rows },
        );
      }
      turns.push({ kind: "notice", rows: [summaryOf(reports)] });
      push(sessionId, turns, Date.now());
      for (const one of effects) applyEffectRef.current(sessionId, one);
    });
  },
  [depsFor, push],
);

/** 「三台里两台成功」那一句（⚠️ **逐台数**而不是只说「完成」—— 少一句就等于让操作者自己数） */
function summaryOf(reports: readonly BatchReport[]): LogRow {
  const ok = reports.filter((one) => one.ok).length;
  const bad = reports.length - ok;
  const tally = bad === 0 ? `${String(ok)} 台全部成功` : `${String(ok)} 台成功 · ${String(bad)} 台失败`;
  return { kind: bad === 0 ? "note" : "err", text: `/batch ${tally}（共 ${String(reports.length)} 台）` };
}

/** 一个名字都不在台账里（⚠️ **不是空跑**：说清楚「你说给谁听」这件事没成立） */
const BATCH_NO_TARGET = "台账里没有这些控制面 —— /managers 看有哪些，或 /batch all 发给全部";

/** `/exit` 撞上在飞的东西时的那一句（⚠️ 说「跑完再退」而不是静默不响应 —— 静默与「没生效」在屏上一样） */
const EXIT_BUSY = "还有命令在跑，跑完再退";

/** `/batch` 的那些名字 → 目标（⚠️ `all` 在这里对着台账展开，而**顺序恒等于台账顺序**） */
function peersOf(names: readonly string[], ledger: Ledger | null): readonly BatchPeer[] {
  const all = ledger?.targets ?? [];
  if (names.length === 1 && names[0] === ALL_TARGETS) {
    return all.map((one) => ({ name: one.name, client: clientFor(one) }));
  }
  // ⚠️ **按台账顺序**而不是按命令里写的顺序：结果区的排序恒等于台账那一列，两处各排一次就会错位
  return all
    .filter((one) => names.includes(one.name))
    .map((one) => ({ name: one.name, client: clientFor(one) }));
}

/** 一条命令的**副作用**。⚠️ **穷举**而不是「取第一条」：多一个 `Effect` 种类时这一支会编译期红 */
  const applyEffect = useCallback(
    (sessionId: string, effect: Effect): void => {
      switch (effect.kind) {
        case "clear-log":
          setSessions((prev) =>
            prev.map((one) => (one.id === sessionId ? { ...one, bucket: emptyBucket() } : one)),
          );
          // ⚠️ **盘上那一份也得空**（`messages` 表按 `(session_id, seq)` 主键存着这个会话的每一格）：
          // 只清内存的话重开一次它原样回来，而「结果区被清空」那句话就成了假事实
          try {
            clearMessages(ledgerFile, sessionId);
            loadedMessagesRef.current.add(sessionId);
            // ⚠️ 发号**归零**：盘上那一份已经空了，而下一次 `push` 要从 `1` 起（否则那一格永远补不上）
            entriesRef.current.set(sessionId, []);
          } catch (err) {
            say(`这个会话的对话没清掉（${describe(err)}）—— 重开一次它还在那儿`);
          }
          break;
        case "reprobe":
          if (current !== null) reprobe(current.id);
          break;
        case "ledger-changed":
          setLedgerTick((tick) => tick + 1);
          break;
        case "target-switched":
          // ⚠️ 刻意什么都不做：`onTargetSwitch` 那一刻已经换掉 `targetId` 并落盘
          break;
        case "session-new":
          // ⚠️ 转调 {@link spawnSession}：两条入口不许各造一次会话（发号只有一处）
          spawnSession();
          break;
        case "open-rename":
          // ⚠️ 走**同一个**入口（`/rename`、`Ctrl+R`、菜单里的「重命名」、弹窗里的 `Ctrl+R`），
          // 故名字从哪儿来只有一处判 —— 而那条入口**顺带把历史会话弹窗打开**（改名框住在弹窗里）
          openRename(active.id);
          break;
        case "open-sessions":
          // ⚠️ 转调 {@link openHistory}：`/sessions` 与弹窗里那几个动作共用一个打开入口
          openHistory();
          break;
        case "show-managers":
          // ⚠️ 高亮**默认落在当前会话连的那一台**上：落在第 0 行的话「打开窗口就回车」会静默切到另一台
          setWindowAt(Math.max(0, targets.findIndex((one) => one.id === active.targetId)));
          setWindowKind("managers");
          setRename(null);
          // ⚠️ 顺手收掉会话菜单：两个浮层同时开着的话鼠标分派先撞上哪一个全看命中测试的次序，
          // 而屏上没有任何东西解释「为什么点菜单点不动」
          closeMenu();
          break;
        case "batch":
          runBatch(sessionId, effect);
          break;
        case "provider-show":
          // ⚠️ 什么都不做：那些行由执行层**当场**落桶（打码在 `depsFor` 那个回调里已经做过）
          break;
        case "provider-set":
        case "provider-key":
          // ⚠️ 写盘与刷新都已经在 `depsFor` 的那两个回调里做完了（成败那一行也在那里）
          break;
        // ⚠️ **还有东西在飞就退不成**：它们落地时都要往台账上写，而 `finish()` 先 `closeLedgerDb()` ——
          // 症状是组件已经 `unmount` 之后才抛出来的「库已关」，屏上零解释
        case "request-exit":
          // ⚠️ 不会把人卡死：队列是**串行**且有限的，而每一次在飞的操作都有上界（控制面走
          // `DEFAULT_TIMEOUT_MS` / `TIMEOUT_BOUNDS`，模型走 `MODEL_TIMEOUT_MS`）⇒ 最坏是等到那个超时
          if (queueRef.current.length > 0 || busyRef.current || chatting) {
            say(EXIT_BUSY);
            break;
          }
          // ⚠️ 退出**必须**汇进组合根那一个 `finish()`：本层零 `process.*`、也不许调 `process.exit()`
          exit();
          break;
        default: {
          // ⚠️ `default: throw` 让穷举检查失效（`Effect` 多一档而少写一个 `case` 时 `tsc` 零错，
          // 而用户敲那条命令时运行期才炸）；**这一句才是那道锁**，而它的全部机制就是形参那个 `never`
          const unreachable: never = effect;
          throw new Error(`应用层不认识这个副作用：${JSON.stringify(unreachable)}`);
        }
      }
    },
    [
      current,
      reprobe,
      targets,
      active.targetId,
      active.id,
      ledgerFile,
      spawnSession,
      openRename,
      openHistory,
      closeMenu,
      runBatch,
      say,
      chatting,
      exit,
    ],
  );

  useEffect(() => {
    applyEffectRef.current = applyEffect;
  }, [applyEffect]);

  /** 启动队列里的下一条（**串行化的全部实现**）；⚠️ 排队而不并发（并发的 `clear-log` 会抹掉另一条刚落地半秒的结果）；⚠️ `finally` 里回调自己才是串行化的关键 */
  const pump = useCallback((): void => {
    if (busyRef.current) return;
    const job = queueRef.current.shift();
    if (job === undefined) return;
    busyRef.current = true;
    setRunning(job.line);
    void exec(job.command, depsFor(job))
      .then((result) => {
        // ⚠️ **一个字节都不留的命令不许留下「一格空对话」**：桶里有内容而屏上零行 ⇒ 引导屏被顶掉，
        // 而 `/new` / `/managers` 那些纯界面动作正是这一档（`leavesTrace` 说它们不留痕）
        if (result.rows.length > 0) {
          push(job.sessionId, [{ kind: "tool-result", rows: result.rows }], Date.now());
        }
        // ⚠️ **串行化的名额在副作用之前交回去**：`busyRef` 答的是「还有哪一条 `exec` 在飞」，
        // 而这一条已经飞完了 —— 不交回去的话 `/exit` 会把「自己在飞」当成「还有别的在飞」
        busyRef.current = false;
        for (const effect of result.effects) applyEffect(job.sessionId, effect);
      })
      .catch(() => {
        push(
          job.sessionId,
          [
            {
              kind: "error",
              rows: [{ kind: "err", text: "本包在执行这条命令时崩了（不是控制面的回答）" }],
            },
          ],
          Date.now(),
        );
      })
      .finally(() => {
        busyRef.current = false;
        setRunning(null);
        // ⚠️ 「跑完了」由**这个会话**还有没有排队的东西决定：队列是全局串行的，而「跑完了」
        // 说的是**这一个会话**的话 —— 拿全局队列空不空来判的话，别人的命令会让它一直转圈
        const more = queueRef.current.some((one) => one.sessionId === job.sessionId);
        if (!more) {
          setSessions((prev) =>
            prev.map((one) => (one.id === job.sessionId ? { ...one, run: "done" } : one)),
          );
        }
        pumpRef.current();
      });
  }, [depsFor, push, applyEffect]);

  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  /** 一句不是命令的话 → 模型那一圈（⚠️ **它不走 `pump`**：那一圈自己要往返好几轮，而 `pump` 一次只跑一条） */
  const sayToModel = useCallback(
    (text: string): void => {
      const sessionId = activeId;
      const history = active.bucket.entries.flatMap((entry) => entry.turns);
      setChatting(true);
      void ask(text, history, {
        endpoint: modelEndpointOf(providerRef.current),
        timeoutMs: MODEL_TIMEOUT_MS,
        execDeps: depsFor({ sessionId, line: text, command: { kind: "clear" } }),
      }).then((result) => {
        setChatting(false);
        if (result.kind === "ok") {
          push(sessionId, result.turns, Date.now());
          for (const effect of result.effects) applyEffect(sessionId, effect);
          return;
        }
        push(
          sessionId,
          [...result.turns, { kind: result.kind === "no-provider" ? "notice" : "error", rows: result.rows }],
          Date.now(),
        );
      });
    },
    [activeId, active.bucket.entries, depsFor, push, applyEffect],
  );

  /** 提交一行：**先分流**（命令 vs 一句话）→ 清输入行 → 排队 / 贴判据 */
  // ⚠️ **不以 `/` 开头的那一行是普通聊天消息**（走模型），而**不是**一条解析失败 ——
  // 判据是 {@link COMMAND_PREFIX} 那一个字符，而命令表本身仍是唯一那份命令真相源
  // ⚠️ **两档都先清输入行，且在任何 `push` 之前**：不回显原文（回显只有 {@link exec} 那一个来源）
  const submit = useCallback(
    (raw: string): void => {
      const line = raw.trim();
      const isCommand = line.startsWith(COMMAND_PREFIX);
      const parsed: ParseResult = isCommand ? parseLine(line) : { kind: "empty" };
      setSessions((prev) =>
        prev.map((one) =>
          one.id === activeId
            ? {
                ...one,
                input: "",
                cursor: 0,
                // ⚠️ **只有真的排上了队才亮那枚转圈**：光按一次回车或解析失败的时候亮它，
                // 它就永远等不到「跑完了」—— 而那一格恒在
                run: parsed.kind === "ok" ? "running" : one.run,
              }
            : one,
        ),
      );
      if (line === "") return;
      if (!isCommand) {
        sayToModel(line);
        return;
      }
      if (parsed.kind === "ok") {
        queueRef.current.push({ sessionId: activeId, line, command: parsed.command });
        pumpRef.current();
        return;
      }
      push(activeId, [{ kind: "error", rows: rowsOfFailure(parsed) }], Date.now());
    },
    [activeId, push, sayToModel],
  );

  const palette = useMemo(() => paletteOf(active.input), [active.input]);

  const movePalette = useCallback(
    (step: 1 | -1): void => {
      const to = paletteStep(palette.at, step, palette.rows.length);
      const row = palette.rows[to];
      if (row === undefined || to === palette.at) return;
      const filled = paletteFill(active.input, active.cursor, row);
      setSessions((prev) =>
        prev.map((one) =>
          one.id === activeId ? { ...one, input: filled.line, cursor: filled.cursor } : one,
        ),
      );
    },
    [palette, active.input, active.cursor, activeId],
  );

  /** `Tab` / 鼠标点行要接受的那一行补进输入行（`null` = 「这一刻没有可接受的那一行」） */
  const acceptPalette = useCallback((): { line: string; cursor: number } | null => {
    const row = palette.rows[palette.at];
    return row === undefined ? null : paletteFill(active.input, active.cursor, row);
  }, [palette, active.input, active.cursor]);

  /** 弹窗里那一列一共有几个**可选会话**（⚠️ 控制面清单数 `targets`，历史会话数 `historyOrder`） */
  const windowTotal = windowKind === "sessions" ? historyOrder.length : targets.length;

  /** 窗口里 `↑`/`↓`/`Tab` 走一行（⚠️ 走到底就停住，不循环 —— 循环的话按着 `↓` 会一路滑回第一行） */
  const moveWindow = useCallback(
    (step: 1 | -1): void => {
      setWindowAt((before) => {
        const last = Math.max(0, windowTotal - 1);
        return Math.max(0, Math.min(last, before + step));
      });
    },
    [windowTotal],
  );

  /** 接受高亮那一项（`Enter`；⚠️ 控制面清单 = **接到当前会话**，历史会话 = **激活进侧边栏**） */
  const pickWindow = useCallback((): void => {
    if (windowKind === "sessions") {
      const id = historyOrder[windowAt];
      if (id !== undefined) activateSession(id);
      return;
    }
    const picked = targets[windowAt];
    if (picked !== undefined) useTarget(activeId, picked.id);
    closeWindow();
  }, [windowKind, historyOrder, windowAt, targets, activateSession, useTarget, activeId, closeWindow]);

  /** 点弹窗里**第 `at` 个可选行**（⚠️ ⚠️ **点那一行就是接受那一项** —— 需求原文「`Enter` 或**点击**可激活」，而控制面清单那档点行只挪高亮） */
  const pickWindowRow = useCallback(
    (at: number): void => {
      setWindowAt(at);
      if (windowKind === "sessions") {
        const id = historyOrder[at];
        if (id !== undefined) activateSession(id);
      }
    },
    [windowKind, historyOrder, activateSession],
  );

  /** 点弹窗里那个改名输入框 → 落插入符（⚠️ 读 `windowInputText` 那一格：整行**含提示符**，按整行算会偏掉那几列） */
  const caretRename = useCallback(
    (at: number): void => {
      setRename((before) => (before === null ? before : { ...before, cursor: at }));
    },
    [],
  );

  /** 三个写入口**按「改名框开着没有」分流**（⚠️ 两处各判一次的话，`Ctrl+X` 会在改名时删掉半个名字） */
  const editingRename = rename !== null;
  // ⚠️ **`esc 关窗` 画不画，全包只有这一份推导**（命中测试那份几何与呈现层那份都读它）；
  // 判据只是 `editingRename` —— **不**问 `windowKind`：改名框只住在历史会话弹窗里
  const closeHint = !editingRename;
  const editActive = useCallback<EditActive>(
    (change) => {
      if (editingRename) {
        setRename((before) =>
          before === null
            ? before
            : (() => {
                const after = change(before.text, before.cursor);
                return { ...before, text: after.text, cursor: after.cursor };
              })(),
        );
        return;
      }
      setSessions((prev) =>
        prev.map((one) => {
          if (one.id !== activeId) return one;
          const after = change(one.input, one.cursor);
          return { ...one, input: after.text, cursor: after.cursor };
        }),
      );
    },
    [activeId, editingRename],
  );

  const caretActive = useCallback<CaretActive>(
    (pick) => {
      if (editingRename) {
        setRename((before) =>
          before === null ? before : { ...before, cursor: pick(before.text, before.cursor) },
        );
        return;
      }
      setSessions((prev) =>
        prev.map((one) =>
          one.id === activeId ? { ...one, cursor: pick(one.input, one.cursor) } : one,
        ),
      );
    },
    [activeId, editingRename],
  );

  const fillActive = useCallback<FillActive>(
    (patch) => {
      if (editingRename) {
        setRename((before) => (before === null ? before : { ...before, ...patch }));
        return;
      }
      setSessions((prev) =>
        prev.map((one) => (one.id === activeId ? { ...one, ...patch } : one)),
      );
    },
    [activeId, editingRename],
  );

  /** 把**当前**会话从侧边栏上移出（`Ctrl+X`；与侧边栏那一枚「✕」和菜单里那一项同一个入口，见 {@link unpinFromSidebar}） */
  const detachActiveSession = useCallback((): void => {
    unpinFromSidebar(activeId);
  }, [unpinFromSidebar, activeId]);

  /** 给**当前**会话改名（`Ctrl+R`；与 `/rename`、菜单里的「重命名」同一个入口，见 {@link openRename}） */
  const renameActiveSession = useCallback((): void => {
    openRename(activeId);
  }, [openRename, activeId]);

  useHotkeys({
    renaming: editingRename,
    confirmRename,
    cancelRename,
    menuOpen: menu !== null,
    moveMenu,
    pickMenu: () => pickMenu(null),
    closeMenu,
    windowKind,
    closeWindow,
    moveWindow,
    pickWindow,
    deleteWindowRow: deleteHighlighted,
    renameWindowRow: renameHighlighted,
    stepSession,
    detachActiveSession,
    renameActiveSession,
    scrollBy,
    scrollTo,
    movePalette,
    acceptPalette,
    palette,
    targets,
    // ⚠️ **改名框那一串字不进 `input`**：而它住在弹窗里，故这一格恒是会话自己的输入行
    input: active.input,
    cursor: active.cursor,
    editActive,
    caretActive,
    fillActive,
    submit,
  });

  /** 侧边栏那几行（⚠️ 认 `id` 不认下标；它就是内存里 `sessions` 的**全量**） */
  const sessionRows: readonly SessionRow[] = useMemo(
    () =>
      sessions.map((one) => ({
        id: one.id,
        name: one.name,
        manager: targets.find((t) => t.id === one.targetId)?.name ?? null,
        run: one.run,
      })),
    [sessions, targets],
  );

  /** 台账里每个控制面的连接状态（状态行按它数台数；窗口里每一行的字形也走同一个换算） */
  const managerStates = useMemo(
    () => targets.map((one) => connectionStateOf(probes.get(one.id))),
    [targets, probes],
  );

  /** 指针当前悬停在哪个会话上（`null` = 不在侧边栏上） */
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  /** 指针是不是正落在悬停那一项的「✕」上；⚠️ 命中测试不看悬停（`sidebarCloseRows` 那一格点得中就是点得中），而「亮成别按那一档」只能由 `move` 回答 */
  const [sessionCloseHot, setSessionCloseHot] = useState(false);
  /** 指针在不在拖宽手柄上（那一列给一层底色，于是「能拖」看得见） */
  const [handleHot, setHandleHot] = useState(false);

  /**
   * 弹窗里**逐槽**装什么（⚠️ **与呈现层那一份同序同长** —— 两处各排一次就会裁到别人的位置上）
   */
  const windowSlots: readonly WindowSlot[] = useMemo(
    () =>
      windowKind === "sessions"
        ? historySlots(historyCells, editingRename)
        : windowKind === "managers"
          ? [
              // ⚠️ 空台账时那句话是内容区第一行，而键位说明住在卡片右上角那一枚 `esc` 上
              ...(targets.length === 0 ? [{ kind: "note" as const }] : []),
              ...targets.map((): WindowSlot => ({ kind: "row" })),
            ]
          : [],
    [windowKind, historyCells, editingRename, targets.length],
  );

  /** 几何（本层与 `Layout` 调的是同一个纯函数、喂的是同一组字段）；⚠️ `input` 喂**原文**（不是行数：两处各折一次就是两份判据）；⚠️ 宽高喂 `size` 的当前值（拿 props 算会得到两份几何） */
  const g = useMemo(
    () =>
      geometry({
        columns: size.columns,
        rows: size.rows,
        sidebarWidth,
        sessionCount: sessionRows.length,
        sessionsTop,
        input: active.input,
        paletteCount: palette.rows.length,
        window: windowSlots,
        // ⚠️ **读上面那一份推导**（`closeHint`），而这里那份几何是喂命中测试的 —— 它与呈现层那份必须同值
        windowCloseHint: closeHint,
        menu:
          menu === null
            ? null
            : { x: menu.x, y: menu.y, items: menuItemsOf(menu) },
      }),
    [
      size.columns,
      size.rows,
      sidebarWidth,
      sessionRows.length,
      sessionsTop,
      active.input,
      palette.rows.length,
      windowSlots,
      closeHint,
      menu,
    ],
  );

  /** 面板滚动窗口的第一行号（**绘制与命中测试共用它**） */
  const windowStart = paletteWindow(palette.at, g.paletteViewportRows, palette.rows.length);

  useEffect(() => {
    viewportRef.current = { width: g.outputWidth, rows: g.outputRows };
    sessionRowsRef.current = g.sessionViewportRows;
  }, [g.outputWidth, g.outputRows, g.sessionViewportRows]);

  useMouse({
    mouse,
    geometry: g,
    sessionRows,
    activeId,
    input: active.input,
    cursor: active.cursor,
    palette,
    windowStart,
    windowKind,
    renameText: rename?.text ?? "",
    sidebarWidth,
    switchSession,
    scrollBy,
    scrollSessions,
    openMenu,
    pickMenu,
    closeMenu,
    menuOpen: menu !== null,
    unpinSession: unpinFromSidebar,
    movePalette,
    closeWindow,
    pickWindowRow,
    caretRename,
    fillActive,
    resizingRef,
    setSidebarWidth,
    setHoveredId,
    setSessionCloseHot,
    setHandleHot,
  });

  const bucket: Bucket = active.bucket;
  const flat: FlatLog = useMemo(
    () => flatten(bucket.entries, g.outputWidth),
    [bucket.entries, g.outputWidth],
  );
  // ⚠️ 读的时候再夹一次：越界的 `top` 让 `visibleLines` 返回空数组（界面上是「结果区空了」）
  const top = clampTop(flat.height, g.outputRows, bucket.top);

  /** 补全建议（⚠️ 改名框开着时**一律没有**：那一格里装的是会话名，而 `/` 开头的会话名会让命令面板浮起来） */
  const suggestion = editingRename
    ? { line: rename?.text ?? "", cursor: 0, candidates: [] }
    : complete({
        line: active.input,
        cursor: active.cursor,
        targetNames: targets.map((one) => one.name),
      });
  /** 幽灵文本 = **「按 Tab 会插进来什么」**，两条来源合成**一个**出口。 */
  const fillable = !editingRename && palette.open ? acceptPalette() : null;
  const ghost =
    fillable !== null && fillable.cursor > active.cursor
      ? fillable.line.slice(active.cursor, fillable.cursor)
      : suggestion.cursor > active.cursor && suggestion.candidates.length > 0
        ? suggestion.line.slice(active.cursor)
        : null;

  /** 输入区中间那一行：三档，⚠️ 「台账读不出来」排最后是因为它**不消失**（而改名那一档在弹窗里，不在这儿） */
  const notice =
    running !== null
      ? `执行中：${running}`
      : chatting
        ? "模型那一圈在跑（它可能要来回好几趟）"
        : message ?? (ledgerError === null ? null : `台账读不出来：${ledgerError.message}`);

  /** 命令面板（`null` = 没开）；⚠️ `rows` 给行号序、`at` 也换算成行号（呈现层不需要知道首行号）；⚠️ 改名框开着时它**恒不开** */
  const paletteView: PaletteView | null =
    editingRename || !palette.open
      ? null
      : {
          total: palette.rows.length,
          rows: palette.rows
            .slice(windowStart, windowStart + g.paletteViewportRows)
            .map((row) => ({ text: row.path, summary: row.summary })),
          at: palette.at - windowStart,
          footer:
            g.paletteFooterRow === null
              ? null
              : `第 ${String(windowStart + 1)}–${String(
                  windowStart + Math.min(g.paletteViewportRows, palette.rows.length - windowStart),
                )} 条 · 共 ${String(palette.rows.length)} 条 · ↑↓ 选 · Tab 接受`,
        };

  /** 模态窗口的内容（`null` = 没开）；⚠️ 链接在这一行而不在状态行（那行恒定，而链接随会话连的那台变）；⚠️ 删除仍然走命令——一个「点一下就删掉」的按钮删的是管理员凭据 */
  const windowRows: readonly WindowRow[] = useMemo(
    () =>
      targets.map((one) => ({
        id: one.id,
        name: one.name,
        detail: `${one.baseUrl} · 超时 ${String(one.timeoutMs)}ms`,
        state: connectionStateOf(probes.get(one.id)),
        current: one.id === current?.id,
      })),
    [targets, probes, current?.id],
  );

  // ⚠️ **`window` 与 `history` 恒有一个是 `null`**：一个窗口一次只开一种内容，而两档的行模型不同
  const windowView: WindowView | null =
    windowKind !== "managers"
      ? null
      : {
          title: `控制面（${targets.length}）`,
          rows: windowRows,
          at: windowAt,
          // ⚠️ **空台账时那句话是内容区第一行**，而键位说明住在卡片右上角那一枚 `esc` 上
          note:
            targets.length === 0
              ? "台账里还没有控制面 · 用 /target add <名字> <地址> <token> 加一个"
              : null,
        };

  /** 某个会话连的是哪台控制面（⚠️ 弹窗里那一列答的是同一件事，故**这一处**是唯一的换算） */
  const managerNameOf = useCallback(
    (id: string): string | null => {
      const one = sessions.find((row) => row.id === id);
      if (one === undefined) return null;
      return targets.find((t) => t.id === one.targetId)?.name ?? null;
    },
    [sessions, targets],
  );

  /** 历史会话弹窗（`null` = 没开）；⚠️ 名字的裁剪预算取**几何给的槽宽**，而呈现层一行宽度都不许自己算 */
  const historyView: SessionHistoryView | null =
    windowKind !== "sessions"
      ? null
      : {
          title: historyTitle(historyOrder.length),
          rows: historyRows(historyCells, sidebarIds, managerNameOf, g.windowSlots),
          // ⚠️ **数的是可选会话而不是数组下标**：`windowRows` 只含 `row` 槽，隔着标题数就错位了
          at: windowAt,
          note: historyOrder.length === 0 ? NO_HISTORY_NOTE : null,
          rename: renameView(rename, g.windowInput),
          // ⚠️ **与喂 `useMouse` 的那份几何同一个值**（上面那份 `closeHint`）：两处各判一次的话，
          // 「点右上角点不动」与「点别处却关了窗」都只在屏上留下一片空白
          closeHint,
        };

  /** 会话菜单（`null` = 没开；⚠️ `origin` 是那次右键的落点，**不是**菜单自己的坐标 —— 落在哪儿由几何层算） */
  const menuView: MenuView | null =
    menu === null
      ? null
      : {
          sessionId: menu.sessionId,
          items: menuItemsOf(menu),
          at: menuAt,
          origin: [menu.x, menu.y],
        };

  return (
    <Layout
      columns={size.columns}
      rows={size.rows}
      color={color}
      version={version}
      sidebarWidth={sidebarWidth}
      sessions={sessionRows}
      sessionsTop={sessionsTop}
      selectedSessionId={activeId}
      hoveredSessionId={hoveredId}
      sessionCloseHot={sessionCloseHot}
      handleHot={handleHot}
      managerStates={managerStates}
      flat={flat}
      top={top}
      // ⚠️ **改名框那一串字不进输入行**（它住在弹窗里），而 `Composer` 不参与改名
      input={active.input}
      cursor={active.cursor}
      ghost={ghost}
      notice={notice}
      palette={paletteView}
      mouseHint={mouseUnsupportedHintOf(mouse.liveness(), Date.now())}
      // ⚠️ logo 只在「当前会话还没有任何输出」时占位（台账为空时唯一能敲的那两条命令的输出正落在那桶）
      showLogo={!flat.any}
      droppedHint={droppedHint(bucket)}
      window={windowView}
      history={historyView}
      menu={menuView}
    />
  );
}
