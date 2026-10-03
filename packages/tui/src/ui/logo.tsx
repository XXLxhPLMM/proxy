/**
 * @fileoverview 头部标记的**素材**：ASCII 艺术字 + 副标（零 React）
 * @module ui/logo
 * @description
 * ⚠️ **本模块零 React**：它只提供**两串常量**（{@link BANNER} 与 {@link TAGLINE}），
 * 而呈现（怎么上色、怎么排、怎么随宽度变形）全在 `@/view/layout.tsx:Welcome` ——
 * 引导屏是**主区里的一段文字**（没选中控制面时顶上那一块），而它需要的只是这两串常量。
 * ⚠️ 判据是「**绘制只认 `@/view/geometry.ts` 那一份坐标**」：一个自己算宽度的组件文件会引入
 * 第二份宽度计算，而那与几何层漂了的后果是「点 A 行切到 B 机」。
 *
 * ## 为什么是**纯 ASCII**
 * @description
 * 艺术字里的每一个字形都要靠**终端字体**有对应 glyph 才有效果。box-drawing（`─│┌`）在
 * 等宽字体里几乎必然有；但花体字、阴影字（`░▒▓█`）、emoji、以及任何非 ASCII 的字母变形都
 * 是**看运气**：缺字形时终端画出来的是一个替换字符，于是标题行变成一排豆腐块 —— 而那正是
 * 「用户一打开就看到坏了」的界面。故本文件的字母只用 `#` 与空格。
 * （界面上的 box-drawing 边框、状态字形那些**不是**风险：`@/view/layout.tsx` 用的
 * `borderStyle="round"` 由 Ink 排、状态字形选的是基本区里所有等宽字体都覆盖的字符。）
 *
 * ## ⚠️ 逐行必须等宽
 * @description
 * `BANNER` 的字形是 5×5 网格、字母间一格空隙（`5×5 + 4×1 = 29`）。**不许**改成不等宽的版本：
 * 呈现层按 `widthOf` 逐行裁剪，而「本屏放不下」这个判断用的是**最宽那一行**，一行超了就软换行，
 * 标题当场断成两截。故改动这个数组之后必须逐行核对显示宽度（`@/ui/format.ts:widthOf`）。
 *
 * @module
 */

/**
 * 艺术字本体（`SWAIN`，5 行 × 29 列，逐行等宽）
 * @description ⚠️ 逐行等宽这件事本身就是契约，理由见文件头。
 */
export const BANNER: readonly string[] = [
  " #### #   #  ###  ##### #   #",
  "#     #   # #   #   #   ##  #",
  " ###  # # # #####   #   # # #",
  "    # # # # #   #   #   #  ##",
  "####   # #  #   #  ##### #   #",
];

/** 副标（与 `package.json` 的 `description` 是同一句话） */
export const TAGLINE = "PROXY CONTROL PLANE";