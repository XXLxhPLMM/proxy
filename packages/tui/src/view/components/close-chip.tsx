/**
 * @fileoverview 模态窗口右上角那枚 `esc`（**关闭钮**：点它与按 `Esc` 是**同一条路**）
 * @module view/components/close-chip
 * @module
 */

import { Box, Text } from "ink";
import { WINDOW_CLOSE_COLUMNS } from "../geometry.js";
import { tone } from "./constants.js";
import type { RegionProps } from "./types.js";

/** 那枚 `esc` 的字面（⚠️ 它**画在上边框那一行**上，故必须是「有底色的一小块」才认得出是按钮） */
const CLOSE_LABEL = "esc";

export function CloseChip(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  const chip = g.windowClose;
  if (chip === null) return <Box />;
  // ⚠️ **指针在上面时它自己换一层底色**：否则「点它能关窗」没有任何可见的线索，而一个看不见能不能点
  // 的按钮等于没有。
  const bg = props.closeHot ? tone(theme, "hover") : undefined;
  return (
    <Box
      position="absolute"
      left={chip.x}
      top={chip.y}
      width={chip.width}
      height={chip.height}
      backgroundColor={bg}
    >
      <Text color={tone(theme, "accent")} bold backgroundColor={bg}>
        {` ${CLOSE_LABEL}`.padEnd(WINDOW_CLOSE_COLUMNS, " ")}
      </Text>
    </Box>
  );
}