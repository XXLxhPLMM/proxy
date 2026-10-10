/**
 * @fileoverview 命令面板：跟在结果区之后、输入框之前的一小块；⚠️ 高度**由内容行数自然撑起**，不再按几何层的视口定高
 */

import { Box, Text } from "ink";
import { MAIN_TEXT_X } from "@/ui/components/index.js";
import { MARK_BLANK, MARK_SELECTED, tone } from "@/ui/components/index.js";
import type { RegionProps } from "@/ui/components/index.js";

export function CommandPalette(props: RegionProps): React.JSX.Element {
  const { theme } = props;
  const view = props.palette;
  // ⚠️ **只剩这一个判据**：面板没开就整个不画（视口切窗口由状态层做好，见 `PaletteView.rows`）。
  if (view === null) return <Box />;
  const sel = tone(theme, "selected");
  return (
    <Box flexDirection="column" flexShrink={0}>
      {view.rows.map((row, i) => {
        const isAt = i === view.at;
        return (
          <Box
            key={`${row.text}:${String(i)}`}
            flexDirection="row"
            flexShrink={0}
            paddingLeft={MAIN_TEXT_X}
          >
            <Box flexShrink={0}>
              <Text color={isAt ? sel : tone(theme, "idle")} bold={isAt}>
                {`${isAt ? MARK_SELECTED : MARK_BLANK} `}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              {/* ⚠️ 三段（记号 / 名字 / 说明）**同一个色档且同样加粗**：拆开的话「哪一行被选中」
                  要跨三段去拼，而高亮那一行是这块面板唯一的交互。
                  ⚠️ 一行只截一次：名字与说明包在同一个 `truncate` 里，超宽由 Ink 裁，
                  不再按列宽手算预算与对齐。 */}
              <Text wrap="truncate">
                <Text color={isAt ? sel : tone(theme, "accent")} bold={isAt} wrap="truncate">
                  {row.text}
                </Text>
                {row.summary === null ? null : (
                  <Text color={isAt ? sel : tone(theme, "muted")} bold={isAt} wrap="truncate">
                    {` ${row.summary}`}
                  </Text>
                )}
              </Text>
            </Box>
          </Box>
        );
      })}
      {view.footer === null ? null : (
        <Box flexDirection="row" flexShrink={0} paddingLeft={MAIN_TEXT_X}>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={tone(theme, "warn")} dimColor wrap="truncate">
              {view.footer}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
