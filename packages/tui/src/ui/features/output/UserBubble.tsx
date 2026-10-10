/**
 * @fileoverview 操作者敲的**那一句**在结果区里的形状：左边距一列 + 恰好一枚箭头 + 一层底色
 * （flex 布局：折行由 Ink 做，本层不再按列宽手算 `ellipsis`）
 */

import { Box, Text } from "ink";

import type { Theme } from "@/ui/theme/index.js";
import { tone } from "@/ui/components/index.js";

/** 这一块左边留的列数（⚠️ **刻意不是主区那几列**：用户消息是内容而不是版式；缩进走 `paddingLeft`） */
const MARGIN_X = 1;

/** 那一格**字**的色档（⚠️ 呈现层不许自己挑一档 —— 取的是行模型给那一档行定的同一档，见 {@link OutputView}） */
// ⚠️ **与命令回显的 `accent` 分开是判据**：那一枚 `❯` 两边都有，而同色的话「这是我说的话」与
// 「这是刚执行的那条」在**文字色**上读起来一样 —— 只剩底色那一个通道，而无色终端里压根没有底色。
export const USER_TEXT_TONE = "muted" as const;

/**
 * 用户消息那一块（**左起一列留白 + 一枚箭头 + 一层底色**）
 * @description 折行由 Ink 做（`wrap="wrap"` 自然跨着几行），本层一次都不自己折、一次都不自己裁。
 */
// ⚠️ 底色给**外层那个 `<Box>`**：`<Text>` 从最近的带底色的祖先继承，漏掉外层这一份的话那一格会取
// **默认底色**（看着像气泡上破了个洞）。
export function UserBubble(props: {
  readonly text: string;
  /** 结果区的内容宽度（父给的：本层只拿它定外层宽度，不再拿它算裁剪预算） */
  readonly width: number;
  readonly theme: Theme;
}): React.JSX.Element {
  const { theme } = props;
  const arrow = "❯ ";
  return (
    <Box width={props.width} flexShrink={0} backgroundColor={tone(theme, "bubble")}>
      {/* ⚠️ 箭头与文字是同一行盒里的两兄弟：续行由 Ink 在文字那一列里折，自然顶在首行文字的左缘之下
          （悬挂缩进）—— 与 `Composer` 那一处是同一套画法。 */}
      <Box flexDirection="row" flexGrow={1} flexShrink={1} paddingLeft={MARGIN_X}>
        <Box flexShrink={0}>
          {/* ⚠️ **箭头与输入框是同一枚**：同一个字形在两处指着「这是我说的话」，
              而命令回显那一行**有**同样的字形**却没有**底色 —— 两个通道各自独立。 */}
          <Text color={tone(theme, "accent")}>{arrow}</Text>
        </Box>
        <Box flexDirection="row" flexGrow={1} flexShrink={1}>
          <Text color={tone(theme, USER_TEXT_TONE)} wrap="wrap">
            {props.text}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
