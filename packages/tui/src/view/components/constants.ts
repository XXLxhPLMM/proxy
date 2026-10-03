/**
 * @fileoverview 呈现层**跨组件**共用的字形，唯一的「档 → 颜色」出口在本文件
 * @module view/components/constants
 * @description 收录判据是「**两个以上**组件要读」：只服务一个组件的字形住在那个组件的文件里。
 * @module
 */

import type { Theme, Tone } from "@/ui/theme.js";

/**
 * 输入行的提示符
 * @description ⚠️ 它的**显示宽度必须等于** {@link ../geometry.js:PROMPT_COLUMNS} —— 几何层不认识
 * 字形，那份宽度只能在这里有一份数。
 */
export const PROMPT = "❯ ";

/** 命令回显的前缀（⚠️ 与 {@link PROMPT} **同一个字符**，于是「敲过的」与「正在敲的」认得出是同一条） */
export const ECHO_PREFIX = "❯ ";

/** 高亮那一行的记号（**形状通道**：无色终端里它是「选中了哪一行」的唯一可读物） */
export const MARK_SELECTED = "▍";

/** 未高亮行左侧的等宽留白 —— 少了它，高亮那一帧会整行左移一格 */
export const MARK_BLANK = " ";

/** 档 → 颜色（`undefined` = 不上色，见 {@link @/ui/theme.js:Theme}） */
export function tone(theme: Theme, t: Tone): string | undefined {
  return theme[t];
}