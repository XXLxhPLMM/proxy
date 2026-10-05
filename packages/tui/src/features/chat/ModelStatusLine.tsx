/**
 * @fileoverview 「提供商 · 推理强度」那一行：输入框**框外**、底部状态行之上；⚠️ 画不画读几何层
 */

import { Box, Text } from "ink";

import { BORDER_LEFT_COLUMN, PROMPT_COLUMNS, ellipsis, widthOf } from "@/lib/index.js";
import { tone } from "@/components/index.js";
import type { RegionProps } from "@/components/index.js";

/** 两段之间那一个分隔点（⚠️ 它自己一档：分隔符与两边的字不同色，屏上才读得出「这是两件事」） */
const SEPARATOR = " · ";

/** 这一会话还没选模型时给的那一句（⚠️ **不是空串**：空串与「名字是空的提供商」在屏上同形） */
const UNCHOSEN = "未选择";

export function ModelStatusLine(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  const row = g.modelStatus;
  // ⚠️ **`null` 就是判据**：极矮的屏上先丢的是这一行而不是输入框（框里每一行都要过一次回车），
  // 而本层**不自己比一次**高度 —— 与 `inputNotice` 同一纪律。
  if (row === null) return <Box />;
  const status = props.modelStatus;
  const chosen = status.provider !== null;
  // ⚠️ **缩进恒比输入区那个宽度多出左边框那一列**：这一行在**框外**（它的左缘就是主区左缘），
  // 而输入框那些字的左缘在**框线之内** ⇒ 少算这一列的话两行字差一列。
  const indent = (g.inputFramed ? BORDER_LEFT_COLUMN : 0) + PROMPT_COLUMNS;
  // ⚠️ **提供商名与推理强度必须各留出预算**：少留的那一段会被推出右缘 ⇒ **整行超宽** ⇒
  // Ink 静默软换行（这一行会占两行，而框与状态行被顶下去一格）。
  const room = Math.max(0, row.width - indent - widthOf(SEPARATOR) - widthOf(status.reasoning));
  const provider = ellipsis(status.provider ?? UNCHOSEN, room);
  return (
    <Box width={row.width} height={row.height}>
      {/* ⚠️ **`inputFramed` 那一支今天是走不到的**（框画得下 ⟺ `inputHeight ≥ 3`，而这一行画得下时
          `inputHeight ≥ 4`）—— 它留着是因为**真走到时**那一框没有左边框，而那时少一列就是错的。 */}
      <Text>{" ".repeat(indent)}</Text>
      {/* ⚠️ **「没选模型」用中性那一档而选中用一个更暗的**：它是「这一格还没有值」而不是「值是这句话」，
          两者同色的话屏上分不出「选了它」与「默认就是它」。 */}
      <Text color={tone(theme, chosen ? "muted" : "idle")}>{provider}</Text>
      <Text color={tone(theme, "idle")}>{SEPARATOR}</Text>
      <Text color={tone(theme, "reasoning")}>{status.reasoning}</Text>
    </Box>
  );
}