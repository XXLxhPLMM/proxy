/**
 * 模态卡片那块**外壳**（内边距 + 标题 + 一道分隔 + 内容 + 底部留白）；⚠️ 七种内容共用它
 */

import { Box, Text } from "ink";

import {
  WINDOW_HEADER_INDENT,
  WINDOW_PADDING,
  ellipsis,
  type Geometry,
  type Rect,
} from "@/lib/index.js";
import type { Theme } from "@/theme/index.js";
import { MARK_SELECTED, tone } from "../constants.js";

/** 外壳的入参（⚠️ **没有一个字段是坐标**：位置全在 `g` 里，而 `g` 由几何层算） */
export interface WindowCardProps {
  readonly g: Geometry;
  readonly theme: Theme;
  /** 「窗口叫什么」那几个字（裁剪读 `g.windowTitle`，它已经让开右上角那一枚） */
  readonly label: string;
  readonly children: React.ReactNode;
}

/**
 * 模态卡片：一个**绝对定位**的 `<Box>` + 上边那格空盒 + 标题 + 分隔 + `children` + 底部留白
 * @description 外壳**不认识**里面是什么：七档内容渲染器共用它，而它们互不 import
 * （`@/features/AGENTS.md`「组件之间不认识」）—— 故这里一个视图都不提。
 */
export function WindowCard(props: WindowCardProps): React.JSX.Element {
  const { g, theme } = props;
  const box = g.windowBox;
  const header = g.windowHeader;
  const content = g.windowContent;
  const title = g.windowTitle;
  if (box === null || header === null || content === null || title === null) return <Box />;
  const pad = " ".repeat(WINDOW_PADDING);
  return (
    // ⚠️ **它没有框**：一块卡片浮在**极暗的遮罩**上靠明暗差说「压在上面」，一圈框线只会把它画成
    // 「另一个终端窗口」，而满屏接管之后屏上并没有别的窗口。
    <Box
      position="absolute"
      left={box.x}
      top={box.y}
      width={box.width}
      height={box.height}
      flexDirection="column"
      backgroundColor={tone(theme, "panel")}
    >
      {/* ⚠️ **上边那一格 padding 是一个 height 给定的空盒子**；左右两格归每一行自己的缩进 ——
          少它的话内容整体上移一行，而屏上看着只是「标题与遮罩之间没有缝」。 */}
      <Box height={WINDOW_PADDING} flexShrink={0} />
      {/* ⚠️ **每一行铺满整块卡片**，而文字自己带那 {@link WINDOW_PADDING} 列缩进**（行盒窄一格的话
          那条分隔会超出一格而静默软换行，症状是「卡片里多出一行而下面那些行被挤出去」） */}
      <Box width={box.width} height={1}>
        <Text>{pad + " ".repeat(WINDOW_HEADER_INDENT)}</Text>
        {/* ⚠️ 标题的裁剪预算**只**读 `windowTitle`（几何层给的，已让开内区左缘与 `esc` 那几列） */}
        <Text color={tone(theme, "accent")} bold>
          {ellipsis(props.label, title.width)}
        </Text>
      </Box>
      {/* ⚠️ **分隔那一行恒是 {@link MARK_SELECTED} 铺满内区**：它是内容区里唯一「既不是标题
          也不是可选行」的一行，而它铺满整行、可选行的记号只有左缘那一列。 */}
      <Box width={box.width} height={1}>
        <Text color={tone(theme, "idle")}>
          {pad + MARK_SELECTED.repeat(Math.max(0, content.width))}
        </Text>
      </Box>
      {props.children}
      {/* ⚠️ **卡片高度与内容行数无关**（几何层给的是「屏高一半」），所以「标题 + 分隔 + 那几行」
          之后**未必**到卡片底边 —— 空盒子把剩下的留白吃干净。 */}
      <Box flexGrow={1} />
    </Box>
  );
}

/** 内容区里**一个槽位**那一行（文字从那一槽的 `x` 起，恰好填到那一槽的右缘） */
// ⚠️ **`null` 槽由调用方判掉而不是在这里产出一行**：照画会让内容错位，而症状只是「卡片里多出几行」。
export function SlotLine(props: {
  readonly box: Rect;
  readonly slot: Rect;
  /** 那一槽里还没画字的那几列（**调用方按它自己刚决定的那几段宽度算出来**，本层不再算一次） */
  readonly fill: number;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box width={props.box.width} height={1}>
      <Box flexShrink={0} width={Math.max(0, props.slot.x - props.box.x)} />
      {props.children}
      <Text>{" ".repeat(Math.max(0, props.fill))}</Text>
    </Box>
  );
}