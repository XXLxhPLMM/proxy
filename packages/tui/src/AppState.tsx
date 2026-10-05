/**
 * @fileoverview 根组件：全屏 console 的应用状态层（唯一持有跨帧状态，唯一把一次动作翻成若干次 `setState`）
 */
// ⚠️ `AppProps` 上那**一个**函数字段（`exit`）是组合根边界而不是呈现契约：`LayoutProps`「零个函数字段」
// 那条纪律不许它长到 props 里，而退出必须汇进 `cli.tsx` 那个幂等 `finish(0, null)` ⇒ 状态层只能接一个回调

import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";

import {
  ALL_TARGETS,
  COMMAND_PREFIX,
  complete,
  paletteFill,
  paletteOf,
  paletteStep,
  paletteWindow,
  parseLine,
  readTraffic,
  type ParseResult,
} from "@/commands/index.js";
import {
  DEFAULT_REASONING_EFFORT,
  DEFAULT_TIMEOUT_MS,
  LedgerError,
  MODEL_API_FORMATS,
  REDACTED_PROVIDER_KEY,
  REDACTED_TOKEN,
  TIMEOUT_BOUNDS,
  appendMessages,
  clearMessages,
  clientFor,
  idFor,
  joinModelRef,
  pinSession,
  probeTarget,
  readLedger,
  readMessages,
  readProviderModels,
  readProviders,
  readSessionModels,
  readSessions,
  readSidebar,
  redactProviderView,
  redactTarget,
  removeModel,
  removeProvider,
  removeSession,
  removeTarget,
  renameSession,
  saveSession,
  selectedTarget,
  setSelected,
  splitModelRef,
  trimMessages,
  unpinSession,
  upsertProvider,
  upsertTarget,
  writeLedger,
  writeProviderModels,
  writeSessionModel,
  type Ledger,
  type ModelRecord,
  type ProviderRecord,
  type ReasoningEffort,
  type Target,
} from "@/services/config/index.js";
import type { AccountBody } from "@/api/index.js";
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
import { listProviderModels, type DialectInput } from "@/services/model/index.js";
import { connectionStateOf, type ProbeSlot } from "@/theme/index.js";
import { mouseUnsupportedHintOf, type MouseSource } from "@/services/terminal/index.js";
import { Layout } from "@/app.js";
import {
  type FieldCell,
  type ListRow,
  type MenuView,
  type ModelCheckRow,
  type ModelListRow,
  type ModelStatusView,
  type ModalView,
  type PaletteView,
  type RenameField,
  type SessionListRow,
  type SessionRow,
} from "@/components/index.js";
import {
  SIDEBAR_WIDTH,
  WINDOW_INPUT_PROMPT_COLUMNS,
  dayGroupLabel,
  describe,
  droppedHint,
  ellipsis,
  geometry,
  normalizeSelection,
  pushHistory,
  readLedgerSafe,
  rowsOfFailure,
  type HistoryStep,
  type Rect,
  type WindowSlot,
} from "@/lib/index.js";
import {
  LOG_KEEP,
  MESSAGE_TTL_MS,
  MODEL_TIMEOUT_MS,
  REASONING_CYCLE,
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
  type WindowState,
} from "@/store/index.js";
import { useHotkeys, useMouse, useTerminalSize, type ResizeStart } from "@/hooks/index.js";

/* ── 菜单 ──────────────────────────────────────────────────────────────────── */

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

/* ── 内容区逐格：说明 / 分组标题 / 可选项 ──────────────────────────────────── */

/** 内容区里的一格（⚠️ **三档混在同一个数组里**：几何层按行铺位置，拆开就得另有一处换算） */
type Cell<T> =
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "group"; readonly text: string }
  | { readonly kind: "row"; readonly item: T };

/** 逐格 ⇒ 槽位串（**一趟算完** —— 各算一遍就会与绘制错开一行，而症状是「点第 2 行选中第 3 个」） */
function slotsOfCells<T>(cells: readonly Cell<T>[]): readonly WindowSlot[] {
  return cells.map((cell): WindowSlot =>
    cell.kind === "row" ? { kind: "row" } : cell.kind === "group" ? { kind: "group" } : { kind: "note" },
  );
}

/** 弹窗那一档 ⇒ 内容区逐槽装什么（⚠️ **与 `layout/window-slots.js:slotsOf` 同序同长**） */
function slotsFor(spec: {
  readonly note?: string | null;
  readonly rows?: readonly WindowSlot[];
  /** 表单那一族的字段（`input` / `select`，恒排在说明**之前**） */
  readonly fields?: readonly ("input" | "select")[];
  /** 过滤框恒占第 0 槽（哪怕词是空串） */
  readonly filter?: boolean;
  /** 改名框恒排在**最后** */
  readonly rename?: boolean;
}): readonly WindowSlot[] {
  return [
    ...(spec.filter === true ? [{ kind: "input" as const }] : []),
    ...(spec.fields ?? []).map((kind): WindowSlot => ({ kind })),
    ...(spec.note === null || spec.note === undefined ? [] : [{ kind: "note" as const }]),
    ...(spec.rows ?? []),
    ...(spec.rename === true ? [{ kind: "input" as const }] : []),
  ];
}

