/**
 * @fileoverview 命令面板：浮在输入框正上方的一小块；⚠️ 高度**由几何层给**，一算就会与命中测试差一行
 */

import { Box, Text } from "ink";
import { MAIN_TEXT_X, ellipsis, padToWidth, widthOf } from "@/lib/index.js";
import { MARK_BLANK, MARK_SELECTED, tone } from "@/components/index.js";
import type { RegionProps } from "@/components/index.js";

export function CommandPalette(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  if (g.output === null) return <Box />;
  const view = props.palette!;
  const width = g.outputWidth;
  // ⚠️ **预算一次算清**：`缩进 2 + 记号 1 + 空隙 1` 是命令名之前的固定开销，命令名与说明之间再留 1；
  // 少算任意一项的结果不是「被裁短」而是**整行超宽**。
  const budget = Math.max(0, width - MAIN_TEXT_X - 3);
  // ⚠️ 名字预算是「这一屏最长的那个名字」且**不超过一半**：按整表最长的名字留预算，短名字那一屏
  // 会白扔半行。⚠️ 说明按同一行的名字宽度对齐（`padToWidth` 按**显示列**补），否则这一列跟着跳。
  const longest = view.rows.reduce((widest, row) => Math.max(widest, widthOf(row.text)), 0);
  const nameWidth = Math.min(longest, Math.floor(budget / 2));
  const summaryWidth = budget - nameWidth;
  const sel = tone(theme, "selected");
  const height = view.rows.length + (view.footer === null ? 0 : 1);
  return (
    <Box flexDirection="column" width={g.output.width} height={height}>
      {view.rows.map((row, i) => {
        const isAt = i === view.at;
        return (
          <Box key={`${row.text}:${i}`} width={width} height={1}>
            <Text>{" ".repeat(MAIN_TEXT_X)}</Text>
            {/* ⚠️ 三段（记号 / 名字 / 说明）**同一个色档且同样加粗**：拆开的话「哪一行被选中」
                要跨三段去拼，而高亮那一行是这块面板唯一的交互。 */}
            <Text color={isAt ? sel : tone(theme, "idle")} bold={isAt}>
              {`${isAt ? MARK_SELECTED : MARK_BLANK} `}
            </Text>
            <Text color={isAt ? sel : tone(theme, "accent")} bold={isAt}>
              {padToWidth(ellipsis(row.text, nameWidth), nameWidth, "left")}
            </Text>
            <Text color={isAt ? sel : tone(theme, "muted")} bold={isAt}>
              {row.summary === null ? "" : ` ${ellipsis(row.summary, summaryWidth)}`}
            </Text>
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