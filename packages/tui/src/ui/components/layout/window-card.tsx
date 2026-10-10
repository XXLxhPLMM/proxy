/**
 * 模态卡片那块**外壳**（全屏 overlay 上的 flex 居中 + 圆角框 + 标题/esc 同行 + 内容）；⚠️ 五种内容共用它
 */

import { Box, Text } from "ink";

import {
  WINDOW_FULL_WIDTH_BELOW,
  WINDOW_MIN_WIDTH,
  WINDOW_WIDTH_RATIO,
} from "../constants.js";
import type { Theme } from "@/ui/theme/index.js";
import { tone } from "../constants.js";
import { CloseChip } from "./close-chip.js";

/** 外壳的入参 */
export interface WindowCardProps {
  readonly theme: Theme;
  /** 终端列数（卡片定宽只读它，与「放在哪」无关 ⇒ 不算居中坐标） */
  readonly columns: number;
  /** 「窗口叫什么」那几个字（超宽由 Ink 截断） */
  readonly label: string;
  /** 右端画不画那枚 `esc`（读状态层算好的那一份 `ModalView.closeHint`） */
  readonly closeHint: boolean;
  readonly children: React.ReactNode;
}

/** 卡片定宽（比例是上限、下限保底，窄屏占满） */
// ⚠️ 只读终端列数：宽与「放在哪」无关。
function cardWidth(columns: number): number {
  const w = Math.max(0, Math.trunc(columns));
  if (w < WINDOW_FULL_WIDTH_BELOW) return w;
  return Math.max(WINDOW_MIN_WIDTH, Math.round(w * WINDOW_WIDTH_RATIO));
}

/**
 * 模态卡片：一块**占满父容器的绝对定位 overlay** + 居中的圆角卡片 + 标题行 + `children`
 * @description 外壳**不认识**里面是什么：五档内容渲染器共用它，而它们互不 import
 * （`@/ui/features/AGENTS.md`「组件之间不认识」）—— 故这里一个视图都不提。
 */
export function WindowCard(props: WindowCardProps): React.JSX.Element {
  const { theme } = props;
  return (
    // ⚠️ 「放在正中」由 flex 给（`justifyContent` + `alignItems`）。
    // ⚠️ `overflow="hidden"` 把超高的内容裁在屏内：卡片高度由内容驱动。
    <Box
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      overflow="hidden"
    >
      <Box
        flexDirection="column"
        flexShrink={0}
        width={cardWidth(props.columns)}
        borderStyle="round"
        borderColor={tone(theme, "idle")}
        padding={1}
        backgroundColor={tone(theme, "panel")}
      >
        {/* ⚠️ 标题与 esc 同行、`space-between` 分居两端。
            标题超宽由 Ink 截断（`truncate` 恒是一行），esc 那一枚 `flexShrink={0}` 恒留。 */}
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexShrink={0}>
          <Box flexDirection="row" flexGrow={1} flexShrink={1}>
            <Text color={tone(theme, "accent")} bold wrap="truncate">
              {props.label}
            </Text>
          </Box>
          {props.closeHint ? (
            <Box flexShrink={0} paddingLeft={1}>
              <CloseChip theme={theme} />
            </Box>
          ) : null}
        </Box>
        {props.children}
      </Box>
    </Box>
  );
}

/** 内容区里**一行**（flex 行盒；超宽由里面的 `<Text wrap="truncate">` 截断，本层不补留白） */
export function SlotLine(props: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <Box flexDirection="row" flexShrink={0}>
      {props.children}
    </Box>
  );
}
