/**
 * @fileoverview 语义 → 视觉的**唯一**映射面；⚠️ 本层**不读 `process.*`**（组合根采一次往下传）
 */

import type { ProbeResult } from "@/ledger/index.js";
import type { TuiCode } from "@/utils/index.js";

/** 语义色档 —— 本包全部颜色的**唯一**坐标系 */
// ⚠️ 后五档（`surface` / `hover` / `scrim` / `panel` / `panelHot`）是**背景**，与前景写在**同一个坐标系**
// 里 —— 写成另一个表就等于承认「同一个语义两种颜色」是可接受的。
export type Tone =
  | "accent"
  | "ok"
  | "warn"
  | "danger"
  | "muted"
  | "idle"
  | "selected"
  /** 侧边栏**整条**的底色（两侧都去掉框之后，屏上靠它和主区分开） */
  | "surface"
  /** 鼠标悬停在某一项上时那一项的底色（比 {@link surface} 浅一档，否则看不出来） */
  | "hover"
  /** 模态开着时整屏的**遮罩**底色（那一层里**最亮**的一档；⚠️ 终端里没有半透明，「看得见后面一点」只由前景与它的差决定） */
  | "scrim"
  /** 模态窗口**自己**的底色（**深**的一档：一张深色卡片压在浅色遮罩上，靠明暗差「浮起来」） */
  | "panel"
  /** 指针落在窗口里某个按钮上时那一枚的底色（比 {@link panel} 浅一档） */
  | "panelHot";

/**
 * 一份主题：**档 → Ink 颜色字符串**，`undefined` 即「不上色」
 * @description 不上色时**每个档都是 `undefined`**（而不是换一套灰阶）：灰阶仍然会被读成「这里有分级」。
 */
export type Theme = Readonly<Record<Tone, string | undefined>>;

/** 上色时的取值（Tokyo Night 一组，终端色表差异下仍然互相可辨） */
const COLORED: Theme = {
  accent: "#7aa2f7",
  ok: "#9ece6a",
  warn: "#e0af68",
  danger: "#f7768e",
  muted: "#6b7394",
  idle: "#414868",
  // ⚠️ **全场最亮的那一档**：面板与侧边栏的「选中」**没有反底色**（那一列的底色归 hover），于是这一档
  // 与 `muted` 的差距就是「哪一个被选中了」的唯一**颜色**线索；它也**不许暗于 `accent`**。
  selected: "#e6e8ff",
  // ⚠️ 四档底色的**相对明暗是判据，不是审美**：遮罩开着时 `panel` < `panelHot` < `hover` < `surface`
  // < `scrim`（卡片最深、遮罩最亮）；平时只剩下 `surface` < `hover` 这一条。
  surface: "#181a26",
  hover: "#24283b",
  scrim: "#c3c8dc",
  panel: "#14161f",
  panelHot: "#232838",
};

/** 遮罩期间**背后那一层的前景**：七档**全部**是这一个色 */
// ⚠️ 「基本只能看到后面一点」在终端里只有一种实现：**前景与遮罩几乎同色**；逐档调淡看着精细，实际是
// 「七档都还读得出来」。
const VEIL_TEXT = "#9ba1bd";
/** 遮罩期间侧边栏那一列的底色：比 {@link VEIL_TEXT} 略浅（列的边界还要读得出来） */
const VEIL_SURFACE = "#a7acc6";
/** 遮罩期间悬停那一项的底色：比 {@link VEIL_SURFACE} 浅一档，两者在遮罩下仍可分 */
const VEIL_HOVER = "#b3b8d0";

/** 把一份主题**盖上遮罩**（只动背景那两档与全部前景） */
// ⚠️ `panel` / `panelHot` 不动：被一起洗白的话卡片与遮罩同色，屏上就只剩「整屏亮了一块」。
function veiled(theme: Theme): Theme {
  return {
    ...theme,
    accent: VEIL_TEXT,
    ok: VEIL_TEXT,
    warn: VEIL_TEXT,
    danger: VEIL_TEXT,
    muted: VEIL_TEXT,
    idle: VEIL_TEXT,
    selected: VEIL_TEXT,
    surface: VEIL_SURFACE,
    hover: VEIL_HOVER,
  };
}

/** 遮罩开着时的那一份（= {@link veiled} 过 {@link COLORED}；⚠️ 不是另一个表，故两处不会漂） */
const SCRIMMED: Theme = veiled(COLORED);

/** 不上色时的取值（每档都是 `undefined`，理由见 {@link Theme}） */
const PLAIN: Theme = {
  accent: undefined,
  ok: undefined,
  warn: undefined,
  danger: undefined,
  muted: undefined,
  idle: undefined,
  selected: undefined,
  // ⚠️ **底色也归 `undefined`**：无色终端里侧边栏与主区**长得一样**，而那条
  // 「hover 不动鼠标也能看见」的测试（`tests/layout.test.ts`）在无色档上**恒红** ——
  // 它本来就只在 `color: true` 下有意义，与着色那一档的其余测试同规格。
  surface: undefined,
  hover: undefined,
  scrim: undefined,
  panel: undefined,
  panelHot: undefined,
};

/** 一份主题的入参（⚠️ **一个对象**：两个 `boolean` 位置参数写反了在类型上完全合法） */
export interface ThemeOptions {
  /** 终端能不能上色（组合根从 `NO_COLOR` / `TERM=dumb` 采一次） */
  readonly color: boolean;
  /** 模态窗口开着吗（开着则整屏铺一层遮罩，背景那一层退成「洗白的轮廓」） */
  readonly scrimmed: boolean;
}

