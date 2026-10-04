/**
 * @fileoverview 会话菜单：右键弹出的那一小块浮层（⚠️ **不是模态** —— 点它外面就是关掉它，故没有遮罩、背后那一层照旧可点）
 */

import { Box, Text } from "ink";

import { MENU_PAD_X, ellipsis } from "@/lib/index.js";
import { MARK_BLANK, MARK_SELECTED, tone } from "@/components/index.js";
import type { RegionProps } from "@/components/index.js";

export function SessionMenu(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  const box = g.menu;
  const view = props.menu;
  if (box === null || view === null) return <Box />;
  const sel = tone(theme, "selected");
  const pad = " ".repeat(MENU_PAD_X);
  return (
    // ⚠️ **绝对定位 + 排在最后**：菜单浮在侧边栏与输入框**之上**，而 Ink 靠「后画的赢」压住它们
    // ⚠️ **底色给的是卡片这一层**（与模态那一块同一条纪律：`<Text>` 从最近的带底色的祖先继承）
    <Box
      position="absolute"
      left={box.x}
      top={box.y}
      width={box.width}
      height={box.height}
      flexDirection="column"
      backgroundColor={tone(theme, "panel")}
    >
      {view.items.map((label, i) => {
        const rect = g.menuRows[i];
        // ⚠️ 画不画那一项**读几何的格子**而不是自己往下数：多画一项的话它落在卡片之外，而卡片的
        // 高度是几何给的 —— 症状是「最后一项掉到卡片底下那一行」
        if (rect === undefined) return null;
        const isAt = i === view.at;
        return (
          <Box key={label} width={box.width} height={rect.height}>
            <Text>{pad}</Text>
            <Text color={isAt ? sel : tone(theme, "idle")} bold={isAt}>
              {`${isAt ? MARK_SELECTED : MARK_BLANK} `}
            </Text>
            <Text color={isAt ? sel : tone(theme, "idle")} bold={isAt}>
              {ellipsis(label, Math.max(0, rect.width - 2))}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}