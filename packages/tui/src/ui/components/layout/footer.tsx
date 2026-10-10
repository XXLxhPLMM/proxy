/**
 * @fileoverview 底部状态行：左半是各状态的控制面台数，右半是版本号；⚠️ 它在输入框**框外**，左半**不显示链接**
 * （flex 布局，不读几何层）
 */

import { Box, Text } from "ink";
import { connectionMark, type ConnectionState, type Tone } from "@/ui/theme/index.js";
import { tone } from "../constants.js";
import type { RegionProps } from "../types.js";

/** 多段之间空的那几列 */
const FOOT_GAP = "  ";

/** 一段状态台数（字形 + 个数；色档由 {@link connectionMark} 给，本层不自己配颜色） */
interface StatusCount {
  readonly state: ConnectionState;
  readonly tone: Tone;
  readonly text: string;
}

export function Footer(props: RegionProps): React.JSX.Element {
  const { theme } = props;
  const right = props.version === "" ? "" : `v${props.version}`;
  const parts = statusCountParts(props.managerStates);
  return (
    // ⚠️ flex 分栏：左半占满剩余列、超宽由 Ink 截断；右半版本号恒留（`flexShrink={0}`）。
    // ⚠️ 窄屏下左半直接截断，不再按宽度换成「控制面清单见 /managers」：那要手算列宽。
    // ⚠️ 左缩进 2 列（= 原来的主区缩进）：框外行，左缘即主区左缘，flex 的 `paddingLeft` 给。
    <Box flexDirection="row" alignItems="center" flexShrink={0} paddingLeft={2}>
      <Box flexDirection="row" flexGrow={1} flexShrink={1}>
        {parts.length === 0 ? (
          <Text color={tone(theme, "muted")} dimColor wrap="truncate">
            台账里没有控制面
          </Text>
        ) : (
          <Text wrap="truncate">
            {parts.map((part, i) => (
              <Text key={part.state} color={tone(theme, part.tone)} wrap="truncate">
                {i === 0 ? part.text : FOOT_GAP + part.text}
              </Text>
            ))}
          </Text>
        )}
      </Box>
      {right === "" ? null : (
        <Box flexShrink={0} paddingLeft={1}>
          <Text color={tone(theme, "muted")} wrap="truncate">
            {right}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/** 各状态各几个（**顺序 = `connectionMark` 那张表的顺序**，而它按「处置动作」排过） */
// ⚠️ **零台的那些档不出现**：一个恒为 0 的「连接中 0」在一行里占两列、且看起来像「有东西在连接」。
// ⚠️ 同一个数有五种含义而处置动作各不相同，故**不许**合成一个不带档的总数。
function statusCountParts(states: readonly ConnectionState[]): StatusCount[] {
  const order: readonly ConnectionState[] = [
    "connected",
    "unauthorized",
    "unreachable",
    "connecting",
    "unknown",
  ];
  const counts = new Map<ConnectionState, number>();
  for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1);
  const parts: StatusCount[] = [];
  for (const state of order) {
    const count = counts.get(state) ?? 0;
    if (count === 0) continue;
    const mark = connectionMark(state);
    parts.push({ state, tone: mark.tone, text: `${mark.glyph} ${count}` });
  }
  return parts;
}