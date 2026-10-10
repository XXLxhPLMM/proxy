/** @fileoverview 模态窗口标题行右端那枚 `esc`（**关闭提示**：点它与按 `Esc` 是**同一条路**；⚠️ 它**没有**悬停态） */

import { Box, Text } from "ink";

import type { Theme } from "@/ui/theme/index.js";
import { tone } from "../constants.js";

/** 那枚提示的**按键字形**与**动作文案** */
const CLOSE_KEY = "esc";
const CLOSE_ACTION = "关窗";

/**
 * 右端那枚关闭提示（行内件：位置由父行盒的 `space-between` 给，本层不算坐标）
 * @description 分成两段是「按键与动作读起来不是一件事」那条不变式的**唯一**实现，而两段必须**不同色**。
 */
export function CloseChip(props: { readonly theme: Theme }): React.JSX.Element {
  const { theme } = props;
  return (
    <Box flexDirection="row" flexShrink={0}>
      {/* ⚠️ 按键用最亮那一档、动作用最暗那一档：同一个颜色的话「按哪个键」与「会发生什么」读起来一样 */}
      <Text color={tone(theme, "accent")} bold wrap="truncate">
        {` ${CLOSE_KEY} `}
      </Text>
      <Text color={tone(theme, "idle")} wrap="truncate">
        {CLOSE_ACTION}
      </Text>
    </Box>
  );
}