/** 全部历史会话 → 分好组的逐格内容（**唯一的那个入口**，别处一律转调它） */
function groupOrder(records: readonly SessionRecord[], now: number): readonly Cell<SessionRecord>[] {
  const sorted = [...records].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
  const out: Cell<SessionRecord>[] = [];
  let header: string | null = null;
  for (const record of sorted) {
    const label = dayGroupLabel(record.updatedAt, now);
    if (label !== header) {
      out.push({ kind: "group", text: label });
      header = label;
    }
    out.push({ kind: "row", item: record });
  }
  return out;
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

/* ── 裁剪预算（⚠️ 一律取几何给的那一格：状态层不许算列宽） ──────────────────── */

/** 弹窗里右侧那枚「已在侧边栏上」的记号占几列（⚠️ **恒预留**：`pinned` 为假时那里是一个空格） */
const PINNED_MARK_COLUMNS = 2;

/** 弹窗里「这个会话连着哪台」那一截的裁剪预算（⚠️ 名字与它分那一行，不许各自吃掉整行） */
const HISTORY_MANAGER_COLUMNS = 14;

/** 模型那一族行首那枚 ★ / ✔ 占几列（⚠️ **恒预留**：勾没勾上与它无关） */
const MODEL_ROW_MARK_COLUMNS = 2;

/** 改名输入框里那串字的裁剪预算（⚠️ **让开提示符那几列**：几何给的那一格已经扣过一次，这里只兜宽度为 0 的那一档） */
function renameBudget(rect: Rect | null): number {
  return rect === null ? 0 : Math.max(0, rect.width - WINDOW_INPUT_PROMPT_COLUMNS);
}

/** `rects` 里第 `index` 那一格的宽度（装不下的那几格是 `null` ⇒ 预算 0 ⇒ 逐字裁空） */
function roomAt(rects: readonly Rect[], index: number, minus: number): number {
  const rect = rects[index];
  return rect === undefined ? 0 : Math.max(0, rect.width - minus);
}

/* ── 行模型装配（纯函数：⚠️ 呈现层一个字都不许自己裁、也不许自己拼） ──────────── */

function historyRows(
  cells: readonly Cell<SessionRecord>[],
  sidebar: ReadonlySet<string>,
  managerOf: (id: string) => string | null,
  pendingId: string | null,
  rowRects: readonly Rect[],
): readonly SessionListRow[] {
  const out: SessionListRow[] = [];
  let row = 0;
  for (const cell of cells) {
    // ⚠️ 分组标题行的 `id` / `name` 恒是空串而 `manager` 恒 `null`：它不对应任何会话，
    // 而一个非空 `id` 会让回查把它当成一个可选会话（几何那份槽位里并没有它那一槽）
    if (cell.kind === "group") {
      // ⚠️ **标题那一行的 `label` 就是标题本身**（呈现层按「第 i 槽」读同一份数组，而那一格画的是 `label`）
      out.push({ id: "", name: "", header: cell.text, pinned: false, manager: null, pending: false, label: cell.text });
      continue;
    }
    if (cell.kind === "note") continue;
    const record = cell.item;
    out.push({
      id: record.id,
      name: record.name,
      header: null,
      pinned: sidebar.has(record.id),
      manager: managerOf(record.id),
      pending: record.id === pendingId,
      label: ellipsis(record.name, roomAt(rowRects, row, PINNED_MARK_COLUMNS + HISTORY_MANAGER_COLUMNS)),
    });
    row += 1;
  }
  return out;
}

function targetRows(targets: readonly Target[], currentId: string | null, pendingId: string | null): readonly ListRow[] {
  return targets.map((one) => ({
    id: one.id,
    name: one.name,
    detail: `${one.baseUrl} · 超时 ${String(one.timeoutMs)}ms`,
    // ⚠️ 屏上那一行还有一个字形通道给连接状态，而控制面清单这一档**恒不画它**（它在这里是另一件事）
    state: null,
    current: one.id === currentId,
    pending: one.id === pendingId,
  }));
}

function userRows(accounts: readonly AccountBody[], pendingId: string | null): readonly ListRow[] {
  return accounts.map((one) => ({
    id: one.username,
    name: one.username,
    detail: `${accountQuota(one)} · ${one.disabled ? "停用" : "启用"}${one.password.set ? "" : " · 没密码"}`,
    state: null,
    // ⚠️ 账号这一档**没有「已生效的是哪一条」**：连不连得上问的是控制面，而那是 `/targets` 那一档的事
    current: false,
    pending: one.username === pendingId,
  }));
}

function providerRows(providers: readonly ProviderRecord[], currentId: string | null, pendingId: string | null): readonly ListRow[] {
  return providers.map((one) => ({
    id: one.id,
    name: one.name,
    detail: `${one.baseUrl} · ${one.api}`,
    state: null,
    current: one.id === currentId,
    pending: one.id === pendingId,
  }));
}

function checkRows(
  models: readonly ModelRecord[],
  providerId: string,
  picked: ReadonlySet<string>,
  pendingId: string | null,
  rects: readonly Rect[],
): readonly ModelCheckRow[] {
  return models.map((one, i) => {
    let ref = one.modelId;
    try {
      ref = joinModelRef(providerId, one.modelId);
    } catch {
      // ⚠️ `providerId` 含 `/` 是编程错误；那一行仍要画出来（不画就是「凭空少一个模型」）
    }
    return {
      id: ref,
      label: ellipsis(one.label, roomAt(rects, i, MODEL_ROW_MARK_COLUMNS)),
      checked: picked.has(one.modelId),
      pinned: one.pinned,
      pending: one.modelId === pendingId,
    };
  });
}

function modelRows(
  cells: readonly Cell<ModelChoice>[],
  rowRects: readonly Rect[],
): readonly ModelListRow[] {
  const out: ModelListRow[] = [];
  let row = 0;
  for (const cell of cells) {
    if (cell.kind === "group") {
      // ⚠️ **标题那一行的 `label` 就是标题本身**（与历史会话那两行同一份约定）
      out.push({ id: "", label: cell.text, header: cell.text, pinned: false });
      continue;
    }
    if (cell.kind === "note") continue;
    const one = cell.item;
    out.push({
      id: one.ref,
      label: ellipsis(one.label, roomAt(rowRects, row, MODEL_ROW_MARK_COLUMNS)),
      header: null,
      pinned: one.pinned,
    });
    row += 1;
  }
  return out;
}

/** 一个账号的流量上限那一截（⚠️ 缺省即「不限」，而那与服务端的 `0` 是同一件事） */
function accountQuota(account: AccountBody): string {
  const bytes = account.quota?.bytes ?? 0;
  return bytes === 0 ? "不限流量" : `上限 ${String(bytes)} 字节`;
}

/** 全部可选模型 → 按提供商分组（⚠️ **置顶的一组排在最前**，而 `★` 与排序是同一件事的两面） */
function modelCellsOf(
  choices: readonly ModelChoice[],
  pinnedRefs: readonly string[],
): readonly Cell<ModelChoice>[] {
  const pinned = new Set(pinnedRefs);
  const out: Cell<ModelChoice>[] = [];
  const stars = choices.filter((one) => pinned.has(one.ref));
  if (stars.length > 0) {
    out.push({ kind: "group", text: "置顶" });
    for (const one of stars) out.push({ kind: "row", item: one });
  }
  let header: string | null = null;
  for (const one of choices) {
    if (pinned.has(one.ref)) continue;
    if (one.provider !== header) {
      header = one.provider;
      out.push({ kind: "group", text: header });
    }
    out.push({ kind: "row", item: one });
  }
  return out;
}

/** 过滤框那个词筛掉哪几行（⚠️ **只影响显示**：`picked` 一个字节都不动） */
function filterModels(models: readonly ModelRecord[], word: string): readonly ModelRecord[] {
  const needle = word.trim().toLowerCase();
  if (needle === "") return models;
  return models.filter(
    (one) => one.label.toLowerCase().includes(needle) || one.modelId.toLowerCase().includes(needle),
  );
}

/** 一个模型选项（⚠️ **显示名与存储键分开**：前者能改，后者是协议标识） */
interface ModelChoice {
  /** 存储键 `<providerId>/<modelId>`（⚠️ 按**第一个** `/` 拼） */
  readonly ref: string;
  readonly providerId: string;
  readonly provider: string;
  readonly label: string;
  readonly pinned: boolean;
}

/* ── 表单：一段文本 + 一张字段表 ───────────────────────────────────────────── */

/** 表单里的一格（⚠️ `options` 有值 = 那是**下拉**（`↑↓` 换档），否则是文本框） */
interface FieldSpec {
  readonly label: string;
  readonly options?: readonly string[];
}

/** 正在编辑的那一份表单（⚠️ **五种共用一个窗口态**，而它住在状态层而不是 `@/store`） */
interface FormState {
  readonly kind: "provider" | "target" | "user" | "password" | "label";
  /** 被改的那一个（`null` = 新增）；⚠️ 它是**身份**而不是显示名 */
  readonly id: string | null;
  readonly title: string;
  readonly fields: readonly FieldSpec[];
  /** 逐格那一串（⚠️ **与 `fields` 同序同长**；凭据那一格恒为掩码或空串） */
  readonly values: readonly string[];
  /** 逐格的插入符（下标 = 第几格；⚠️ 与 `values` 同序同长） */
  readonly cursors: readonly number[];
  /** 焦点在第几格（⚠️ **恒恰好一格** —— `Tab` 与 `↑↓` 在字段之间走，靠的就是它） */
  readonly at: number;
  /** 校验没过时那一句（⚠️ **绝不转述用户输入**） */
  readonly note: string | null;
  /** 改哪一个账号的密码（`kind === "password"`） */
  readonly username: string;
  /** 改哪一个模型的显示名（`kind === "label"`；存储键） */
  readonly ref: string;
}

/** 账号那一格「启用」下拉的两档（⚠️ **下拉的档位是给人读的**，落库时换回布尔） */
const USER_ENABLED = ["启用", "停用"] as const;

/** 提供商表单的五格（⚠️ **顺序即屏上顺序**，而「第 i 格」在几何与命中测试里是同一个下标） */
const PROVIDER_FIELDS: readonly FieldSpec[] = [
  { label: "地址" },
  { label: "API 格式", options: MODEL_API_FORMATS },
  { label: "提供商 id" },
  { label: "提供商名称" },
  { label: "key" },
];

/** 控制面表单的四格（⚠️ `token` 那一格**永不回显真值**：留空 = 不改这一项） */
const TARGET_FIELDS: readonly FieldSpec[] = [
  { label: "名字" },
  { label: "地址" },
  { label: "token" },
  { label: "超时(ms)" },
];

/** 账号表单（⚠️ **新增那一份多一个密码格**：服务端 `POST /api/users` 的 `password` 是必填，改密码走 `Ctrl+P`） */
const USER_FIELDS: readonly FieldSpec[] = [
  { label: "用户名" },
  { label: "密码" },
  { label: "流量上限" },
  { label: "启用", options: USER_ENABLED },
];

/** 编辑已有账号时的字段表（⚠️ **用户名改不得** —— 它是那台机器上的身份，而密码走 `Ctrl+P`） */
const USER_EDIT_FIELDS: readonly FieldSpec[] = [
  { label: "用户名" },
  { label: "流量上限" },
  { label: "启用", options: USER_ENABLED },
];

const LABEL_FIELDS: readonly FieldSpec[] = [{ label: "显示名" }];
const PASSWORD_FIELDS: readonly FieldSpec[] = [{ label: "新密码" }];

/** 起手那一份逐格插入符（⚠️ **逐格落在那一串的末尾** —— 从清单回填进来的字已经在那儿，
 *  而光标停在行首的话第一个敲进去的字会插到它前面） */
function cursorsOf(values: readonly string[]): readonly number[] {
  return values.map((one) => one.length);
}

/** 换掉表单里第 `at` 那一格 + 它的插入符（⚠️ **数组换算是逐格的**：两格各换一次而有一格换了另一个下标就会串） */
function withValue(form: FormState, at: number, text: string, cursor: number): FormState {
  const values = [...form.values];
  const cursors = [...form.cursors];
  values[at] = text;
  cursors[at] = cursor;
  return { ...form, values, cursors, note: null };
}

function withCursor(form: FormState, at: number, cursor: number): FormState {
  const cursors = [...form.cursors];
  cursors[at] = cursor;
  return { ...form, cursors, note: null };
}

/** 下拉那一格换一档（⚠️ **走到两端就停住**，而档位环不是闭合的：换档不是「切行」） */
function withSelect(form: FormState, step: 1 | -1): FormState {
  const options = form.fields[form.at]?.options;
  if (options === undefined || options.length === 0) return form;
  const now = options.indexOf(form.values[form.at] ?? "");
  const next = Math.max(0, Math.min(options.length - 1, (now < 0 ? 0 : now) + step));
  return withValue(form, form.at, options[next] ?? "", (options[next] ?? "").length);
}

/* ── 其它文案与判据 ────────────────────────────────────────────────────────── */

/** 弹窗里一个**没有历史会话**时的那一句（⚠️ 一句人话而不是空串：空串与「有会话而它们装不下」在屏上一样） */
const NO_HISTORY_NOTE = "台账里一个历史会话都没有 · 用 /new 开一个，它会自动进侧边栏";

/** 账号那一族**没有选中控制面**时的那一句（⚠️ 它与「这台真没有账号」在屏上必须分得开） */
const NO_TARGET_NOTE = "还没选中控制面 · 先在 /targets 里给当前会话选一台，否则账号表无从读起";

/** `/batch` 的那些名字一个都不在台账里（⚠️ **不是空跑**：说清楚「你说给谁听」这件事没成立） */
const BATCH_NO_TARGET = "台账里没有这些控制面 —— /targets 看有哪些，或 /batch all 发给全部";

/** `/exit` 撞上在飞的东西时的那一句（⚠️ 说「跑完再退」而不是静默不响应 —— 静默与「没生效」在屏上一样） */
const EXIT_BUSY = "还有命令在跑，跑完再退";

/** 一次台账写失败 → 说明行上那一句（⚠️ **`LedgerError` 的文案一个字都不描述用户敲的东西**，而传输层的失败只说形状） */
function ledgerFailure(err: unknown): string {
  if (err instanceof LedgerError) return `台账没接受这一份：${err.message}`;
  return "这一份的形状不对（地址要像 http://主机:端口，超时要落在一个区间里）";
}

/** 名字 → 台账里那个 `id`（⚠️ **新增那一支**才发号，而编辑那一支认的是传进来的那个 `id`） */
function idForName(targets: readonly Target[], name: string): string {
  return idFor(name, targets.map((one) => one.id));
}

/** 历史会话弹窗的标题（⚠️ **台数放在标题里**而不是每一行：那一行还有名字与两个记号） */
function historyTitle(count: number): string {
  return `历史会话（${String(count)}）`;
}

function listTitle(what: string, count: number): string {
  return `${what}（${String(count)}）`;
}

/** 清单那一族：窗态的收窄（⚠️ 判据是 `kind` 本身而不是「窗口开着」 —— 两处各判一次就会有一族少一个分支） */
// ⚠️ **五种表单不在这一族里**：它们的字段表从五格到一格不等，窗态那一个变体表达不了 ⇒ 它们住局部
// `FormState`，而 `modal` 此刻是表单**底下**那一档清单（表单盖在清单上，不是平级的两个窗口）。
type ListState = Extract<
  WindowState,
  { readonly kind: "targets" | "users" | "providers" | "provider-models" | "models" }
>;

function asList(state: WindowState | null): ListState | null {
  return state !== null && state.kind !== "sessions" ? state : null;
}

/** 当前会话那个模型键落在哪个提供商（⚠️ **`null` = 没选模型，而悬空的键也当没选**） */
function providerIdOf(ref: string | null | undefined): string | null {
  if (ref === null || ref === undefined) return null;
  return splitModelRef(ref)?.providerId ?? null;
}

/** 一个会话桶（⚠️ **零会话那一档**：桶是空的，于是结果区画引导屏那块标记） */
const NO_BUCKET: Bucket = emptyBucket();

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

  /** 侧边栏上的会话（⚠️ **起手有起步那一个**，而零会话是合法的） */
  const [sessions, setSessions] = useState<readonly Session[]>(() => [
    newSession(SEED_SESSION.id, SEED_SESSION.name),
  ]);
  /** 当前是哪个会话（⚠️ **`null` 是合法状态**：一个会话都没有时「当前会话」不存在） */
  const [activeId, setActiveId] = useState<string | null>(SEED_SESSION.id);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [ledgerError, setLedgerError] = useState<LedgerError | null>(null);
  const [ledgerTick, setLedgerTick] = useState(0);
  const [probes, setProbes] = useState<ReadonlyMap<string, ProbeSlot>>(() => new Map<string, ProbeSlot>());
  const [message, setMessage] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  /** 弹窗此刻是什么（⚠️ **判别联合**：一个窗口一次只开一种内容） */
  const [modal, setModal] = useState<WindowState | null>(null);
  /** 正在编辑的那份表单（⚠️ `Esc` 从它回**上一层**清单，而那一层记在 `behind`） */
  const [form, setForm] = useState<FormState | null>(null);
  /** 开表单之前那一档清单（⚠️ 表单是**盖在**清单上的一层，不是一个平级窗口） */
  const [behind, setBehind] = useState<WindowState | null>(null);
  /** `sessions` 那一档的高亮（⚠️ **窗态那一档没有 `at`** —— 它的可选项就是整份清单，故下标住在状态层） */
  const [historyAt, setHistoryAt] = useState(0);
  /** 过滤框的插入符（⚠️ 窗态那一档只有 `filter` 那一串字，插入符没有第二格可住） */
  const [filterCursor, setFilterCursor] = useState(0);
  /** 拉取失败那一句（⚠️ 它是**呈现**的一部分，而窗态那一档只有 `picked` 与 `busy`） */
  const [modelsNote, setModelsNote] = useState<string | null>(null);
  const [historyRecords, setHistoryRecords] = useState<readonly SessionRecord[]>([]);
  const [sidebarIds, setSidebarIds] = useState<ReadonlySet<string>>(() => new Set());
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_WIDTH);
  const [sessionsTop, setSessionsTop] = useState(0);
  // ⚠️ **框里的文本不写进会话的 `input`** —— 取消之后那个输入行必须还是取消之前那一串
  const [rename, setRename] = useState<{ readonly id: string; readonly text: string; readonly cursor: number } | null>(null);
  const [menu, setMenu] = useState<{
    readonly sessionId: string | null;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const [menuAt, setMenuAt] = useState(0);
  /** 提供商清单（⚠️ 落盘的那一份是 `ProviderRecord`；**真凭据只在这一处内存里**） */
  const [providers, setProviders] = useState<readonly ProviderRecord[]>([]);
  /** `provider-models` 那一档**正在编辑**的那份模型清单（⚠️ 与 `picked` 分开：勾选是它的子集） */
  const [providerModels, setProviderModels] = useState<readonly ModelRecord[]>([]);
  const [accounts, setAccounts] = useState<readonly AccountBody[]>([]);
  const [accountsNote, setAccountsNote] = useState<string | null>(null);
  /** 输入历史（⚠️ **跨会话共享**的一份，且**提交时才入** —— 判据是「提交过的那几行」） */
  const [history, setHistory] = useState<readonly string[]>([]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [sessionCloseHot, setSessionCloseHot] = useState(false);
  const [handleHot, setHandleHot] = useState(false);
  /** 模型清单的版本号（⚠️ 模型清单落在**每个提供商自己那张表**里，没有「全部」那一个写入口 ⇒ 改完要显式抬一次） */
  const [modelTick, setModelTick] = useState(0);

  /* 这些 ref 的唯一理由：异步回调要读到「下一次渲染的视角」 */

  /** 内存里那份会话清单（⚠️ 与 `useState` 初值是同一个对象，否则首帧读到空清单） */
  const sessionsRef = useRef<readonly Session[]>(sessions);
  const ledgerRef = useRef<Ledger | null>(null);
  const probeSeq = useRef(new Map<string, number>());
  const queueRef = useRef<Job[]>([]);
  const busyRef = useRef(false);
  const pumpRef = useRef<() => void>(() => {});
  const applyEffectRef = useRef<(sessionId: string, effect: Effect) => void>(() => {});
  const viewportRef = useRef({ width: 0, rows: 0 });
  const sessionRowsRef = useRef(1);
  const sessionSeq = useRef(1);
  const [chatting, setChatting] = useState(false);
  const seededRef = useRef(false);
  const restoredRef = useRef(false);
  const loadedMessagesRef = useRef(new Set<string>());
  const entriesRef = useRef(new Map<string, readonly LogEntry[]>());
  const resizingRef = useRef<ResizeStart | null>(null);
  /** 账号清单的**执行层读面**（⚠️ `depsFor` 的依赖表里不许有它，故要一份在 `setState` 之外的镜像） */
  const accountsRef = useRef<readonly AccountBody[]>([]);
  /** 输入历史里正停在第几条（⚠️ **`-1` = 不在历史里**；它是一次性游标，故住在 ref 而不是 state） */
  const historyAtRef = useRef(-1);
  /** 正在拖出选区吗（⚠️ **一次 `down` 之后 `drag` 才知道自己在拖框**，而 `up` 收掉它） */
  const textDragRef = useRef(false);

  /* ── 写入口 ──────────────────────────────────────────────────────────────── */

  /** 会话清单**唯一**的写入口（`state` 与 {@link sessionsRef} 在这里一起落） */
  const holdSessions = useCallback((next: SetStateAction<readonly Session[]>): void => {
    const value =
      typeof next === "function"
        ? (next as (prev: readonly Session[]) => readonly Session[])(sessionsRef.current)
        : next;
    sessionsRef.current = value;
    setSessions(value);
  }, []);

  const holdLedger = useCallback((next: Ledger | null): void => {
    ledgerRef.current = next;
    setLedger(next);
  }, []);

  const holdAccounts = useCallback((next: readonly AccountBody[]): void => {
    accountsRef.current = next;
    setAccounts(next);
  }, []);

  const closeMenu = useCallback((): void => setMenu(null), []);

  /** 收掉模态窗口（⚠️ **表单与改名框一起收掉**：留着它的话「关窗」之后那两层还在，而它们的宿主就是那个弹窗） */
  const closeModal = useCallback((): void => {
    setModal(null);
    setForm(null);
    setBehind(null);
    setRename(null);
    setModelsNote(null);
  }, []);

  /** 换台账之后**现读**提供商清单（⚠️ **不抛**：读不出来时那一档弹窗给一句人话，而不是整个界面起不来） */
  const refreshProviders = useCallback((): void => {
    try {
      setProviders(readProviders(ledgerFile));
    } catch {
      setProviders([]);
    }
  }, [ledgerFile]);

  /** 抬一次模型清单的版本号（⚠️ 改完之后**必须**抬：那是那份清单唯一的重读信号） */
  const bumpModels = useCallback((): void => setModelTick((tick) => tick + 1), []);

  /* ── 读盘那一半 ──────────────────────────────────────────────────────────── */

  useEffect(() => {
    try {
      holdLedger(readLedger(ledgerFile));
      setLedgerError(null);
    } catch (err) {
      // ⚠️ 读失败**不碰**内存里那份：当成空台账，下一次写就会覆盖掉存着凭据的那份
      setLedgerError(err instanceof LedgerError ? err : new LedgerError("unreadable", "台账读不出来"));
    }
    refreshProviders();
  }, [ledgerFile, ledgerTick, holdLedger, refreshProviders]);

  // ⚠️ **启动恢复只此一次，且不等台账**：它在第一个 effect 趟里跑完，于是后面那支播种看到的必然是恢复之后那份清单
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
      holdSessions([newSession(SEED_SESSION.id, SEED_SESSION.name)]);
      setActiveId(SEED_SESSION.id);
      return;
    }
    setHistoryRecords(records);
    setSidebarIds(new Set(sidebar.map((one) => one.sessionId)));
    // ⚠️ **先抬序号再谈别的**：不抬的话 `/new` 会插一个库里已有的 `id`，症状是屏上多一项而库里没多
    sessionSeq.current = sessionSeqOf(records);
    if (records.length === 0) {
      const now = Date.now();
      try {
        saveSession(ledgerFile, { id: SEED_SESSION.id, name: SEED_SESSION.name, createdAt: now, updatedAt: now });
        // ⚠️ 起步那一个**同时**激活进侧边栏：侧边栏清单是另一张表，而「起手就有那一行」是那条不变量的另一半
        pinSession(ledgerFile, SEED_SESSION.id, now);
      } catch (err) {
        setMessage(`起步会话没存进台账（${describe(err)}）—— 关掉就没了`);
      }
    }
    // ⚠️ **清单那一列与「当前是哪一个」是两份答案**：前者按激活序，而当前那一个由侧边栏清单答 ——
    // 不在清单上的会话（被移出过）不该一恢复就变成当前那一个。
    // ⚠️ 会话选的模型与推理强度**单独一查**（不在会话的身份那几列里），故读回来时现填
    const restored = restoredSessions(sidebarRecords(records, sidebar)).map((one) => {
      try {
        const picked = readSessionModels(ledgerFile, one.id);
        return { ...one, modelRef: picked.modelRef, reasoning: picked.reasoning };
      } catch {
        return one;
      }
    });
    holdSessions(restored);
    setActiveId(sidebar[0]?.sessionId ?? records[0]?.id ?? SEED_SESSION.id);
  }, [ledgerFile, holdSessions]);

  /* ── 推导 ────────────────────────────────────────────────────────────────── */

  const targets: readonly Target[] = useMemo(() => ledger?.targets ?? [], [ledger]);

  /** 当前会话（⚠️ **`null` 是合法状态**：一个会话都没有时「当前会话」不存在，于是那一族回调全部 no-op） */
  const active: Session | null = useMemo(
    () => sessions.find((one) => one.id === activeId) ?? null,
    [sessions, activeId],
  );
  const activeInput = active?.input ?? "";
  const activeCursor = active?.cursor ?? 0;
  const activeAnchor = active?.anchor ?? null;
  const bucket: Bucket = active?.bucket ?? NO_BUCKET;
  /** 当前会话连的是哪个控制面（`null` = 还没选，或根本没有当前会话） */
  const current: Target | null = useMemo(
    () => targets.find((one) => one.id === active?.targetId) ?? null,
    [targets, active?.targetId],
  );

  /** 台账读出来之后给第一个会话播种一次；⚠️ 只播种一次（`seededRef`） */
  useEffect(() => {
    if (seededRef.current || ledger === null) return;
    seededRef.current = true;
    const seed = selectedTarget(ledger);
    if (seed === null) return;
    holdSessions((prev) =>
      prev.map((one, i) => (i === 0 && one.targetId === null ? { ...one, targetId: seed.id } : one)),
    );
  }, [ledger, holdSessions]);

  /** 切到某一个会话 ⇒ 它「看过了」（⚠️ **不清 `run`**：跑没跑完与看没看过是两件事） */
  useEffect(() => {
    if (activeId === null) return;
    holdSessions((prev) => prev.map((one) => (one.id === activeId && !one.seen ? { ...one, seen: true } : one)));
  }, [activeId, holdSessions]);

  /* ── 桶 ──────────────────────────────────────────────────────────────────── */

  /** 每个会话桶里**落盘那一侧**的格子（⚠️ `push` 的发号依据：同一帧两次追加会算出同一个 `seq`） */
  const push = useCallback(
    (sessionId: string, turns: readonly Turn[], at: number): void => {
      if (turns.length === 0) return;
      const viewport = viewportRef.current;
      // ⚠️ `before` 取自 {@link entriesRef} 而不是 `sessions`：后者是**上一帧**那一份
      const before = entriesRef.current.get(sessionId) ?? [];
      const added = append(before, turns, at);
      const fresh = added.slice(before.length);
      let entries: readonly LogEntry[];
      try {
        appendMessages(ledgerFile, sessionId, fresh);
        entries = trim(added, LOG_KEEP);
        if (entries.length < added.length && entries[0] !== undefined) {
          trimMessages(ledgerFile, sessionId, entries[0].id);
        }
      } catch (err) {
        // ⚠️ 失败不回滚（那些格子确实发生过），而那一句**追加进同一个桶**
        const failure = `这几格对话没存进台账（${describe(err)}）—— 关掉就没了`;
        entries = trim(append(added, [{ kind: "notice", rows: [{ kind: "note", text: failure }] }], at), LOG_KEEP);
        setMessage(failure);
      }
      entriesRef.current.set(sessionId, entries);
      holdSessions((prev) =>
        prev.map((one) => {
          if (one.id !== sessionId) return one;
          const height = flatten(entries, viewport.width).height;
          const bottom = clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
          const top = one.bucket.follow ? bottom : clampTop(height, viewport.rows, one.bucket.top);
          return { ...one, bucket: { entries, top, follow: one.bucket.follow } };
        }),
      );
    },
    [ledgerFile, holdSessions],
  );

  /** 一条话之外的那一句；⚠️ 走 `notice` 那一档而不是 `error`：「拒绝」不是故障 */
  const sayIn = useCallback(
    (sessionId: string | null, text: string): void => {
      setMessage(text);
      if (sessionId === null) return;
      push(sessionId, [{ kind: "notice", rows: [{ kind: "note", text }] }], Date.now());
    },
    [push],
  );

  const say = useCallback(
    (text: string): void => {
      setMessage(text);
      if (activeId === null) return;
      push(activeId, [{ kind: "notice", rows: [{ kind: "note", text }] }], Date.now());
    },
    [push, activeId],
  );

  // ⚠️ 计时器**跟着消息走**（依赖是 `message` 本身）
  useEffect(() => {
    if (message === null) return;
    const timer = setTimeout(() => setMessage(null), MESSAGE_TTL_MS);
    return () => clearTimeout(timer);
  }, [message]);

  const scrollBy = useCallback(
    (delta: number): void => {
      const viewport = viewportRef.current;
      holdSessions((prev) =>
        prev.map((one) => {
          if (one.id !== activeId) return one;
          const height = flatten(one.bucket.entries, viewport.width).height;
          const top = clampTop(height, viewport.rows, one.bucket.top + delta);
          const bottom = clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
          return { ...one, bucket: { ...one.bucket, top, follow: top >= bottom } };
        }),
      );
    },
    [activeId, holdSessions],
  );

  const scrollTo = useCallback(
    (where: "top" | "bottom"): void => {
      const viewport = viewportRef.current;
      holdSessions((prev) =>
        prev.map((one) => {
          if (one.id !== activeId) return one;
          const height = flatten(one.bucket.entries, viewport.width).height;
          const top = where === "top" ? 0 : clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
          return { ...one, bucket: { ...one.bucket, top, follow: where === "bottom" } };
        }),
      );
    },
    [activeId, holdSessions],
  );

  /** 探**任意一个**控制面一次（探活的唯一发起方） */
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
  }, [current?.id, reprobe]);

  /** 把一个会话的对话从 `messages` 表读回来灌进它的桶（⚠️ 每个会话只读一次） */
  const loadMessages = useCallback(
    (sessionId: string): void => {
      if (loadedMessagesRef.current.has(sessionId)) return;
      loadedMessagesRef.current.add(sessionId);
      let restored: readonly LogEntry[];
      try {
        restored = readMessages(ledgerFile, sessionId);
      } catch (err) {
        const failure = `这个会话的对话读不出来（${describe(err)}）—— 这一趟它显示为空`;
        setMessage(failure);
        holdSessions((prev) =>
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
      entriesRef.current.set(sessionId, restored);
      const viewport = viewportRef.current;
      holdSessions((prev) =>
        prev.map((one) => {
          if (one.id !== sessionId) return one;
          const height = flatten(restored, viewport.width).height;
          const top = clampTop(height, viewport.rows, Number.POSITIVE_INFINITY);
          return { ...one, bucket: { entries: restored, top, follow: true } };
        }),
      );
    },
    [ledgerFile, holdSessions],
  );

  useEffect(() => {
    if (activeId === null) return;
    loadMessages(activeId);
  }, [activeId, loadMessages]);

  /* ── 会话生命周期 ────────────────────────────────────────────────────────── */

  const switchSession = useCallback((id: string): void => {
    setActiveId((before) => (before === id ? before : id));
  }, []);

  /** 把第 `index` 项带进可见窗口（⚠️ 已经在窗口里就一个字节都不改） */
  const revealSession = useCallback((index: number): void => {
    const fit = Math.max(1, sessionRowsRef.current);
    setSessionsTop((before) => (index >= before && index < before + fit ? before : index));
  }, []);

  /** 造一个新会话并切过去（**唯一**发号处；⚠️ **同步返回那个新 `id`**） */
  const spawnOne = useCallback((): string => {
    const at = sessionsRef.current.length;
    sessionSeq.current += 1;
    const id = `s${String(sessionSeq.current)}`;
    const name = `会话 ${String(sessionSeq.current)}`;
    // ⚠️ 从 `null` 开始连（继承当前那个的话「/new 之后还在操作同一台机器」屏上看不出来）
    holdSessions((prev) => [...prev, newSession(id, name)]);
    setActiveId(id);
    revealSession(at);
    const now = Date.now();
    try {
      saveSession(ledgerFile, { id, name, createdAt: now, updatedAt: now });
      // ⚠️ **新会话立刻进侧边栏**（它就在屏上，不进侧边栏等于「有一个会话屏上却看不到」）
      pinSession(ledgerFile, id, now);
      setSidebarIds((before) => new Set(before).add(id));
    } catch (err) {
      // ⚠️ 这一句**落在新会话自己的桶里**：这一刻 `setActiveId` 已经排进队列，
      // 而闭包里的 `activeId` 还是**上一个** —— 说进上一个的桶等于「新建失败」出现在别人的会话里
      const failure = `这个新会话没存进台账（${describe(err)}）—— 关掉就没了`;
      setMessage(failure);
      push(id, [{ kind: "notice", rows: [{ kind: "note", text: failure }] }], now);
    }
    return id;
  }, [ledgerFile, revealSession, holdSessions, push]);

  /** 「当前会话」，**没有就当场造一个**（⚠️ 判据是「屏上有没有一个会话」而不是「id 能不能对上」） */
  const ensureSession = useCallback((): string => {
    const found = sessionsRef.current.find((one) => one.id === activeId);
    return found === undefined ? spawnOne() : found.id;
  }, [activeId, spawnOne]);

  /** 把某一个会话从侧边栏上移出（⚠️ 「✕」/`Ctrl+X`/菜单那一项同一个入口，且**不是**「删掉」） */
  const unpinFromSidebar = useCallback(
    (id: string): void => {
      const list = sessionsRef.current;
      const at = list.findIndex((one) => one.id === id);
      if (at < 0) return;
      const rest = list.filter((one) => one.id !== id);
      holdSessions(rest);
      try {
        unpinSession(ledgerFile, id);
        setSidebarIds((before) => {
          const next = new Set(before);
          next.delete(id);
          return next;
        });
      } catch (err) {
        say(`这个会话没从侧边栏上移掉（${describe(err)}）—— 重开一次它还在那儿`);
      }
      if (activeId !== id) {
        setSessionsTop((before) => Math.max(0, before - (at < before ? 1 : 0)));
        return;
      }
      // ⚠️ **移出不是删除**：它还在 `/sessions` 弹窗里，而「当前会话」落到清单里剩下的那一个 ——
      // 一个都不剩时**没有当前会话**（不是凭空造一个）
      const picked = rest[Math.max(0, at - 1)] ?? rest[0];
      setActiveId(picked?.id ?? null);
      if (picked !== undefined) revealSession(Math.max(0, at - 1));
    },
    [activeId, ledgerFile, say, revealSession, holdSessions],
  );

  /** 激活某一个历史会话（弹窗里 `Enter` 或**点那一行**） */
  const activateSession = useCallback(
    (id: string): void => {
      const known = sessionsRef.current.some((one) => one.id === id);
      const at = known ? sessionsRef.current.findIndex((one) => one.id === id) : sessionsRef.current.length;
      if (!known) {
        const name = historyRecords.find((one) => one.id === id)?.name ?? `会话 ${id}`;
        holdSessions((prev) => [...prev, newSession(id, name)]);
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
    [historyRecords, ledgerFile, say, revealSession, closeModal, holdSessions],
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
    holdSessions((prev) => prev.map((one) => (one.id === id ? { ...one, name } : one)));
    setHistoryRecords((prev) => prev.map((one) => (one.id === id ? { ...one, name, updatedAt: Date.now() } : one)));
    try {
      renameSession(ledgerFile, id, name, Date.now());
    } catch (err) {
      say(`这次改名没存进台账（${describe(err)}）—— 关掉就没了`);
    }
  }, [rename, sessions, ledgerFile, say, holdSessions]);

  const cancelRename = useCallback((): void => setRename(null), []);

  /* ── 侧边栏那一列：点选 / 滚动 / 菜单 / 切会话 ────────────────────────────── */

  const scrollSessions = useCallback((step: number): void => {
    setSessionsTop((before) => Math.max(0, before + step));
  }, []);

  /** 下一个 / 上一个会话（`Ctrl+↑↓` / `Ctrl+N` `Ctrl+P`；**没有就什么都不做**） */
  const stepSession = useCallback(
    (step: 1 | -1): void => {
      const list = sessionsRef.current;
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
      holdSessions((prev) => prev.map((one) => (one.id === sessionId ? { ...one, targetId } : one)));
      let failure: string | null = null;
      try {
        writeLedger(ledgerFile, setSelected(readLedger(ledgerFile), targetId));
      } catch (err) {
        failure = describe(err);
      }
      holdLedger(readLedgerSafe(ledgerFile));
      setLedgerTick((tick) => tick + 1);
      if (failure !== null) {
        sayIn(sessionId, `这次切换没存进台账（${failure}）—— 界面上已经切过去了，关掉就没了`);
      }
    },
    [ledgerFile, holdLedger, sayIn, holdSessions],
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
      holdSessions((prev) => prev.map((one) => (one.id === sessionId ? { ...one, modelRef: ref, reasoning } : one)));
      try {
        writeSessionModel(ledgerFile, sessionId, ref, reasoning);
      } catch (err) {
        sayIn(sessionId, `这次的模型选择没存进台账（${describe(err)}）—— 关掉就没了`);
      }
    },
    [ledgerFile, holdSessions, sayIn],
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
      holdAccounts([]);
      setAccountsNote(NO_TARGET_NOTE);
      return;
    }
    void clientFor(current)
      .users()
      .then((body) => {
        // ⚠️ **按 username 升序**：同一份数据两次渲染出同一个顺序，两条路才对照着看
        holdAccounts([...body.accounts].sort((a, b) => (a.username < b.username ? -1 : 1)));
        setAccountsNote(null);
      })
      .catch((err: unknown) => {
        holdAccounts([]);
        setAccountsNote(`账号清单读不出来（${describe(err)}）`);
      });
  }, [current, holdAccounts]);

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
      loadedMessagesRef.current.delete(id);
      entriesRef.current.delete(id);
      const at = sessionsRef.current.findIndex((one) => one.id === id);
      if (at >= 0) {
        const rest = sessionsRef.current.filter((one) => one.id !== id);
        holdSessions(rest);
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
      holdLedger(readLedgerSafe(ledgerFile));
      setLedgerTick((tick) => tick + 1);
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
      void clientFor(current)
        .deleteAccount(picked.username)
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
    holdSessions,
    holdLedger,
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
      holdLedger(readLedgerSafe(ledgerFile));
      setLedgerTick((tick) => tick + 1);
      closeFormTo({ kind: "targets", at: Math.max(0, targets.findIndex((one) => one.id === wantedId)) });
    },
    [ledgerFile, targets, holdLedger, closeFormTo],
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
      const client = clientFor(current);
      const disabled = enabled === USER_ENABLED[1];
      const done = (message: string): void => {
        closeFormTo({ kind: "users", at: 0 });
        loadAccounts();
        sayIn(activeId, message);
      };
      void (editing
        ? client.updateAccount(username, { quotaBytes, disabled })
        : client.createAccount({ username, password, quotaBytes, disabled })
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
      void clientFor(current)
        .updateAccount(draft.username, { password })
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


  /* ── 三个写入口（键位与鼠标共用，⚠️ 按「此刻聚焦的是哪个框」分流） ─────────── */

  /** 过滤框此刻装的那一串（⚠️ **`null` = 那一档没开**，而空串是「开着、词是空的」—— 两者屏上分得开） */
  const filterText: string | null = useMemo((): string | null => {
    const list = asList(modal);
    return list !== null && list.kind === "provider-models" ? list.filter : null;
  }, [modal]);

  /** 此刻聚焦的是哪个框（⚠️ **`null` = 没有聚焦的框**，于是键位不必自己猜） */
  // ⚠️ **过滤框也答得出「是哪个框」**：那一档只有它收键，答成「没有框」的话键位分派拿它当
  // 清单那一族，而打印键落在那一族的空操作上 ⇒ 过滤框一个字都敲不进去而屏上零解释。
  const textTarget =
    form !== null ? form.kind : rename !== null ? "rename" : filterText !== null ? "filter" : null;

  /** 那个框此刻装的那一串（⚠️ 鼠标落插入符要按它回查显示列，故它也得答「是哪一个框」） */
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
      const sessionId = sessionsRef.current.some((one) => one.id === activeId) ? activeId : spawnOne();
      // ⚠️ **锚点是那一改的第三格**：不带它的话退格与提交就不知道要吃掉整段选区
      holdSessions((prev) =>
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
    [form, rename, activeId, holdSessions, spawnOne],
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
      holdSessions((prev) =>
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
    [form, rename, activeId, holdSessions],
  );

  /** 写死的那一改（补全已算好的结果 / `Esc` 清行 / 鼠标落插入符 / 拖选） */
  const fillActive = useCallback<FillActive>(
    (patch) => {
      historyAtRef.current = -1;
      holdSessions((prev) => prev.map((one) => (one.id === activeId ? { ...one, ...patch } : one)));
    },
    [activeId, holdSessions],
  );

  /** 从命令历史里填一行（⚠️ **与 `fillActive` 分开**：它还得记下「正停在第几条」） */
  const fillHistory = useCallback(
    (step: HistoryStep): void => {
      historyAtRef.current = step.at;
      holdSessions((prev) =>
        prev.map((one) =>
          one.id === activeId ? { ...one, input: step.line, cursor: step.cursor, anchor: null } : one,
        ),
      );
    },
    [activeId, holdSessions],
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
    [modal, filterCursor],
  );

  /** 点弹窗里那个文本框 → 落插入符（⚠️ 单击**清空选区**，而拖动才形成它） */
  const textDown = useCallback(
    (at: number): void => {
      textDragRef.current = true;
      if (form !== null) {
        setForm(withCursor(form, form.at, Math.min(at, (form.values[form.at] ?? "").length)));
        return;
      }
      if (rename !== null) {
        const clamped = Math.min(at, rename.text.length);
        setRename({ id: rename.id, text: rename.text, cursor: clamped });
        return;
      }
      // ⚠️ **过滤框不是会话的输入行**：漏掉这一支的话「点一下过滤框」会去改会话那一行
      if (filterText !== null) {
        setFilterCursor(Math.min(at, filterText.length));
        return;
      }
      holdSessions((prev) =>
        prev.map((one) =>
          one.id === activeId ? { ...one, cursor: Math.min(at, one.input.length), anchor: null } : one,
        ),
      );
    },
    [form, rename, filterText, activeId, holdSessions],
  );

  /** 拖出选区（⚠️ **锚点落在按下的那一格** —— 抬起之后选区留着，单击则清空） */
  const textDrag = useCallback(
    (at: number): void => {
      if (!textDragRef.current) return;
      if (form !== null) {
        setForm(withCursor(form, form.at, Math.min(at, (form.values[form.at] ?? "").length)));
        return;
      }
      if (rename !== null) {
        textDown(at);
        return;
      }
      // ⚠️ 过滤框**只有一个插入符**（与改名框同一形状）：拖动落的就是它，而拖不出选区
      if (filterText !== null) {
        textDown(at);
        return;
      }
      holdSessions((prev) =>
        prev.map((one) => {
          if (one.id !== activeId) return one;
          // ⚠️ **还没有锚点就把锚点定在原地**：那一下是拖动的起手，不是一个新的单击
          const anchor = one.anchor ?? one.cursor;
          return { ...one, cursor: Math.min(at, one.input.length), anchor };
        }),
      );
    },
    [form, rename, filterText, textDown, activeId, holdSessions],
  );

  /** 抬手：选区留着，而下一次单击会清掉它 */
  const textUp = useCallback((): void => {
    textDragRef.current = false;
  }, []);

  /** 点表单里**第 `slot` 那一格** → 把焦点挪过去（⚠️ 「点哪一格就在哪一格敲」是这一族的直觉） */
  const focusFormField = useCallback(
    (slot: number): void => {
      if (form === null) return;
      setForm({ ...form, at: Math.max(0, Math.min(form.fields.length - 1, slot)), note: null });
    },
    [form],
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

  /* ── 执行层 ──────────────────────────────────────────────────────────────── */

  const depsFor = useCallback(
    (job: Job): ExecDeps => ({
      client: current === null ? null : clientFor(current),
      width: viewportRef.current.width,
      line: job.line,
      // ⚠️ **两份清单都是注入进来的**：执行层不读台账，而 `/accounts` 与 `/targets` 弹窗画的是同一份
      accounts: () => ({ accounts: accountsRef.current }),
      targetsView: () => (ledgerRef.current?.targets ?? []).map((one) => redactTarget(one)),
      // ⚠️ `/batch` 的「名字 → 客户端」在**这里**解：执行层不读台账（理由见 `ExecDeps.peers`）
      peers: (names) => peersOf(names, ledgerRef.current),
    }),
    [current],
  );

  /** `/batch` 的那些名字 → 目标（⚠️ `all` 在这里对着台账展开，而**顺序恒等于台账顺序**） */
  function peersOf(names: readonly string[], book: Ledger | null): readonly BatchPeer[] {
    const all = book?.targets ?? [];
    if (names.length === 1 && names[0] === ALL_TARGETS) {
      return all.map((one) => ({ name: one.name, client: clientFor(one) }));
    }
    // ⚠️ **按台账顺序**而不是按命令里写的顺序：结果区的排序恒等于台账那一列
    return all
      .filter((one) => names.includes(one.name))
      .map((one) => ({ name: one.name, client: clientFor(one) }));
  }

  /** 「三台里两台成功」那一句（⚠️ **逐台数**而不是只说「完成」—— 少一句就等于让操作者自己数） */
  function summaryOf(reports: readonly BatchReport[]): LogRow {
    const ok = reports.filter((one) => one.ok).length;
    const bad = reports.length - ok;
    const tally = bad === 0 ? `${String(ok)} 台全部成功` : `${String(ok)} 台成功 · ${String(bad)} 台失败`;
    return { kind: bad === 0 ? "note" : "err", text: `/batch ${tally}（共 ${String(reports.length)} 台）` };
  }

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
          turns.push(report.ok ? { kind: "tool-result", rows: report.rows } : { kind: "error", rows: report.rows });
        }
        turns.push({ kind: "notice", rows: [summaryOf(reports)] });
        push(sessionId, turns, Date.now());
        for (const one of effects) applyEffectRef.current(sessionId, one);
      });
    },
    [depsFor, push],
  );

  /** 一条命令的**副作用**。⚠️ **穷举**而不是「取第一条」：多一个 `Effect` 种类时这一支会编译期红 */
  const applyEffect = useCallback(
    (sessionId: string, effect: Effect): void => {
      switch (effect.kind) {
        case "clear-log":
          holdSessions((prev) =>
            prev.map((one) => (one.id === sessionId ? { ...one, bucket: emptyBucket() } : one)),
          );
          // ⚠️ **盘上那一份也得空**（`messages` 表按 `(session_id, seq)` 主键存着这个会话的每一格）
          try {
            clearMessages(ledgerFile, sessionId);
            loadedMessagesRef.current.add(sessionId);
            entriesRef.current.set(sessionId, []);
          } catch (err) {
            sayIn(sessionId, `这个会话的对话没清掉（${describe(err)}）—— 重开一次它还在那儿`);
          }
          break;
        case "reprobe":
          if (current !== null) reprobe(current.id);
          break;
        case "session-new":
          // ⚠️ 转调 {@link spawnOne}：各条入口不许各造一次会话（发号只有一处）
          spawnOne();
          break;
        case "open-rename":
          if (activeId !== null) openRename(activeId);
          break;
        case "open-sessions":
          openHistory();
          break;
        case "targets-open":
          openTargets();
          break;
        case "users-open":
          openUsers();
          break;
        case "providers-open":
          openProviders();
          break;
        case "models-open":
          openModels();
          break;
        case "batch":
          runBatch(sessionId, effect);
          break;
        // ⚠️ **还有东西在飞就退不成**：它们落地时都要往台账上写，而 `finish()` 先 `closeLedgerDb()` ——
        // 症状是组件已经 `unmount` 之后才抛出来的「库已关」，屏上零解释
        case "request-exit":
          if (queueRef.current.length > 0 || busyRef.current || chatting) {
            sayIn(sessionId, EXIT_BUSY);
            break;
          }
          exit();
          break;
        // ⚠️ **这一句就是那道编译期锁，而它的位置只能在这里**：`default` 子句被 TypeScript 当成
        // 「匹配一切」，故只有这个赋值查缺档（`switch` 语句本身不查）。
        // ⚠️ 放在 `switch` 之前或之后都编不过：那一刻形参还是整个 `Effect`。
        default: {
          const _exhaustive: never = effect;
          throw new Error(`应用层不认识这个副作用：${JSON.stringify(_exhaustive)}`);
        }
      }
    },
    [
      current,
      reprobe,
      activeId,
      ledgerFile,
      spawnOne,
      openRename,
      openHistory,
      openTargets,
      openUsers,
      openProviders,
      openModels,
      runBatch,
      sayIn,
      chatting,
      exit,
      holdSessions,
    ],
  );

  useEffect(() => {
    applyEffectRef.current = applyEffect;
  }, [applyEffect]);

  /** 启动队列里的下一条（**串行化的全部实现**） */
  const pump = useCallback((): void => {
    if (busyRef.current) return;
    const job = queueRef.current.shift();
    if (job === undefined) return;
    busyRef.current = true;
    setRunning(job.line);
    void exec(job.command, depsFor(job))
      .then((result) => {
        // ⚠️ **一个字节都不留的命令不许留下「一格空对话」**：`leavesTrace` 说它们不留痕
        if (result.rows.length > 0) {
          push(job.sessionId, [{ kind: "tool-result", rows: result.rows }], Date.now());
        }
        busyRef.current = false;
        for (const effect of result.effects) applyEffect(job.sessionId, effect);
      })
      .catch(() => {
        push(
          job.sessionId,
          [{ kind: "error", rows: [{ kind: "err", text: "本包在执行这条命令时崩了（不是控制面的回答）" }] }],
          Date.now(),
        );
      })
      .finally(() => {
        busyRef.current = false;
        setRunning(null);
        const more = queueRef.current.some((one) => one.sessionId === job.sessionId);
        if (!more) {
          holdSessions((prev) =>
            prev.map((one) =>
              one.id === job.sessionId
                ? // ⚠️ **「看过了」只在结果落进你此刻正看着的那一个桶时置位**：提交那一刻就置位的话，
                  // 「在别的会话里跑、跑完了你还没看」这一格永远亮不起来
                  { ...one, run: "done", seen: one.id === activeId ? true : one.seen }
                : one,
            ),
          );
        }
        pumpRef.current();
      });
  }, [depsFor, push, applyEffect, activeId, holdSessions]);

  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  /* ── 模型那一圈 ──────────────────────────────────────────────────────────── */

  /** 当前会话那个模型键 → 出网要的那几格（⚠️ **`null` = 没配好**，而那一档一个请求都不发） */
  const modelEndpoint = useMemo((): Omit<DialectInput, "messages" | "signal" | "fetchImpl"> | null => {
    if (active === null || active.modelRef === null) return null;
    const split = splitModelRef(active.modelRef);
    if (split === null) return null;
    const provider = providers.find((one) => one.id === split.providerId);
    // ⚠️ **三格都齐才发请求**：地址或凭据为空时屏上那句是「还没配」，而对面会答 401
    if (provider === undefined || provider.baseUrl === "" || provider.apiKey === "") return null;
    return {
      api: provider.api,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: split.modelId,
      reasoning: active.reasoning,
    };
  }, [active?.modelRef, active?.reasoning, providers]);

  /** 一句不是命令的话 → 模型那一圈（⚠️ **它不走 `pump`**：那一圈自己要往返好几轮） */
  const sayToModel = useCallback(
    (sessionId: string, text: string): void => {
      const past =
        sessionsRef.current.find((one) => one.id === sessionId)?.bucket.entries.flatMap(
          (entry) => entry.turns,
        ) ?? [];
      setChatting(true);
      void ask(text, past, {
        endpoint: modelEndpoint,
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
    [modelEndpoint, depsFor, push, applyEffect],
  );

  /** 提交一行：**先分流**（命令 vs 一句话）→ 清输入行 → 排队 / 贴判据 */
  const submit = useCallback(
    (raw: string): void => {
      const line = raw.trim();
      // ⚠️ **零会话那一档先造一个**：输入一句话 / 敲命令都要求「有一个会话在」，而那一个此刻还不存在
      const sessionId = ensureSession();
      const isCommand = line.startsWith(COMMAND_PREFIX);
      const parsed: ParseResult = isCommand ? parseLine(line) : { kind: "empty" };
      holdSessions((prev) =>
        prev.map((one) =>
          one.id === sessionId
            ? {
                ...one,
                input: "",
                cursor: 0,
                anchor: null,
                // ⚠️ **只有真的排上了队才亮那枚转圈**：光按一次回车或解析失败的时候亮它，它就永远等不到「跑完了」
                run: parsed.kind === "ok" ? "running" : one.run,
              }
            : one,
        ),
      );
      historyAtRef.current = -1;
      if (line === "") return;
      if (!isCommand) {
        setHistory((prev) => pushHistory(prev, line));
        sayToModel(sessionId, line);
        return;
      }
      if (parsed.kind === "ok") {
        setHistory((prev) => pushHistory(prev, line));
        queueRef.current.push({ sessionId, line, command: parsed.command });
        pumpRef.current();
        return;
      }
      push(sessionId, [{ kind: "error", rows: rowsOfFailure(parsed) }], Date.now());
    },
    [ensureSession, holdSessions, sayToModel, push],
  );

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

  /* ── 弹窗视图：内容区那一串槽位 ──────────────────────────────────────────── */

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

  /** 清单那一族的内容区逐槽装什么（⚠️ 与呈现层那份**同序同长**） */
  const windowSlots: readonly WindowSlot[] = useMemo((): readonly WindowSlot[] => {
    if (form !== null) {
      return slotsFor({
        fields: form.fields.map((one): "input" | "select" => (one.options === undefined ? "input" : "select")),
        note: form.note,
      });
    }
    const list = asList(modal);
    if (modal === null) return [];
    if (modal.kind === "sessions") {
      return slotsFor({ note: modalNote, rows: slotsOfCells(historyCells), rename: rename !== null });
    }
    if (list === null) return [];
    if (list.kind === "targets") return slotsFor({ note: modalNote, rows: targets.map((): WindowSlot => ({ kind: "row" })) });
    if (list.kind === "users") return slotsFor({ note: modalNote, rows: accounts.map((): WindowSlot => ({ kind: "row" })) });
    if (list.kind === "providers") return slotsFor({ note: modalNote, rows: providers.map((): WindowSlot => ({ kind: "row" })) });
    if (list.kind === "provider-models") {
      return slotsFor({ filter: true, note: modalNote, rows: filteredModels.map((): WindowSlot => ({ kind: "check" })) });
    }
    return slotsFor({ note: modalNote, rows: slotsOfCells(modelCells) });
  }, [form, modal, modalNote, historyCells, rename, targets, accounts, providers, filteredModels, modelCells]);

  /** `esc 关窗` 画不画（⚠️ **全包只有这一份推导**：命中测试那份几何与呈现层那份都读它） */
  const closeHint = rename === null && form === null;

  const g = useMemo(
    () =>
      geometry({
        columns: size.columns,
        rows: size.rows,
        sidebarWidth,
        sessionCount: sessionRows.length,
        sessionsTop,
        input: activeInput,
        paletteCount: palette.rows.length,
        window: windowSlots,
        windowCloseHint: closeHint,
        menu: menu === null ? null : { x: menu.x, y: menu.y, items: menuItemsOf(menu) },
      }),
    [size.columns, size.rows, sidebarWidth, sessionRows.length, sessionsTop, activeInput, palette.rows.length, windowSlots, closeHint, menu],
  );

  /** 此刻聚焦的那个文本框落在**第几个 `input` 槽**（⚠️ 命中测试按**下标**问，而单数投影答不出那件事） */
  const textSlot = form !== null
    ? form.at
    : rename !== null
      ? windowSlots.length - 1
      : asList(modal)?.kind === "provider-models"
        ? 0
        : -1;

  /** 改名框（⚠️ **裁好的那一份**：呈现层一个字都不许自己裁） */
  const renameField: RenameField | null =
    rename === null
      ? null
      : {
          id: rename.id,
          text: ellipsis(rename.text, renameBudget(g.windowInputTexts[windowSlots.length - 1] ?? null)),
          cursor: rename.cursor,
        };

  /** 面板滚动窗口的第一行号（**绘制与命中测试共用它**） */
  const windowStart = paletteWindow(palette.at, g.paletteViewportRows, palette.rows.length);

  useEffect(() => {
    viewportRef.current = { width: g.outputWidth, rows: g.outputRows };
    sessionRowsRef.current = g.sessionViewportRows;
  }, [g.outputWidth, g.outputRows, g.sessionViewportRows]);

  useHotkeys({
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
    textWidth: g.inputTextRows[0]?.width ?? 1,
    historyEntries: history,
    historyAt: historyAtRef.current,
    editActive: editText,
    caretActive: caretText,
    fillActive,
    fillHistory,
    submit,
  });

  useMouse({
    mouse,
    geometry: g,
    sessionRows,
    activeId,
    input: activeInput,
    cursor: activeCursor,
    palette,
    windowStart,
    modalOpen: modal !== null || form !== null,
    formOpen: form !== null,
    textSlot,
    textValue,
    inputFocused: form === null && rename === null,
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
    closeWindow: closeModal,
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
  });

  /* ── 一屏 ────────────────────────────────────────────────────────────────── */

  const flat: FlatLog = useMemo(
    () => flatten(bucket.entries, g.outputWidth),
    [bucket.entries, g.outputWidth],
  );
  // ⚠️ 读的时候再夹一次：越界的 `top` 让 `visibleLines` 返回空数组（界面上是「结果区空了」）
  const top = clampTop(flat.height, g.outputRows, bucket.top);

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

  /** 会话菜单（`null` = 没开；⚠️ `origin` 是那次右键的落点，**不是**菜单自己的坐标） */
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
        // ⚠️ **逐格那份插入符原样递下去**（凭据那一格因此恒是状态层记着的那个数：空串时 0，
        // 而按字段长度现算的话「光标停在一个空格里」与「光标停在掩码末尾」两件事分不开）
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
        rows: historyRows(historyCells, sidebarIds, managerNameOf, modalPending, g.windowRows),
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
        rows: checkRows(filteredModels, list.id, list.picked, modalPending, g.windowChecks),
        at: modalAt,
        closeHint,
      };
    }
    return {
      kind: "models",
      title: "模型",
      note: modalNote,
      rows: modelRows(modelCells, g.windowRows),
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
    g.windowRows,
    g.windowChecks,
  ]);

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
      input={activeInput}
      cursor={activeCursor}
      inputSelection={selection}
      modelStatus={modelStatus}
      ghost={ghost}
      notice={notice}
      palette={paletteView}
      mouseHint={mouseUnsupportedHintOf(mouse.liveness(), Date.now())}
      showLogo={!flat.any}
      droppedHint={droppedHint(bucket)}
      view={modalView}
      rename={renameField}
      menu={menuView}
    />
  );
}