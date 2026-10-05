/**
 * @fileoverview 语义 → 颜色的**唯一**映射面：主题怎么取、失败码与状态怎么落到某一档；⚠️ 本层**不读 `process.*`**（组合根采一次往下传）
 */

import type { ProbeResult } from "@/services/config/index.js";
import type { TuiCode } from "@/lib/index.js";
import type { RunState } from "@/store/index.js";

import { type Theme, type Tone } from "./palette.js";

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

/** 侧边栏那一枚记号：字形 + 色档（⚠️ **两个通道**，不是一个字符串 —— 色盲与 `NO_COLOR` 环境下靠字形读） */
export interface RunMark {
  readonly glyph: string;
  readonly tone: Tone;
}

/** 各档的真值表（表外状态没有第二出口，见 {@link runMarkOf}） */
const RUN_MARKS: Readonly<Record<RunState, RunMark>> = {
  idle: { glyph: " ", tone: "idle" },
  running: { glyph: "⠋", tone: "accent" },
  // ⚠️ `●` 与 `toastMark` 的 `ok` / `connectionMark` 的 `connected` 刻意共用字形 ——
  // 同一个字形在不同语境里必须指同一件事（**成功**），而「跑完了」正是成功。
  done: { glyph: "●", tone: "ok" },
};

/**
 * 运行状态 → 字形 + 色档（**全包唯一**的这份换算）
 * @description 与 {@link connectionMark} 是同一条纪律的第三个面：语义 → 字形 + 色档只有这一个出口。
 */
// ⚠️ 字形是**第二通道**：`idle` 的字形是**一个空格**而不是空串 —— 那一格恒存在，而两帧的列位必须一样。
export function runMarkOf(run: RunState): RunMark {
  return RUN_MARKS[run];
}