/**
 * 按「要不要上色」「有没有遮罩」取一份主题；⚠️ 入参是**一个对象** —— 两个 `boolean` 写反了在类型上合法
 */
export function themeOf(options: ThemeOptions): Theme {
  if (!options.color) return PLAIN;
  return options.scrimmed ? SCRIMMED : COLORED;
}

/** 档 → 颜色（**全包唯一**的颜色出口）：**不存在**「这里我想用青色」这种用法 */
export function toneColor(tone: Tone, theme: Theme): string | undefined {
  return theme[tone];
}

/** 失败码 → 色档的真值表（分档理由是**处置动作**） */
// ⚠️ 类型是 **`Record<TuiCode, Tone>`** 而不是 `Partial`：这让「服务端加一档 code」在
// `pnpm typecheck` 阶段就把这张表打红。
const SEVERITY_TONE: Readonly<Record<TuiCode, Tone>> = {
  // 改输入或改配置就能继续 → 要处理，但没坏
  unauthorized: "warn",
  unreachable: "warn",
  timeout: "warn",
  invalid: "warn",
  "bad-request": "warn",
  "already-exists": "warn",
  "method-not-allowed": "warn",
  // 环境坏了，或者对面说的话本包听不懂 → 只能去查
  internal: "danger",
  "read-only-driver": "danger",
  "source-unreadable": "danger",
  // 余下两档各有各的读法，不混进上面那两档
  "not-found": "idle",
  "bad-shape": "danger",
};

/** 失败码 → 颜色（**唯一**的「失败 → 颜色」出口） */
// ⚠️ `bad-shape` 归 `danger`（对面跑着本包不认识版本的进程，必须让操作者停下）；`not-found` 归 `idle`
// —— 「你给的那个东西没有」是一条**正常的答案**。
export function severityColor(code: TuiCode, theme: Theme): string | undefined {
  return toneColor(SEVERITY_TONE[code], theme);
}

/** 一个 id 在探活期间持有的那个值 */
// ⚠️ 「在飞」与「结果」**同容器**（一个 id 一个值）：第二个容器一出现，目标条与表格就能再次对同一个
// 目标说两个词。
export type ProbeSlot = ProbeResult | { readonly pending: true };

/** 一个控制面目标的连接状态（⚠️ **`connecting` 是「还没问出结果」**，必须与 `unknown`「还没试过」分开） */
export type ConnectionState =
  "connecting" | "connected" | "unauthorized" | "unreachable" | "unknown";

/** 一个状态的完整标记：字形 + 色档 + 中文标签 */
export interface ConnectionMark {
  /** 字形（**状态的第二通道**：色盲与无色终端靠它） */
  readonly glyph: string;
  readonly tone: Tone;
  readonly label: string;
}

/** 各档的真值表（表外状态没有第二出口，见 {@link connectionMark}） */
const CONNECTION_MARKS: Readonly<Record<ConnectionState, ConnectionMark>> = {
  connecting: { glyph: "◌", tone: "muted", label: "连接中" },
  connected: { glyph: "●", tone: "ok", label: "已连接" },
  unauthorized: { glyph: "▲", tone: "warn", label: "未授权" },
  unreachable: { glyph: "○", tone: "idle", label: "未连接" },
  unknown: { glyph: "·", tone: "idle", label: "未知" },
};

/**
 * 连接状态 → 字形 + 色档 + 标签（**唯一**出口）
 * @description 字形刻意选成**轮廓差异明显**的一组而不是同一形状的五种颜色：色盲用户与 `NO_COLOR`
 * 环境下两者都靠形状读。
 */
export function connectionMark(state: ConnectionState): ConnectionMark {
  return CONNECTION_MARKS[state];
}

/** 探活持有的值 → 连接状态（**全包唯一**的这份换算；⚠️ 分头写两份的后果是**同一屏上两句话**） */
// ⚠️ `unauthorized`（服务端答了 → 改 token）与 `unreachable`（没答上 → 查地址）是两个方向相反的排查
// 动作；`shape` 落 `unknown` 而不是 `unreachable`：说成「连不上」会让人去查一台没问题的机器。
export function connectionStateOf(slot: ProbeSlot | undefined): ConnectionState {
  if (slot === undefined) return "unknown";
  if ("pending" in slot) return "connecting";
  if (slot.ok) return "connected";
  if (slot.error.code === "unauthorized") return "unauthorized";
  if (slot.error.kind === "transport") return "unreachable";
  return "unknown";
}

/** 瞬时消息的四档（`overlays.tsx:Toast` 用它上色与选字形） */
export type ToastKind = "info" | "ok" | "warn" | "err";

/** 四档 → 字形 + 色档 */
const TOAST_MARKS: Readonly<Record<ToastKind, ConnectionMark>> = {
  info: { glyph: "·", tone: "accent", label: "" },
  ok: { glyph: "●", tone: "ok", label: "" },
  warn: { glyph: "▲", tone: "warn", label: "" },
  err: { glyph: "✗", tone: "danger", label: "" },
};

/**
 * 瞬时消息档 → 字形 + 色档（**唯一**出口）
 * @description 与 {@link connectionMark} 是同一条纪律的第二个面：同一个字形在不同语境里
 * 必须指同一件事（`▲` 在目标条与提示条里都是「要你处理」），所以两张表刻意共用字形。
 */
export function toastMark(kind: ToastKind): ConnectionMark {
  return TOAST_MARKS[kind];
}
