/** 呈现层**跨组件**共用的字形，唯一的「档 → 颜色」出口在本文件（收录判据是「**两个以上**组件要读」） */

import type { Theme, Tone } from "@/ui/theme/index.js";

/** 输入行的提示符 */
// ⚠️ 它的**显示宽度必须等于** `PROMPT_COLUMNS` —— 几何层不认识字形。
export const PROMPT = "❯ ";

/** 命令回显的前缀（⚠️ 与 {@link PROMPT} **同一个字符**，于是「敲过的」与「正在敲的」认得出是同一条） */
export const ECHO_PREFIX = "❯ ";

/** 高亮那一行的记号（**形状通道**：无色终端里它是「选中了哪一行」的唯一可读物） */
export const MARK_SELECTED = "▍";

/** 未高亮行左侧的等宽留白 —— 少了它，高亮那一帧会整行左移一格 */
export const MARK_BLANK = " ";

/** 输入行提示符占掉的列数（呈现层画的是 `❯ `，宽度必须在这里有一份数） */
export const PROMPT_COLUMNS = 2;

/** 主区那几行文字前面的缩进（边框之内的空格数） */
export const MAIN_TEXT_X = 2;

/** 会话名的起始列（相对于那一列的左缘） */
export const SIDEBAR_TEXT_X = 3;

/** 清单第一项之上留几行空白 */
export const SIDEBAR_TOP_PAD_ROWS = 1;

/** 相邻两项之间留几行空白 */
export const SESSION_GAP_ROWS = 1;

/** 会话名前面恒留几列给运行记号 */
export const SESSION_MARK_COLUMNS = 3;

/** 每一项右侧为那枚关闭恒预留几列 */
export const SESSION_CLOSE_COLUMNS = 2;

/** 侧边栏最窄也要给会话名留几列 */
export const SIDEBAR_CLOSE_MIN_NAME = 4;

/** 会话菜单左缘那一格留白 */
export const MENU_PAD_X = 1;

/** 窗口的宽占整屏宽的几成（上限） */
export const WINDOW_WIDTH_RATIO = 0.7;

/** 窗口的宽下限几列 */
export const WINDOW_MIN_WIDTH = 50;

/** 视口比这一档还窄时窗口占满整屏宽 */
export const WINDOW_FULL_WIDTH_BELOW = 60;

/** 档 → 颜色（`undefined` = 不上色，见 {@link @/ui/theme/index.js:Theme}） */
export function tone(theme: Theme, t: Tone): string | undefined {
  return theme[t];
}