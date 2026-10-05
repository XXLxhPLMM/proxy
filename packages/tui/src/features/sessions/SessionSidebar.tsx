/**
 * @fileoverview 左侧那一列：会话清单（顶部留白 + 每项两行 + 项间那一行间隔）+ 名字前面那枚记号 + 悬停时的「✕」 + 拖宽手柄
 */
// ⚠️ **记号不吃选中色**（名字吃）：「我选了哪一项」与「它在干什么」是两个事实，共用一档色时屏上只剩一个。
// 代价是 `idle` 那一项被选中时记号看着是暗的 —— 而那正是它该有的样子：它没在跑。
import { Box, Text } from "ink";

import {
  SESSION_CLOSE_COLUMNS,
  SESSION_GAP_ROWS,
  SESSION_MARK_COLUMNS,
  SESSION_ROWS,
  SIDEBAR_TEXT_X,
  SIDEBAR_TOP_PAD_ROWS,
  ellipsis,
  widthOf,
} from "@/lib/index.js";
import { tone } from "@/components/index.js";
import type { RegionProps } from "@/components/index.js";
import { runMarkOf } from "@/theme/index.js";

/** 侧边栏第二行「这个会话还没连任何控制面」那一句 */
// ⚠️ **必须是一句人话而不是空串**：空串与「选了个名字是空的控制面」在屏上长得一样。
const NO_MANAGER_TEXT = "未选控制面";

/** 那一枚「关掉它」的字形 */
// ⚠️ `✕` 的 East Asian Width 是 **Ambiguous**：按 CJK 宽度渲染的终端里它是两列，故它落在那一格的
// **左缘** —— 右缘会越过预算吃掉间隔列。
const CLOSE_GLYPH = "✕";

export function SessionSidebar(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  const rect = g.sidebar!;
  const handle = g.sidebarHandle;
  const inner = Math.max(0, rect.width - SIDEBAR_TEXT_X);
  /** 记号位恒占 {@link SESSION_MARK_COLUMNS} 列，两侧**等宽** —— 那一格宽是奇数才排得出「居中」 */
  const markPad = " ".repeat(Math.floor(SESSION_MARK_COLUMNS / 2));
  /** 记号位与「名字起画的那一列」是**同一批列**（{@link SIDEBAR_TEXT_X}），故空记号位就是那一份缩进 */
  const pad = " ".repeat(SIDEBAR_TEXT_X);
  /** 会话名的裁剪预算（**恒**扣掉记号那几列与关闭那 {@link SESSION_CLOSE_COLUMNS} 列） */
  const nameWidth = Math.max(0, rect.width - SESSION_MARK_COLUMNS - SESSION_CLOSE_COLUMNS);
  // ⚠️ 第一项是第 `sessionFirst` 个会话：切片与取值都加它，漏一处就是「画第三项、点第一项」
  const first = g.sessionFirst;
  const visible = props.sessions.slice(first, first + g.sidebarRows.length);
  const lines: (React.JSX.Element | null)[] = [
    // ⚠️ **顶部那一份留白必须真的画出来**：少这个盒子每一项都比几何给的行号高一行，而症状是
    // 「点第二项切到了第三项」——屏上看着完全正常。
    <Box key="pad" height={SIDEBAR_TOP_PAD_ROWS} flexShrink={0} />,
  ];
  const closeChips: React.JSX.Element[] = [];

  for (const [i, item] of visible.entries()) {
    const isSel = item.id === props.selectedSessionId;
    const isHot = item.id === props.hoveredSessionId;
    const bg = isHot ? tone(theme, "hover") : undefined;
    const name = ellipsis(item.name, nameWidth);
    const manager = ellipsis(item.manager ?? NO_MANAGER_TEXT, inner);
    const fill = Math.max(0, inner - widthOf(name));
    const mark = runMarkOf(item.run, item.seen);
    lines.push(
      // ⚠️ **间隔在两项之间**：几何给的是 `SIDEBAR_TOP_PAD_ROWS + i * SESSION_STRIDE`，而这里必须补
      // **同样多**的空行 —— 少一个盒子的话下面每一项都比几何给的行号高一行。
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
          {/* ⚠️ **色档读自己的那一份**（{@link runMarkOf}），名字才吃选中那一档：见文件头。
              ⚠️ 记号位恒是 `markPad + 字形 + markPad` 那 {@link SESSION_MARK_COLUMNS} 列 ——
              `idle` 的字形是一个空格，故三档的**列位相同**，而名字不会在两帧之间跳。 */}
          <Text color={tone(theme, mark.tone)}>{`${markPad}${mark.glyph}${markPad}`}</Text>
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
          <Text color={tone(theme, "idle")}>{manager}</Text>
          <Text>{" ".repeat(Math.max(0, inner - widthOf(manager)))}</Text>
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