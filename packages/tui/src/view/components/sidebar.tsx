/**
 * @fileoverview 左侧那一列：会话清单（每项**两行**）+ 最右那一列的拖宽手柄
 * @module view/components/sidebar
 * @description 一整条底色、没有框、没有标题行，每一项铺满整列。
 * @module
 */

import { Box, Text } from "ink";
import { ellipsis, widthOf } from "@/ui/format.js";
import { SESSION_ROWS, SIDEBAR_TEXT_X } from "../geometry.js";
import { tone } from "./constants.js";
import type { RegionProps } from "./types.js";

/**
 * 侧边栏第二行「这个会话还没连任何控制面」那一句
 * @description ⚠️ **必须是一句人话而不是空串**：空串与「选了个名字是空的控制面」在屏上长得一样。
 */
const NO_MANAGER_TEXT = "未选控制面";

export function Sidebar(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  const rect = g.sidebar!;
  const handle = g.sidebarHandle;
  const inner = Math.max(0, rect.width - SIDEBAR_TEXT_X);
  const pad = " ".repeat(SIDEBAR_TEXT_X);
  const visible = props.sessions.slice(0, g.sidebarRows.length);
  const lines: React.JSX.Element[] = [];

  for (const item of visible) {
    const isSel = item.id === props.selectedSessionId;
    const isHot = item.id === props.hoveredSessionId;
    const bg = isHot ? tone(theme, "hover") : undefined;
    const name = ellipsis(item.name, inner);
    const manager = ellipsis(item.manager ?? NO_MANAGER_TEXT, inner);
    lines.push(
      // ⚠️ `flexDirection="column"` 必需：Ink 的 `<Box>` 默认是行，而行盒会把「名字」与「控制面名」
      // 排在同一行上。
      <Box
        key={item.id}
        flexDirection="column"
        width={rect.width}
        height={SESSION_ROWS}
        backgroundColor={bg}
      >
        <Box width={rect.width} height={1}>
          <Text>{pad}</Text>
          <Text color={tone(theme, isSel ? "selected" : "muted")} bold={isSel}>
            {name}
          </Text>
          {/* ⚠️ **补齐到整列**：不补的话短名字那一行右边那一截就没有底色 */}
          <Text>{" ".repeat(Math.max(0, inner - widthOf(name)))}</Text>
        </Box>
        <Box width={rect.width} height={1}>
          <Text>{pad}</Text>
          <Text color={tone(theme, isSel ? "selected" : "idle")} bold={isSel}>
            {manager}
          </Text>
          <Text>{" ".repeat(Math.max(0, inner - widthOf(manager)))}</Text>
        </Box>
      </Box>,
    );
  }

  const overflow = props.sessions.length - visible.length;
  if (overflow > 0) {
    lines.push(
      <Box key="of" width={rect.width} height={1}>
        <Text>{pad}</Text>
        <Text color={tone(theme, "warn")} dimColor>
          {ellipsis(`…还有 ${overflow} 个会话`, inner)}
        </Text>
      </Box>,
    );
  }

  return (
    // ⚠️ **底色只在这一列的 `<Box>` 上给一次**：Ink 让内层 `<Text>` 从父继承，而悬停的那一项自己
    // 再给一层 `hover`（⚠️ `hover` 必须**比 `surface` 深**，选色见 `@/ui/theme.ts`）。
    <Box
      flexDirection="column"
      width={rect.width}
      height={rect.height}
      backgroundColor={tone(theme, "surface")}
    >
      {lines}
      <Box flexGrow={1} />
      {/* ⚠️ **手柄画在最后**：它是最右那一列，与上面那些项**重叠**，而 Ink 后写的覆盖先写的。它的坐标
          与命中测试用的是同一个矩形（`@/app.tsx` 的 `down` 分支**先判手柄**）。 */}
      {handle === null || !props.handleHot ? null : (
        <Box
          position="absolute"
          left={handle.x}
          top={handle.y}
          width={handle.width}
          height={handle.height}
          backgroundColor={tone(theme, "hover")}
        />
      )}
    </Box>
  );
}