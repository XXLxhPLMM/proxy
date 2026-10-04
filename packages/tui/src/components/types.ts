/**
 * @fileoverview 一屏各组件的**输入形状**（零 React、零 Ink、零坐标）；⚠️ 几何层算出来的坐标不许由调用方塞进来
 */

import type { FlatLog } from "@/lib/log/index.js";
import type { ConnectionState, Theme } from "@/theme/index.js";
import type { Geometry } from "@/lib/index.js";

/** 侧边栏一项（= **一个会话**，占两行） */
// ⚠️ 第二行答的是「这条命令打给谁」，而控制面本身**不在侧边栏**（它在 `/managers` 窗口里）——
// 故 `manager` 必须是 `null` 而不是空串：那是两种状态。
export interface SessionRow {
  /** 会话内唯一标识 */
  // ⚠️ **选中与 hover 都按它认，不按名字**：会话名**可以重复**，而按下标存的 hover 会在 `/new` 之后指着另一个。
  readonly id: string;
  readonly name: string;
  /** 这个会话连的是哪个控制面（`null` = 还没选，不是空串） */
  readonly manager: string | null;
}

/** 命令面板的一行（**已经裁到视口**，故长度 = 几何层的 `paletteRows`） */
// ⚠️ 它是**行号序**而不是候选序：命中测试拿这个下标回查候选序时**必须**经过同一个首行号，
// 否则点第 2 行会填出第 3 条命令 —— 而那两行在屏上长得一样。
export interface PaletteRowView {
  readonly text: string;
  /** 一句说明（`null` = 这一行没有说明可给） */
  readonly summary: string | null;
}

/** 命令面板（`null` = 面板没开，呈现结果区） */
export interface PaletteView {
  readonly rows: readonly PaletteRowView[];
  /** 高亮那一行的**行号**（`-1` = 没有高亮） */
  readonly at: number;
  /** 面板**一共有**几行候选（**不是** `PaletteView.rows` 的长度） */
  // ⚠️ 几何层靠它决定「装不下时留不留那一条说明行」。
  readonly total: number;
  /** 装不下时的那一句（`null` = 全部装得下，于是不占那一行） */
  readonly footer: string | null;
}

/** 模态窗口里的一行（一个控制面） */
export interface WindowRow {
  /** 台账里的那个 `id`（**不按名字** —— 名字可以重复） */
  readonly id: string;
  readonly name: string;
  /** 链接与超时（⚠️ 凭据只以掩码形态出现） */
  readonly detail: string;
  /** 连接状态（`null` = 这一行没有状态可言，屏上不画字形） */
  readonly state: ConnectionState | null;
  /** 这个会话当前连的就是它（`true` 时右侧给一个记号） */
  readonly current: boolean;
}

/** 一个模态窗口的内容（**公共组件** `Window` 的输入） */
// ⚠️ 它**不认识**控制面：每一行是什么由调用方排好版。
export interface WindowView {
  readonly title: string;
  readonly rows: readonly WindowRow[];
  /** 高亮那一行的**下标**（`-1` = 没有高亮；那一帧整个窗口没有加粗行） */
  readonly at: number;
  /** 底部那一条操作说明（`null` = 不占那一行） */
  readonly footer: string | null;
}

/** 一屏需要的全部状态（见 `@/app.js:Layout`）。⚠️ 这里**没有一个字段是坐标** —— 坐标只由几何层算 */
export interface LayoutProps {
  readonly columns: number;
  readonly rows: number;
  /** 是否上色（组合根从 `NO_COLOR` / `TERM=dumb` 采一次） */
  readonly color: boolean;
  readonly version: string;
  /** 侧边栏宽度（状态层那个值 —— **几何层再夹一次**，故拖出界的中间值不会画歪） */
  // ⚠️ 它与 `Geometry.sidebarWidth` 同名同义，但那是**夹过之后**的数。
  readonly sidebarWidth: number;
  /** 左侧栏那几行会话（每项 `SESSION_ROWS` 行；**没有标题行**） */
  readonly sessions: readonly SessionRow[];
  /** 会话清单**滚到第几项**（**下标**；几何层再夹一次，见 `Geometry.sessionFirst`） */
  // ⚠️ 它是**状态**而不是坐标：几何层只夹它，「当前会话必须留在窗口里」那份判断住在
  // `@/AppState.js:revealSession`。⚠️ 本字段与 `sessions.length` 构成清单的**全部**输入。
  readonly sessionsTop: number;
  /** 当前是哪个会话 `id`（`null` = 一个都没有） */
  readonly selectedSessionId: string | null;
  /** 指针悬停着的会话 `id`（`null` = 指针不在侧边栏上） */
  readonly hoveredSessionId: string | null;
  /** 指针是不是**正落在那一项的「✕」上**（`false` = 只是悬在那一项上） */
  // ⚠️ 它**不是**「哪一个会话」的第二个答案（那一份是 `hoveredSessionId`）：命中测试**不看**悬停，
  // 而「要不要亮成『别按』那一档」只能由**上一次 move 事件**回答。
  readonly sessionCloseHot: boolean;
  /** 指针在不在拖宽手柄上（那一列给一层底色） */
  readonly handleHot: boolean;
  /** 台账里**每个**控制面的连接状态（**顺序 = 台账顺序**） */
  // ⚠️ 它是**全局**的一份（控制面是所有会话共享的），而「当前会话连的是哪一个」在侧边栏第二行。
  readonly managerStates: readonly ConnectionState[];
  readonly flat: FlatLog;
  /** 滚动位置（行号，**必须**已由上层用 `clampTop` 夹过） */
  readonly top: number;
  readonly input: string;
  /** 插入符的字符下标（**原串**的下标；`0` = 行首，`input.length` = 行末） */
  readonly cursor: number;
  /** 补全建议的**剩余部分**（`null` = 没有建议） */
  readonly ghost: string | null;
  /** 瞬时消息（写操作结果、错误摘要）；`null` = 没有 */
  readonly notice: string | null;
  /** 鼠标不可用时的提示；`null` = 不显示 */
  readonly mouseHint: string | null;
  /** 该不该显示 logo（= 当前会话还没有任何输出） */
  readonly showLogo: boolean;
  readonly palette: PaletteView | null;
  /** 环形缓冲丢掉过历史时的那一句（`null` = 没丢过） */
  readonly droppedHint: string | null;
  /** 模态窗口（`null` = 没开；开了则整屏铺一层 `scrim`） */
  readonly window: WindowView | null;
  /** 指针在不在右上角那枚 `esc` 上（给它一层底色） */
  readonly closeHot: boolean;
}

/** 每个组件拿到的 props：一屏状态 + **算好的**几何 + 一份主题（三样都必须齐） */
export type RegionProps = LayoutProps & {
  readonly g: Geometry;
  readonly theme: Theme;
};