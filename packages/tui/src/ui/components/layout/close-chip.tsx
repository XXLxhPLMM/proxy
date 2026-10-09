/** @fileoverview 模态窗口右上角那枚 `esc`（**关闭钮**：点它与按 `Esc` 是**同一条路**；⚠️ 它**没有**悬停态） */

import { Box, Text } from "ink";
import { tone } from "../constants.js";
import type { RegionProps } from "../types.js";

/** 那枚提示的**按键字形**与**动作文案**（⚠️ 两段的显示宽度之和恒等于 `WINDOW_CLOSE_COLUMNS`） */
// ⚠️ 分成两段是「按键与动作读起来不是一件事」那条不变式的**唯一**实现，而两段必须**不同色**。
const CLOSE_KEY = "esc";
const CLOSE_ACTION = "关窗";

export function CloseChip(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  const chip = g.windowClose;
  if (chip === null) return <Box />;
  return (
    // ⚠️ 底色给的是**外层这个 `<Box>`**（`<Text>` 从最近的带底色的祖先继承，而那一层正是它）；
    // 绝对定位 + 后画 ⇒ 它压在卡片**之上**。⚠️ 它**恒**是卡片那一档底色：指针状态不进这里，
    // 于是「这一枚长什么样」只有一个答案（两段文字的色差就是全部）。
    <Box
      position="absolute"
      left={chip.x}
      top={chip.y}
      width={chip.width}
      height={chip.height}
      backgroundColor={tone(theme, "panel")}
    >
      {/* ⚠️ 按键用最亮那一档、动作用最暗那一档：同一个颜色的话「按哪个键」与「会发生什么」读起来一样 */}
      <Text color={tone(theme, "accent")} bold>
        {` ${CLOSE_KEY} `}
      </Text>
      <Text color={tone(theme, "idle")}>{CLOSE_ACTION}</Text>
    </Box>
  );
}