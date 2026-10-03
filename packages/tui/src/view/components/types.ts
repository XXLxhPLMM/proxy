/**
 * @fileoverview 一屏各组件的**输入形状**：六个视图接口（零 React、零 Ink、零坐标）
 * @module view/components/types
 * @description
 * 这里是**事实**而不是位置：{@link ../geometry.js:geometry} 算出来的每一处坐标都不许由调用方
 * 塞进这些接口。
 * @module
 */

import type { FlatLog } from "@/log/index.js";
import type { ConnectionState, Theme } from "@/ui/theme.js";
import type { Geometry } from "../geometry.js";

/**
 * 侧边栏一项（= **一个会话**，占两行）
 * @description ⚠️ 第二行答的是「这条命令打给谁」，而控制面本身**不在侧边栏**（它在 `/managers`
 * 窗口里）—— 故 {@link SessionRow.manager} 必须是 `null` 而不是空串：那是两种状态。
 */
export interface SessionRow {
  /**
   * 会话内唯一标识
   * @description ⚠️ **选中与 hover 都按它认，不按名字**：会话名**可以重复**，而按下标存的 hover
   * 会在 `/new` 之后指着另一个。
   */
  readonly id: string;
  readonly name: string;
  /** 这个会话连的是哪个控制面（`null` = 还没选） */
  readonly manager: string | null;
}

/**
 * 命令面板的一行（**已经裁到视口**，故长度 = 几何层的 `paletteRows`）
 * @description ⚠️ 它是**行号序**而不是候选序：命中测试拿这个下标回查候选序时**必须**经过同一个
 * 首行号，否则点第 2 行会填出第 3 条命令 —— 而那两行在屏上长得一样。
 */
export interface PaletteRowView {
  /** 给人看的命令名 */
  readonly text: string;
  /** 那条命令的一句说明（`null` = 这一行没有说明可给） */
  readonly summary: string | null;
}

/** 命令面板（`null` = 面板没开，呈现结果区） */
export interface PaletteView {
  readonly rows: readonly PaletteRowView[];
  /** 高亮那一行的**行号**（`-1` = 没有高亮） */
  readonly at: number;
  /**
   * 面板**一共有**几行候选（**不是** {@link PaletteView.rows} 的长度）
   * @description ⚠️ 几何层靠它决定「装不下时留不留那一条说明行」。
   */
  readonly total: number;
  /** 装不下时的那一句（`null` = 全部装得下，于是不占那一行） */
  readonly footer: string | null;
}

/** 模态窗口里的一行（一个控制面） */
export interface WindowRow {
  /** 台账里的那个 `id`（命中测试回查目标时用它，**不按名字**—— 名字可以重复） */
  readonly id: string;
  readonly name: string;
  /** 链接与超时（⚠️ 凭据只以掩码形态出现，见 `@/ui/format.js:maskToken`） */
  readonly detail: string;
  /** 连接状态（`null` = 这一行没有状态可言，屏上不画字形） */
  readonly state: ConnectionState | null;
  /** 这个会话当前连的就是它（`true` 时那一行右侧给一个记号） */
  readonly current: boolean;
}

/**
 * 一个模态窗口的内容（**公共组件** {@link ./window.js:Window} 的输入）
 * @description ⚠️ 它**不认识**控制面：每一行是什么由调用方排好版。下一个窗口（改密码 / 账号）
 * 要的形状与它一样，故抽出来。
 */
export interface WindowView {
  readonly title: string;
  readonly rows: readonly WindowRow[];
  /** 高亮那一行的**下标**（`-1` = 没有高亮；那一帧整个窗口没有加粗行） */
  readonly at: number;
  /** 底部那一条操作说明（`null` = 不占那一行） */
  readonly footer: string | null;
}

/**
 * 一屏需要的全部状态。⚠️ 这里**没有一个字段是坐标** —— 坐标只由几何层算
 * @see {@link ./layout.tsx:Layout}
 */
export interface LayoutProps {
  readonly columns: number;
  readonly rows: number;
  /** 是否上色（组合根从 `NO_COLOR` / `TERM=dumb` 采一次） */
  readonly color: boolean;
  readonly version: string;
  /**
   * 侧边栏宽度（状态层那个值 —— **几何层再夹一次**，故拖出界的中间值不会画歪）
   * @description ⚠️ 它与 {@link ../geometry.js:Geometry.sidebarWidth} 同名同义，但那是**夹过之后**的
   * 数；两处不许各夹一次（呈现层拿夹过的画、状态层拿夹过的判）。
   */
  readonly sidebarWidth: number;
  /** 左侧栏那几行会话（每项 {@link ../geometry.js:SESSION_ROWS} 行；**没有标题行**） */
  readonly sessions: readonly SessionRow[];
  /** 当前是哪个会话 `id`（`null` = 一个都没有） */
  readonly selectedSessionId: string | null;
  /** 指针悬停着的会话 `id`（`null` = 指针不在侧边栏上） */
  readonly hoveredSessionId: string | null;
  /** 指针在不在拖宽手柄上（那一列给一层底色，于是「能拖」这件事看得见） */
  readonly handleHot: boolean;
  /**
   * 台账里**每个**控制面的连接状态（**顺序 = 台账顺序**）
   * @description ⚠️ 它是**全局**的一份（控制面是所有会话共享的），而「当前会话连的是哪一个」在
   * 侧边栏第二行 —— 两处各答各的问题，故不冲突。
   */
  readonly managerStates: readonly ConnectionState[];
  readonly flat: FlatLog;
  /** 滚动位置（行号，**必须**已由上层用 `clampTop` 夹过） */
  readonly top: number;
  readonly input: string;
  /** 插入符的字符下标（`0` = 行首，`input.length` = 行末；**原串**的下标） */
  readonly cursor: number;
  /** 补全建议的**剩余部分**（`null` = 没有建议） */
  readonly ghost: string | null;
  /** 瞬时消息（写操作结果、错误摘要）；`null` = 没有 */
  readonly notice: string | null;
  /** 鼠标不可用时的提示；`null` = 不显示 */
  readonly mouseHint: string | null;
  /** 该不该显示 logo（= 当前会话还没有任何输出） */
  readonly showLogo: boolean;
  /** 命令面板（`null` = 没开） */
  readonly palette: PaletteView | null;
  /** 环形缓冲丢掉过历史时的那一句（`null` = 没丢过） */
  readonly droppedHint: string | null;
  /** 模态窗口（`null` = 没开；开了则整屏铺一层 `scrim`） */
  readonly window: WindowView | null;
  /** 指针在不在右上角那枚 `esc` 上（给它一层底色，于是「点它能关窗」看得见） */
  readonly closeHot: boolean;
}

/**
 * 每个组件拿到的 props：一屏状态 + **算好的**几何 + 一份主题
 * @description 三样都必须齐 —— 组件不许自己算坐标，也不许自己取主题。
 */
export type RegionProps = LayoutProps & {
  readonly g: Geometry;
  readonly theme: Theme;
};