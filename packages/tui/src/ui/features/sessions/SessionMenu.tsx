/**
 * @fileoverview 会话菜单：那一小块浮层（⚠️ **不是模态** —— 点它外面就是关掉它，故没有遮罩、背后那一层照旧可点）
 * （flex 浮层：只读落点 origin，超界由 Ink 裁）
 */

import { Box, Text } from "ink";

import { MENU_PAD_X } from "@/ui/components/index.js";
import { MARK_BLANK, MARK_SELECTED, tone } from "@/ui/components/index.js";
import type { RegionProps } from "@/ui/components/index.js";

export function SessionMenu(props: RegionProps): React.JSX.Element {
  const { theme } = props;
  const view = props.menu;
  // ⚠️ 只剩这一个判据：菜单没开就整个不画（落点读状态层记的位置，卡片尺寸由内容撑起）。
  if (view === null) return <Box />;
  const sel = tone(theme, "selected");
  return (
    // ⚠️ **绝对定位 + 排在最后**：菜单浮在侧边栏与输入框**之上**，而 Ink 靠「后画的赢」压住它们
    // ⚠️ **底色给的是卡片这一层**（与模态那一块同一条纪律：`<Text>` 从最近的带底色的祖先继承）
    <Box
      position="absolute"
      left={view.origin[0]}
      top={view.origin[1]}
      flexDirection="column"
      backgroundColor={tone(theme, "panel")}
    >
      {view.items.map((label, i) => {
        const isAt = i === view.at;
        return (
          <Box key={label} flexDirection="row" flexShrink={0} paddingLeft={MENU_PAD_X}>
            <Box flexShrink={0}>
              <Text color={isAt ? sel : tone(theme, "idle")} bold={isAt}>
                {`${isAt ? MARK_SELECTED : MARK_BLANK} `}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text color={isAt ? sel : tone(theme, "idle")} bold={isAt} wrap="truncate">
                {label}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
