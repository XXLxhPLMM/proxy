/**
 * @fileoverview 操作者敲的**那一句**在结果区里的形状：左边距一列 + 恰好一枚箭头 + 一层底色
 */

import { Box, Text } from "ink";

import { ellipsis, widthOf } from "@/lib/index.js";
import type { Theme } from "@/theme/index.js";
import { tone } from "@/components/index.js";

/** 这一块左边留的列数（⚠️ **刻意不是主区那几列**：用户消息是内容而不是版式，与 `MAIN_TEXT_X` 无关） */
const MARGIN_X = 1;

/** 那一格**字**的色档（⚠️ 呈现层不许自己挑一档 —— 取的是行模型给那一档行定的同一档，见 {@link OutputView}） */
// ⚠️ **与命令回显的 `accent` 分开是判据**：那一枚 `❯` 两边都有，而同色的话「这是我说的话」与
// 「这是刚执行的那条」在**文字色**上读起来一样 —— 只剩底色那一个通道，而无色终端里压根没有底色。
export const USER_TEXT_TONE = "muted" as const;

/**
 * 用户消息那一行（**左起一列留白 + 一枚箭头 + 一层底色**）
 * @description 入参是**已经折好的那一段**（折行归 `@/lib` 的行模型，它按结果区宽折）⇒ 每一段一行，
 * 而屏上那个气泡自然跨着几行。**每一段都重复同一枚箭头**：只有第一段有箭头的话气泡左边参差不齐，
 * 而那正是「这里是一段话」的形状通道。
 */
// ⚠️ 底色给**外层那个 `<Box>`**：`<Text>` 从最近的带底色的祖先继承，漏掉外层这一份的话那一格会取
// **默认底色**（看着像气泡上破了个洞）；而 Ink 把带底色的盒子整块写成空格 ⇒ **不必自己补齐到整行**。
export function UserBubble(props: {
  readonly text: string;
  /** 结果区的内容宽度（**恒等于** {@link Geometry.outputWidth}） */
  readonly width: number;
  readonly theme: Theme;
}): React.JSX.Element {
  const { theme } = props;
  const arrow = "❯ ";
  // ⚠️ 预算按**这一枚字形实测**的宽算，而它恒等于 `PROMPT_COLUMNS` —— 「输入框的字」与「气泡的字」
  // 竖直对齐这一条由 `tests/render/` 钉住（拿常量当这里的期望值的话，改常量与改实现同时发生 ⇒ 恒绿）。
  const room = Math.max(0, props.width - MARGIN_X - widthOf(arrow));
  const text = ellipsis(props.text, room);
  return (
    <Box width={props.width} height={1} backgroundColor={tone(theme, "bubble")}>
      <Text>{" ".repeat(MARGIN_X)}</Text>
      {/* ⚠️ **箭头与输入框是同一枚**：同一个字形在两处指着「这是我说的话」，
          而命令回显那一行**有**同样的字形**却没有**底色 —— 两个通道各自独立。 */}
      <Text color={tone(theme, "accent")}>{arrow}</Text>
      <Text color={tone(theme, USER_TEXT_TONE)}>{text}</Text>
    </Box>
  );
}