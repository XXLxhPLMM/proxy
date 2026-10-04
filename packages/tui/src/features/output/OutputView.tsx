/** 结果区那一块：可滚的结果文本 + 底部那一行滚动/丢弃提示（宽与高都来自几何层） */

import { Box, Text } from "ink";
import { visibleLines, type LogLine } from "@/lib/log/index.js";
import { MAIN_TEXT_X, ellipsis } from "@/lib/index.js";
import type { Tone } from "@/theme/index.js";
import { ECHO_PREFIX, tone } from "@/components/index.js";
import type { RegionProps } from "@/components/index.js";

/** 结果区每类行的默认色档 */
const TONE_OF: Record<LogLine["kind"], Tone> = {
  echo: "accent",
  head: "accent",
  kv: "muted",
  table: "muted",
  note: "warn",
  err: "danger",
};

export function OutputView(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  if (g.output === null) return <Box />;
  const width = g.outputWidth;
  const lines = visibleLines(props.flat, props.top, g.outputRows);
  const below = Math.max(0, props.flat.height - (props.top + g.outputRows));
  const above = Math.max(0, props.top);
  // ⚠️ **高度 = 几何层给的「结果文本 + 滚动提示」那一块**（`outputBlockRows`），而**不是**
  // `outputRows + 1`：极矮的屏上两者都是 0，`+ 1` 会画一行溢出到输入区上面。
  const height = g.outputBlockRows;
  return (
    <Box flexDirection="column" width={g.output.width} height={height}>
      <Box flexDirection="column" width={width} height={g.outputRows}>
        {lines.map((line, i) => (
          <Text key={`${line.entryId}:${line.part}:${i}`} color={tone(theme, TONE_OF[line.kind])}>
            {ellipsis(line.kind === "echo" ? `${ECHO_PREFIX}${line.text}` : line.text, width)}
          </Text>
        ))}
      </Box>
      {height > 0 ? (
        <Box width={width} height={1}>
          <Text>{" ".repeat(MAIN_TEXT_X)}</Text>
          <Text
            color={tone(theme, below > 0 || above > 0 ? "warn" : "muted")}
            dimColor={below === 0}
          >
            {ellipsis(scrollHintOf(above, below, props.droppedHint), Math.max(0, width - MAIN_TEXT_X))}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** 结果区底部那一行（**永远在**：它是唯一区分「已到底」与「下面还有内容」的地方） */
// ⚠️ **位置**与**丢弃声明**是两句独立的话，先算位置再缀丢弃。
function scrollHintOf(above: number, below: number, droppedHint: string | null): string {
  const position =
    above > 0 && below > 0
      ? `上 ${above} 行 · 下 ${below} 行`
      : above > 0
        ? `上方还有 ${above} 行 · PgUp / 滚轮上翻`
        : below > 0
          ? `下方还有 ${below} 行 · PgDn / 滚轮下翻`
          : "已到底";
  return droppedHint === null ? `⇅ ${position}` : `⇅ ${position} · ${droppedHint}`;
}