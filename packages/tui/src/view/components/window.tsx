/**
 * @fileoverview 模态窗口：浮在整屏正中的那一块（标题 + 若干行 + 可选的一条底部说明）
 * @module view/components/window
 * @description
 * ⚠️ **公共组件**：它只画「标题 / 若干行（名字 + 详情）/ 一条说明」，每一行是什么由调用方排好版
 * （{@link ./types.js:WindowRow}）。下一个窗口（改密码、账号）要的形状与它一样，故抽出来 ——
 * 而抽出来的**代价**是它不能认识自己的内容，故「哪一行高亮」是**下标**而不是 `id`。
 * @module
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
  if (box === null || content === null) return <Box />;
  const view = props.window!;
  const width = content.width;
  const sel = tone(theme, "selected");
  return (
    // ⚠️ **底色比背后的 `scrim` 更深**（`panel`，选色见 `@/ui/theme.ts`）—— 于是窗口是那块画面上最重的
    // 地方，这就是「浮在上面」在纯文本终端里的全部手段。⚠️ 与右上角那枚 `esc` 是**两个绝对定位的
    // 兄弟**，顺序由组合出口定（{@link ./layout.tsx}）。
    <Box
      position="absolute"
      left={box.x}
      top={box.y}
      width={box.width}
      height={box.height}
      flexDirection="column"
      borderStyle="round"
      borderColor={tone(theme, "accent")}
      backgroundColor={tone(theme, "panel")}
    >
      <Box width={width} height={1}>
        <Text>{" ".repeat(MAIN_TEXT_X)}</Text>
        <Text color={tone(theme, "accent")} bold>
          {ellipsis(view.title, Math.max(0, width - MAIN_TEXT_X))}
        </Text>
      </Box>
      {view.rows.map((row, i) => {
        const rect = g.windowRows[i];
        if (rect === undefined) return null;
        const isAt = i === view.at;
        const mark = row.state === null ? null : connectionMark(row.state);
        // ⚠️ 名字与详情**逐段裁**：一段超宽会让整行超宽（Ink 静默软换行 → 窗口里多出一行，而窗口高度是
        // 几何层给的 → 底部那行说明被挤出框外）。⚠️ 名字的预算是**这一行的一半**（详情里有地址），
        // 而「当前」那个记号占掉的 5 列**先扣掉** —— 少扣的后果是右边框被吃掉一列。
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