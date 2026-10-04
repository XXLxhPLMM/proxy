/**
 * @fileoverview 左侧那一列：会话清单（每项两行 + 项间那一行间隔）+ 名字前面那枚记号 + 悬停时的「✕」 + 最右那一列的拖宽手柄
 */

import { Box, Text } from "ink";

import {
  SESSION_CLOSE_COLUMNS,
  SESSION_GAP_ROWS,
  SESSION_MARK_COLUMNS,
  SESSION_ROWS,
  SIDEBAR_TEXT_X,
  ellipsis,
  widthOf,
} from "@/lib/index.js";
import { tone } from "@/components/index.js";
import type { RegionProps } from "@/components/index.js";
import type { RunState } from "@/store/index.js";

/** 侧边栏第二行「这个会话还没连任何控制面」那一句 */
// ⚠️ **必须是一句人话而不是空串**：空串与「选了个名字是空的控制面」在屏上长得一样。
const NO_MANAGER_TEXT = "未选控制面";

/** 那一枚「关掉它」的字形 */
// ⚠️ `✕` 的 East Asian Width 是 **Ambiguous**：按 CJK 宽度渲染的终端里它是两列，故它落在那一格的
// **左缘** —— 右缘会越过预算吃掉间隔列。
const CLOSE_GLYPH = "✕";

/** 名字前面那枚记号（⚠️ `idle` **是一个空格**而不是空串：那一格恒存在，而两帧的列位必须一样） */
const RUN_GLYPHS: Readonly<Record<RunState, string>> = {
  idle: " ",
  running: "⠋",
  done: "✔",
};

