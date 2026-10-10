/** 菜单文案、槽位、分组、行模型装配、表单字段表。纯函数，零 IO、零 React。 */
import type { AccountBody } from "@/api/index.js";
import {
  MODEL_API_FORMATS,
  LedgerError,
  idFor,
  joinModelRef,
  splitModelRef,
  type ModelRecord,
  type ProviderRecord,
  type Target,
} from "@/services/config/index.js";
import { dayGroupLabel } from "@/lib/index.js";
import type { WindowSlot } from "@/ui/components/index.js";
import {
  emptyBucket,
  type Bucket,
  type FieldSpec,
  type FormState,
  type SessionRecord,
  type SidebarEntry,
  type WindowState,
} from "@/store/index.js";
import type {
  ListRow,
  ModelCheckRow,
  ModelListRow,
  SessionListRow,
} from "@/ui/components/index.js";
/* ── 菜单 ──────────────────────────────────────────────────────────────────── */

/** 菜单里那三项的文案（⚠️ **文案在这里、几何按它算宽度**：两处各写一份的话卡片宽度与画出来的字对不上） */
// ⚠️ 第一项**必须说清是「移出侧边栏」而不是「删除」**：那个动作只改「侧边栏上有没有它」，
// 会话与它的对话都留着 —— 而破坏性的那一个（级联删三张表）挂在弹窗里的 `Ctrl+D` 上。
export const MENU_DETACH = "从侧边栏移出";
export const MENU_RENAME = "重命名";
export const MENU_NEW = "新建会话";

/** 一次弹出的菜单有哪几项（⚠️ **空白处那一份只有「新建会话」**：那里没有「它」可以删除或改名） */
// ⚠️ **「新建会话」刻意也在会话项那一份里**：只在空白处才有的话，侧边栏被会话填满时那一路整个消失，
// 而删除与改名都还在 —— 三个动作不该有两个与清单密度绑在一起
export function menuItemsOf(menu: { readonly sessionId: string | null } | null): readonly string[] {
  if (menu === null) return [];
  return menu.sessionId === null ? [MENU_NEW] : [MENU_DETACH, MENU_RENAME, MENU_NEW];
}

/* ── 内容区逐格：说明 / 分组标题 / 可选项 ──────────────────────────────────── */

/** 内容区里的一格（⚠️ **三档混在同一个数组里**：按行铺位置，拆开就得另有一处换算） */
export type Cell<T> =
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "group"; readonly text: string }
  | { readonly kind: "row"; readonly item: T };

/** 逐格 ⇒ 槽位串（**一趟算完** —— 各算一遍就会与绘制错开一行） */
export function slotsOfCells<T>(cells: readonly Cell<T>[]): readonly WindowSlot[] {
  return cells.map((cell): WindowSlot =>
    cell.kind === "row" ? { kind: "row" } : cell.kind === "group" ? { kind: "group" } : { kind: "note" },
  );
}

