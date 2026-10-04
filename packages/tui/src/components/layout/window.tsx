/**
 * @fileoverview 模态窗口：浮在整屏正中的那一块（标题 + 分隔 + 若干行）；⚠️ **公共组件**，故高亮是**下标**而不是 `id`
 */

import { Box, Text } from "ink";
import {
  WINDOW_HEADER_INDENT,
  WINDOW_PADDING,
  ellipsis,
  widthOf,
  MAIN_TEXT_X,
} from "@/lib/index.js";
import { connectionMark } from "@/theme/index.js";
import { MARK_BLANK, MARK_SELECTED, tone } from "../constants.js";
import type { RegionProps } from "../types.js";

export function Window(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  const box = g.windowBox;
  const header = g.windowHeader;
  const content = g.windowContent;
  const title = g.windowTitle;
  if (box === null || header === null || content === null || title === null) return <Box />;
  const view = props.window!;
  const width = content.width;
  const pad = " ".repeat(WINDOW_PADDING);
  const sel = tone(theme, "selected");
  return (
    // ⚠️ **它没有框**：一块卡片浮在**极暗的遮罩**上，靠明暗差说「压在上面」 —— 一圈框线只会
    // 把它画成「另一个终端窗口」，而满屏接管之后屏上并没有别的窗口。
    <Box
      position="absolute"
      left={box.x}
      top={box.y}
      width={box.width}
      height={box.height}
      flexDirection="column"
      backgroundColor={tone(theme, "panel")}
    >
      {/* ⚠️ **上边那一格 padding 是一个 height 给定的空盒子**；左右两格归每一行自己的缩进 ——
          少这个盒子的话标题会落在卡片上缘、内容区整体上移一行（症状是「标题与遮罩之间没有缝」）。 */}
      <Box height={WINDOW_PADDING} flexShrink={0} />
      {/* ⚠️ **每一行铺满整块卡片**，而文字自己带那 {@link WINDOW_PADDING} 列缩进**（行盒窄一格的话
          那条分隔会超出一格而静默软换行，症状是「卡片里多出一行而下面那些行被挤出去」） */}
      {/* ⚠️ **标题的预算读 `windowTitle`**（几何层给的，已让开内区左缘与 `esc` 那几列）——
          在这里再减一次的话长标题压到 `esc` 上，症状是「标题末字被吃掉」。 */}
      <Box width={box.width} height={1}>
        <Text>{pad + " ".repeat(WINDOW_HEADER_INDENT)}</Text>
        <Text color={tone(theme, "accent")} bold>
          {ellipsis(view.title, title.width)}
        </Text>
      </Box>
      {/* ⚠️ **分隔那一行恒是 {@link MARK_SELECTED} 铺满内区**：它是这一块里唯一「既不是标题
          也不是可选行」的一行，而它铺满整行、可选行的记号只有左缘那一列。 */}
      <Box width={box.width} height={1}>
        <Text color={tone(theme, "idle")}>{pad + MARK_SELECTED.repeat(Math.max(0, width))}</Text>
      </Box>
      {g.windowNoteRow === null ? null : (
        <Box width={box.width} height={1}>
          <Text color={tone(theme, "muted")}>{pad + ellipsis(view.note ?? "", Math.max(0, width))}</Text>
        </Box>
      )}
      {view.rows.map((row, i) => {
        const rect = g.windowRows[i];
        if (rect === undefined) return null;
        const isAt = i === view.at;
        const mark = row.state === null ? null : connectionMark(row.state);
        // ⚠️ 名字与详情**逐段裁**：一段超宽会让整行超宽（Ink 静默软换行 → 卡片里多出一行，而卡片高度是
        // 几何层给的 → 下面那些行被挤出卡片）。⚠️ 名字的预算是**这一行的一半**，而「当前」那个记号
        // 占掉的 5 列**先扣掉** —— 少扣的后果是右边被吃掉一列。
        const tail = row.current ? " ←当前" : "";
        const room = Math.max(0, rect.width - widthOf(tail));
        const nameWidth = Math.min(widthOf(row.name), Math.floor(room / 2));
        return (
          <Box key={row.id} width={box.width} height={1}>
            <Text>{pad + " ".repeat(MAIN_TEXT_X)}</Text>
            <Text color={isAt ? sel : tone(theme, "idle")} bold={isAt}>
              {`${isAt ? MARK_SELECTED : MARK_BLANK} `}
            </Text>
            <Text color={isAt ? sel : tone(theme, "accent")} bold={isAt}>
              {ellipsis(row.name, nameWidth)}
            </Text>
            <Text color={isAt ? sel : tone(theme, "muted")} bold={isAt}>
              {ellipsis(
                ` ${mark === null ? "" : mark.glyph} ${row.detail}`,
                Math.max(0, room - nameWidth),
              )}
            </Text>
            {/* ⚠️ 右侧那个记号回答「**当前会话连的就是它吗**」—— 与高亮是两件事：高亮是
                「指针/键盘停在哪」，它是「已生效的是哪一台」。 */}
            {row.current ? (
              <Text color={sel} bold>
                {tail}
              </Text>
            ) : null}
          </Box>
        );
      })}
      {/* ⚠️ **卡片高度与内容行数无关**（几何层给的是「屏高一半」，见 `windowRect`），所以
          「标题 + 分隔 + 若干行」之后**未必**到卡片底边 —— 空盒子把剩下的留白吃干净。 */}
      <Box flexGrow={1} />
    </Box>
  );
}