export function SessionSidebar(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  const rect = g.sidebar!;
  const handle = g.sidebarHandle;
  const inner = Math.max(0, rect.width - SIDEBAR_TEXT_X);
  const pad = " ".repeat(SIDEBAR_TEXT_X);
  /** 记号位恒占 {@link SESSION_MARK_COLUMNS} 列，而 {@link SESSION_MARK_COLUMNS} − 1 那一列**恒是空隙** */
  const markGap = " ".repeat(Math.max(0, SESSION_MARK_COLUMNS - 1));
  /** 会话名的裁剪预算（**恒**扣掉关闭那两列与记号那两列） */
  const nameWidth = Math.max(0, inner - SESSION_CLOSE_COLUMNS - SESSION_MARK_COLUMNS);
  // ⚠️ 第一项是第 `sessionFirst` 个会话：切片与取值都加它，漏一处就是「画第三项、点第一项」
  const first = g.sessionFirst;
  const visible = props.sessions.slice(first, first + g.sidebarRows.length);
  const lines: (React.JSX.Element | null)[] = [];
  const closeChips: React.JSX.Element[] = [];

  for (const [i, item] of visible.entries()) {
    const isSel = item.id === props.selectedSessionId;
    const isHot = item.id === props.hoveredSessionId;
    const bg = isHot ? tone(theme, "hover") : undefined;
    const name = ellipsis(item.name, nameWidth);
    const manager = ellipsis(item.manager ?? NO_MANAGER_TEXT, inner - SESSION_MARK_COLUMNS);
    const fill = Math.max(0, inner - SESSION_MARK_COLUMNS - widthOf(name));
    lines.push(
      // ⚠️ **间隔在两项之间**（第一项**上面没有**）：几何给的是 `i * SESSION_STRIDE`，而这里必须补
      // **同样多**的空行 —— 少一个盒子的话下面每一项都比几何给的行号高一行，症状是「点第二项切到了
      // 第三项」而屏上看着完全正常。
      i === 0 ? null : (
        <Box key={`gap-${item.id}`} height={SESSION_GAP_ROWS} flexShrink={0} />
      ),
      // ⚠️ `flexDirection="column"` 必需：Ink 的 `<Box>` 默认是行，而行盒会把「名字」与
      // 「控制面名」排在同一行上。
      <Box
        key={item.id}
        flexDirection="column"
        width={rect.width}
        height={SESSION_ROWS}
        backgroundColor={bg}
      >
        <Box width={rect.width} height={1}>
          <Text>{pad}</Text>
          {/* ⚠️ **记号与名字同一档**：它是「这个会话在干什么」的一部分，不是一句独立的提示 */}
          <Text color={tone(theme, isSel ? "selected" : "muted")}>
            {`${RUN_GLYPHS[item.run]}${markGap}`}
          </Text>
          <Text color={tone(theme, isSel ? "selected" : "muted")} bold={isSel}>
            {name}
          </Text>
          {/* ⚠️ **补齐到整列**：不补的话短名字那一行右边那一截就没有底色 */}
          <Text>{" ".repeat(fill)}</Text>
        </Box>
        {/* ⚠️ 第二行**恒不参与选中高亮**：它答的是「打给谁」，而「我选了哪一个会话」由第一行回答 ——
            两行都高亮的话，「这一项被选中了」与「它连着的那台是当前那台」在屏上读起来一样。 */}
        <Box width={rect.width} height={1}>
          <Text>{pad}</Text>
          <Text>{" ".repeat(SESSION_MARK_COLUMNS)}</Text>
          <Text color={tone(theme, "idle")}>{manager}</Text>
          <Text>{" ".repeat(Math.max(0, inner - SESSION_MARK_COLUMNS - widthOf(manager)))}</Text>
        </Box>
      </Box>,
    );

    // ⚠️ **只有悬停的那一项**画这一枚，而它的**命中区域不看悬停**：指针落在上面就说明它悬在那儿，
    // 而悬停状态来自**上一次 move 事件** —— 一次没有 move 的点击会带着过期的悬停状态进来。
    const slot = g.sidebarCloseRows[i];
    if (!isHot || slot === null || slot === undefined) continue;
    closeChips.push(
      <Box
        key={`x-${item.id}`}
        position="absolute"
        left={slot.x}
        top={slot.y}
        width={slot.width}
        height={slot.height}
        backgroundColor={bg}
      >
        {/* ⚠️ 底色给的是**外层这个 `<Box>`**（`<Text>` 从最近的带底色的祖先继承，而那一层正是它）。
            ⚠️ 色档：悬在上面给 `danger`（全包唯一读作「别按」的一档），只是**露出来**给 `muted` ——
            否则一枚没指着的按钮比它要关掉的那一项还亮。 */}
        <Text color={props.sessionCloseHot ? tone(theme, "danger") : tone(theme, "muted")}>
          {CLOSE_GLYPH}
        </Text>
      </Box>,
    );
  }

  // ⚠️ 「第几–第几 / 共 n 个」**数字排在最前**，于是最窄那一档被裁掉的是「一共几个」而范围仍读得出来。
  const overflowRow = g.sidebarOverflowRow;
  const overflow =
    overflowRow === null
      ? null
      : (
        <Box key="of" width={rect.width} height={1}>
          <Text>{pad}</Text>
          <Text color={tone(theme, "warn")} dimColor>
            {ellipsis(
              `${String(first + 1)}–${String(first + visible.length)} / 共 ${String(props.sessions.length)}`,
              inner,
            )}
          </Text>
        </Box>
      );

  return (
    // ⚠️ **底色只在这一列的 `<Box>` 上给一次**（内层 `<Text>` 从父继承，而悬停的那一项自己再给一层
    // `hover`，⚠️ `hover` 必须**比 `surface` 深**，选色见 `@/theme/index.js`）。
    <Box
      flexDirection="column"
      width={rect.width}
      height={rect.height}
      backgroundColor={tone(theme, "surface")}
    >
      {lines}
      {/* ⚠️ **这一行说明贴着侧边栏最底下**：`flexGrow` 把它推到最后一格，而几何给的
          `sidebarOverflowRow` 恒是 `h - 1`，两者是同一个数。 */}
      <Box flexGrow={1} />
      {overflow}
      {/* ⚠️ **「✕」与手柄都排在最后**：两者都是绝对定位、与上面那些项**重叠**，靠「后来者赢」压上去。
          ⚠️ 彼此不重叠，与命中测试里「手柄 → 菜单 → 「✕」 → 会话项」那个先判次序对上。 */}
      {closeChips}
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