/** 弹窗那一档 ⇒ 内容区逐槽装什么（⚠️ **与 `layout/window-slots.js:slotsOf` 同序同长**） */
export function slotsFor(spec: {
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
export function groupOrder(records: readonly SessionRecord[], now: number): readonly Cell<SessionRecord>[] {
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
export function sidebarRecords(
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

/* ── 行模型装配（纯函数：⚠️ 呈现层一个字都不许自己拼） ──────────── */

export function historyRows(
  cells: readonly Cell<SessionRecord>[],
  sidebar: ReadonlySet<string>,
  managerOf: (id: string) => string | null,
  pendingId: string | null,
): readonly SessionListRow[] {
  const out: SessionListRow[] = [];
  for (const cell of cells) {
    // ⚠️ 分组标题行的 `id` / `name` 恒是空串而 `manager` 恒 `null`：它不对应任何会话
    if (cell.kind === "group") {
      // ⚠️ **标题那一行的 `label` 就是标题本身**
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
      label: record.name,
    });
  }
  return out;
}

export function targetRows(targets: readonly Target[], currentId: string | null, pendingId: string | null): readonly ListRow[] {
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

export function userRows(accounts: readonly AccountBody[], pendingId: string | null): readonly ListRow[] {
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

export function providerRows(providers: readonly ProviderRecord[], currentId: string | null, pendingId: string | null): readonly ListRow[] {
  return providers.map((one) => ({
    id: one.id,
    name: one.name,
    detail: `${one.baseUrl} · ${one.api}`,
    state: null,
    current: one.id === currentId,
    pending: one.id === pendingId,
  }));
}

export function checkRows(
  models: readonly ModelRecord[],
  providerId: string,
  picked: ReadonlySet<string>,
  pendingId: string | null,
): readonly ModelCheckRow[] {
  return models.map((one) => {
    let ref = one.modelId;
    try {
      ref = joinModelRef(providerId, one.modelId);
    } catch {
      // ⚠️ `providerId` 含 `/` 是编程错误；那一行仍要画出来（不画就是「凭空少一个模型」）
    }
    return {
      id: ref,
      label: one.label,
      checked: picked.has(one.modelId),
      pinned: one.pinned,
      pending: one.modelId === pendingId,
    };
  });
}

export function modelRows(
  cells: readonly Cell<ModelChoice>[],
): readonly ModelListRow[] {
  const out: ModelListRow[] = [];
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
      label: one.label,
      header: null,
      pinned: one.pinned,
    });
  }
  return out;
}

/** 一个账号的流量上限那一截（⚠️ 缺省即「不限」，而那与服务端的 `0` 是同一件事） */
export function accountQuota(account: AccountBody): string {
  const bytes = account.quota?.bytes ?? 0;
  return bytes === 0 ? "不限流量" : `上限 ${String(bytes)} 字节`;
}

/** 全部可选模型 → 按提供商分组（⚠️ **置顶的一组排在最前**，而 `★` 与排序是同一件事的两面） */
export function modelCellsOf(
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
export function filterModels(models: readonly ModelRecord[], word: string): readonly ModelRecord[] {
  const needle = word.trim().toLowerCase();
  if (needle === "") return models;
  return models.filter(
    (one) => one.label.toLowerCase().includes(needle) || one.modelId.toLowerCase().includes(needle),
  );
}

/** 一个模型选项（⚠️ **显示名与存储键分开**：前者能改，后者是协议标识） */
export interface ModelChoice {
  /** 存储键 `<providerId>/<modelId>`（⚠️ 按**第一个** `/` 拼） */
  readonly ref: string;
  readonly providerId: string;
  readonly provider: string;
  readonly label: string;
  readonly pinned: boolean;
}

/* ── 表单：一段文本 + 一张字段表 ───────────────────────────────────────────── */

/** 账号那一格「启用」下拉的两档（⚠️ **下拉的档位是给人读的**，落库时换回布尔） */
export const USER_ENABLED = ["启用", "停用"] as const;

/** 提供商表单的五格（⚠️ **顺序即屏上顺序**） */
export const PROVIDER_FIELDS: readonly FieldSpec[] = [
  { label: "地址" },
  { label: "API 格式", options: MODEL_API_FORMATS },
  { label: "提供商 id" },
  { label: "提供商名称" },
  { label: "key" },
];

/** 控制面表单的四格（⚠️ `token` 那一格**永不回显真值**：留空 = 不改这一项） */
export const TARGET_FIELDS: readonly FieldSpec[] = [
  { label: "名字" },
  { label: "地址" },
  { label: "token" },
  { label: "超时(ms)" },
];

/** 账号表单（⚠️ **新增那一份多一个密码格**：服务端 `POST /api/users` 的 `password` 是必填，改密码走 `Ctrl+P`） */
export const USER_FIELDS: readonly FieldSpec[] = [
  { label: "用户名" },
  { label: "密码" },
  { label: "流量上限" },
  { label: "启用", options: USER_ENABLED },
];

/** 编辑已有账号时的字段表（⚠️ **用户名改不得** —— 它是那台机器上的身份，而密码走 `Ctrl+P`） */
export const USER_EDIT_FIELDS: readonly FieldSpec[] = [
  { label: "用户名" },
  { label: "流量上限" },
  { label: "启用", options: USER_ENABLED },
];

export const LABEL_FIELDS: readonly FieldSpec[] = [{ label: "显示名" }];
export const PASSWORD_FIELDS: readonly FieldSpec[] = [{ label: "新密码" }];

/** 起手那一份逐格插入符（⚠️ **逐格落在那一串的末尾** —— 从清单回填进来的字已经在那儿，
 *  而光标停在行首的话第一个敲进去的字会插到它前面） */
export function cursorsOf(values: readonly string[]): readonly number[] {
  return values.map((one) => one.length);
}

/** 换掉表单里第 `at` 那一格 + 它的插入符（⚠️ **数组换算是逐格的**：两格各换一次而有一格换了另一个下标就会串） */
export function withValue(form: FormState, at: number, text: string, cursor: number): FormState {
  const values = [...form.values];
  const cursors = [...form.cursors];
  values[at] = text;
  cursors[at] = cursor;
  return { ...form, values, cursors, note: null };
}

export function withCursor(form: FormState, at: number, cursor: number): FormState {
  const cursors = [...form.cursors];
  cursors[at] = cursor;
  return { ...form, cursors, note: null };
}

/** 下拉那一格换一档（⚠️ **走到两端就停住**，而档位环不是闭合的：换档不是「切行」） */
export function withSelect(form: FormState, step: 1 | -1): FormState {
  const options = form.fields[form.at]?.options;
  if (options === undefined || options.length === 0) return form;
  const now = options.indexOf(form.values[form.at] ?? "");
  const next = Math.max(0, Math.min(options.length - 1, (now < 0 ? 0 : now) + step));
  return withValue(form, form.at, options[next] ?? "", (options[next] ?? "").length);
}

/* ── 其它文案与判据 ────────────────────────────────────────────────────────── */

/** 弹窗里一个**没有历史会话**时的那一句（⚠️ 一句人话而不是空串：空串与「有会话而它们装不下」在屏上一样） */
export const NO_HISTORY_NOTE = "台账里一个历史会话都没有 · 用 /new 开一个，它会自动进侧边栏";

/** 账号那一族**没有选中控制面**时的那一句（⚠️ 它与「这台真没有账号」在屏上必须分得开） */
export const NO_TARGET_NOTE = "还没选中控制面 · 先在 /targets 里给当前会话选一台，否则账号表无从读起";

/** `/batch` 的那些名字一个都不在台账里（⚠️ **不是空跑**：说清楚「你说给谁听」这件事没成立） */
export const BATCH_NO_TARGET = "台账里没有这些控制面 —— /targets 看有哪些，或 /batch all 发给全部";

/** `/exit` 撞上在飞的东西时的那一句（⚠️ 说「跑完再退」而不是静默不响应 —— 静默与「没生效」在屏上一样） */
export const EXIT_BUSY = "还有命令在跑，跑完再退";

/** 一次台账写失败 → 说明行上那一句（⚠️ **`LedgerError` 的文案一个字都不描述用户敲的东西**，而传输层的失败只说形状） */
export function ledgerFailure(err: unknown): string {
  if (err instanceof LedgerError) return `台账没接受这一份：${err.message}`;
  return "这一份的形状不对（地址要像 http://主机:端口，超时要落在一个区间里）";
}

/** 名字 → 台账里那个 `id`（⚠️ **新增那一支**才发号，而编辑那一支认的是传进来的那个 `id`） */
export function idForName(targets: readonly Target[], name: string): string {
  return idFor(name, targets.map((one) => one.id));
}

/** 历史会话弹窗的标题（⚠️ **台数放在标题里**而不是每一行：那一行还有名字与两个记号） */
export function historyTitle(count: number): string {
  return `历史会话（${String(count)}）`;
}

export function listTitle(what: string, count: number): string {
  return `${what}（${String(count)}）`;
}

/** 清单那一族：窗态的收窄（⚠️ 判据是 `kind` 本身而不是「窗口开着」 —— 两处各判一次就会有一族少一个分支） */
// ⚠️ **五种表单不在这一族里**：它们的字段表从五格到一格不等，窗态那一个变体表达不了 ⇒ 它们住局部
// `FormState`，而 `modal` 此刻是表单**底下**那一档清单（表单盖在清单上，不是平级的两个窗口）。
export type ListState = Extract<
  WindowState,
  { readonly kind: "targets" | "users" | "providers" | "provider-models" | "models" }
>;

export function asList(state: WindowState | null): ListState | null {
  return state !== null && state.kind !== "sessions" ? state : null;
}

/** 当前会话那个模型键落在哪个提供商（⚠️ **`null` = 没选模型，而悬空的键也当没选**） */
export function providerIdOf(ref: string | null | undefined): string | null {
  if (ref === null || ref === undefined) return null;
  return splitModelRef(ref)?.providerId ?? null;
}

/** 一个会话桶（⚠️ **零会话那一档**：桶是空的，于是结果区画引导屏那块标记） */
export const NO_BUCKET: Bucket = emptyBucket();
