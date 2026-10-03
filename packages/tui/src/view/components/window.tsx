/**
 * @fileoverview 模态窗口：浮在整屏正中的那一块（标题 + 若干行 + 可选的一条底部说明）；⚠️ **公共组件**，故高亮是**下标**而不是 `id`
 */

import { Box, Text } from "ink";
import { connectionMark } from "@/ui/theme.js";
import { ellipsis, widthOf } from "@/ui/format.js";
import { MAIN_TEXT_X } from "../geometry.js";
import { MARK_BLANK, MARK_SELECTED, tone } from "./constants.js";
import type { RegionProps } from "./types.js";

export function Window(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  const box = g.windowBox;
  const content = g.windowContent;
  const title = g.windowTitle;
  if (box === null || content === null || title === null) return <Box />;
  const view = props.window!;
  const width = content.width;
  const sel = tone(theme, "selected");
  return (
    // ⚠️ **它没有框**：一块**深色卡片**浮在**浅色遮罩**上，靠明暗差说「压在上面」 —— 一圈框线只会
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
      {/* ⚠️ **标题的预算读 `windowTitle`**（几何层给的，已把 `esc` 那几列让出来）—— 在这里
          再减一次的话长标题压到 `esc` 上，症状是「标题末字被吃掉」。 */}
      <Box width={width} height={1}>
        <Text>{" ".repeat(MAIN_TEXT_X)}</Text>
        <Text color={tone(theme, "accent")} bold>
          {ellipsis(view.title, title.width)}
        </Text>
      </Box>
      {view.rows.map((row, i) => {
        const rect = g.windowRows[i];
        if (rect === undefined) return null;
        const isAt = i === view.at;
        const mark = row.state === null ? null : connectionMark(row.state);
        // ⚠️ 名字与详情**逐段裁**：一段超宽会让整行超宽（Ink 静默软换行 → 卡片里多出一行，而卡片高度是
        // 几何层给的 → 底部那行说明被挤出卡片）。⚠️ 名字的预算是**这一行的一半**，而「当前」那个记号
        // 占掉的 5 列**先扣掉** —— 少扣的后果是右边被吃掉一列。
        const tail = row.current ? " ←当前" : "";
        const room = Math.max(0, rect.width - widthOf(tail));
        const nameWidth = Math.min(widthOf(row.name), Math.floor(room / 2));
        return (
          <Box key={row.id} width={width} height={1}>
            <Text>{" ".repeat(MAIN_TEXT_X)}</Text>
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
          「标题 + 若干行」之后**未必**紧跟着说明那一行 —— 用 `flexGrow` 的空盒子把说明**顶到卡片
          底边**，少它的话两行控制面时说明会浮在卡片中间而下面空着一大片。 */}
      <Box flexGrow={1} />
      {view.footer === null ? null : (
        <Box width={width} height={1}>
          <Text color={tone(theme, "warn")} dimColor>
            {" ".repeat(MAIN_TEXT_X)}
            {ellipsis(view.footer, Math.max(0, width - MAIN_TEXT_X))}
          </Text>
        </Box>
      )}
    </Box>
  );
}