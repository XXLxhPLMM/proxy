/**
 * @fileoverview 底部状态行：左半是各状态的控制面台数，右半是版本号；⚠️ 它在输入框**框外**，左半**不显示链接**
 */

import { Box, Text } from "ink";
import { widthOf, MAIN_TEXT_X } from "@/lib/index.js";
import { connectionMark, type ConnectionState, type Tone } from "@/theme/index.js";
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
  const { g, theme } = props;
  const row = g.statusLine;
  if (row === null) return <Box />;
  const right = props.version === "" ? "" : `v${props.version}`;
  const parts = statusCountParts(props.managerStates);
  const used =
    parts.reduce((sum, part) => sum + widthOf(part.text), 0) +
    (parts.length > 1 ? FOOT_GAP.length * (parts.length - 1) : 0);
  // ⚠️ 左半按右半占掉的宽裁：反过来（先裁左半再补右半）在窄终端里就是「先牺牲各状态的台数」，而
  // 那是操作者判断「有几台要处理」的唯一一屏信息。
  const budget = Math.max(0, row.width - MAIN_TEXT_X - widthOf(right) - (right === "" ? 0 : 1));
  // ⚠️ **装不下就整块换成一句话**，而不是半截的台数：那个 `● 3` 是哪三个 3 会被读成「全部」。
  const fits = parts.length > 0 && used <= budget;
  const fallback =
    props.managerStates.length === 0 ? "台账里没有控制面" : "控制面清单见 /managers";
  const shown = fits ? used : widthOf(fallback);
  return (
    <Box width={row.width} height={row.height}>
      <Text>{" ".repeat(MAIN_TEXT_X)}</Text>
      {fits
        ? parts.map((part, i) => (
            <Text key={part.state} color={tone(theme, part.tone)}>
              {i === 0 ? part.text : FOOT_GAP + part.text}
            </Text>
          ))
        : (
            <Text color={tone(theme, "muted")} dimColor>
              {fallback}
            </Text>
          )}
      <Text>{" ".repeat(Math.max(0, budget - shown))}</Text>
      <Text color={tone(theme, "muted")}>{right}</Text>
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