/**
 * @fileoverview 结果区那一块：可滚的结果文本 + 底部那一行滚动/丢弃提示
 * @module view/components/output
 * @description 宽与高都来自几何层；本组件只负责把 {@link @/log/index.js:visibleLines} 的那几行摆出来。
 * @module
 */

import { Box, Text } from "ink";
import { visibleLines, type LogLine } from "@/log/index.js";
import { ellipsis } from "@/ui/format.js";
import type { Tone } from "@/ui/theme.js";
import { MAIN_TEXT_X } from "../geometry.js";
import { ECHO_PREFIX, tone } from "./constants.js";
import type { RegionProps } from "./types.js";

/** 结果区每类行的默认色档 */
const TONE_OF: Record<LogLine["kind"], Tone> = {
  echo: "accent",
  head: "accent",
  kv: "muted",
  table: "muted",
  note: "warn",
  err: "danger",
};

export function Output(props: RegionProps): React.JSX.Element {
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

/**
 * 结果区底部那一行
 * @description ⚠️ 「已到底」与「下面还有内容没显示」在屏幕上长得**完全一样**，而这一行是唯一区分
 * 它们的地方 —— 故它**永远在**。⚠️ **位置**与**丢弃声明**是两句独立的话，先算位置再缀丢弃：
 * 反过来会在**顶部**那一帧说「上翻」。
 */
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