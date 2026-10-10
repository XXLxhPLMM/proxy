/**
 * @fileoverview 「提供商 · 推理强度」那一行：输入框**框外**、底部状态行之上（flex 布局，不读几何层）
 */

import { Box, Text } from "ink";

import { tone } from "@/ui/components/index.js";
import type { RegionProps } from "@/ui/components/index.js";

/** 两段之间那一个分隔点（⚠️ 它自己一档：分隔符与两边的字不同色，屏上才读得出「这是两件事」） */
const SEPARATOR = " · ";

/** 这一会话还没选模型时给的那一句（⚠️ **不是空串**：空串与「名字是空的提供商」在屏上同形） */
const UNCHOSEN = "未选择";

export function ModelStatusLine(props: RegionProps): React.JSX.Element {
  const { theme } = props;
  const status = props.modelStatus;
  const chosen = status.provider !== null;
  const provider = status.provider ?? UNCHOSEN;
  return (
    // ⚠️ 缩进恒 3 列（= 左边框 1 + 提示符 2）：这一行在**框外**（左缘即主区左缘），而输入框的字在框线之内。
    // ⚠️ `inputFramed` 为假那一支今天走不到（这一行画得下时框恒画得下），故不再读几何层，直接写常量。
    // ⚠️ 提供商占满剩余列、超宽由 Ink 截断；分隔符与推理强度恒留（`flexShrink={0}`）。
    <Box flexDirection="row" alignItems="center" flexShrink={0} paddingLeft={3}>
      <Box flexGrow={1} flexShrink={1}>
        {/* ⚠️ **「没选模型」用中性那一档而选中用一个更暗的**：它是「这一格还没有值」而不是「值是这句话」。 */}
        <Text color={tone(theme, chosen ? "muted" : "idle")} wrap="truncate">
          {provider}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={tone(theme, "idle")} wrap="truncate">
          {SEPARATOR}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={tone(theme, "reasoning")} wrap="truncate">
          {status.reasoning}
        </Text>
      </Box>
    </Box>
  );
}