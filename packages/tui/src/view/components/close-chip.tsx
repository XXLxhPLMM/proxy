/** @fileoverview 模态窗口右上角那枚 `esc`（**关闭钮**：点它与按 `Esc` 是**同一条路**） */

import { Box, Text } from "ink";
import { WINDOW_CLOSE_COLUMNS } from "../geometry.js";
import { tone } from "./constants.js";
import type { RegionProps } from "./types.js";

/** 那枚 `esc` 的字面（⚠️ 它**画在标题那一行**上，故必须是「有底色的一小块」才认得出是按钮） */
const CLOSE_LABEL = "esc";

export function CloseChip(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  const chip = g.windowClose;
  if (chip === null) return <Box />;
  // ⚠️ **它恒自带底色**（指着时换成 `panelHot`）：它坐在卡片的**标题那一行**上，而 Ink 让
  // `<Text>` 从**最近的带底色的祖先 `<Box>`** 继承 —— 那是整屏那个根盒子（遮罩），不是窗口。
  // ⚠️ 用 `panelHot` 而不是 `hover`：后者是背景那一层的语义（遮罩开着时它已被压暗）。
  const bg = props.closeHot ? tone(theme, "panelHot") : tone(theme, "panel");
  return (
    // ⚠️ 底色给的是**外层这个 `<Box>`**（`<Text>` 从最近的带底色的祖先继承，而那一层正是它）；
    // 绝对定位 + 后画 ⇒ 它压在卡片**之上**。
    <Box
      position="absolute"
      left={chip.x}
      top={chip.y}
      width={chip.width}
      height={chip.height}
      backgroundColor={bg}
    >
      <Text color={tone(theme, "accent")} bold>
        {` ${CLOSE_LABEL}`.padEnd(WINDOW_CLOSE_COLUMNS, " ")}
      </Text>
    </Box>
  );
}