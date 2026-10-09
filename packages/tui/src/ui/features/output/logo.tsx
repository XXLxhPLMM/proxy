/**
 * @fileoverview 引导屏那块**标记的素材**（零 React）；⚠️ 字形**不是**纯 ASCII —— 缺字形时终端画出来是一排豆腐块
 */

import stringWidth from "string-width";

/** 艺术字的一行：**文字 + 它自己那一档颜色**（truecolor hex，`undefined` = 不上色） */
export interface LogoLine {
  readonly text: string;
  /** ⚠️ **不是主题 token**：渐变与服务端 banner 逐字同源，故它是一个字面 hex 而不走 `@/theme/` 的色档 */
  readonly color: string;
}

/** 艺术字本体（`PROXY`，6 行 × 50 列，逐行等宽、逐行一色；⚠️ 颜色自上而下由青走到紫） */
export const LOGO: readonly LogoLine[] = Object.freeze([
  { text: "███████╗ ██╗    ██╗  █████╗  ██╗ ███╗   ██╗", color: "#00d9ff" },
  { text: "██╔════╝ ██║    ██║ ██╔══██╗ ██║ ████╗  ██║", color: "#24bdfd" },
  { text: "███████╗ ██║ █╗ ██║ ███████║ ██║ ██╔██╗ ██║", color: "#47a0fa" },
  { text: "╚════██║ ██║███╗██║ ██╔══██║ ██║ ██║╚██╗██║", color: "#6b84f8" },
  { text: "███████║ ╚███╔███╔╝ ██║  ██║ ██║ ██║ ╚████║", color: "#8e67f5" },
  { text: "╚══════╝  ╚══╝╚══╝  ╚═╝  ╚═╝ ╚═╝ ╚═╝  ╚═══╝", color: "#b24bf3" },
]);

/** 艺术字下面那行小字（⚠️ **不是**副标：那一行说明属于「这块标记叫什么」，而这里是它的名字） */
export const LOGO_TAG = "proxy";

/** 整块标记的显示宽度（**最宽那一行**；几何层据此判「这一屏放不放得下」） */
// ⚠️ 它是 {@link LOGO} 与 {@link LOGO_TAG} 合成的那一块的宽度，而两段都要算。
export const LOGO_WIDTH: number = Math.max(
  ...LOGO.map((line) => stringWidth(line.text)),
  stringWidth(LOGO_TAG),
);

/** 整块标记占几行（艺术字 + 小字那一行） */
export const LOGO_ROWS: number = LOGO.length + 1;