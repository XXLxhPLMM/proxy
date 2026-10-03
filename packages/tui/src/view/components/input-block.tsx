/**
 * @fileoverview 输入区：整屏**唯一**带框的一块；⚠️ 框与折行都由几何层给，本组件一次都不自己算
 */

import { Box, Text } from "ink";
import { ellipsis, widthOf } from "@/ui/format.js";
import type { Theme } from "@/ui/theme.js";
import { MAIN_TEXT_X, type Rect, type WrappedRow } from "../geometry.js";
import { PROMPT, tone } from "./constants.js";
import type { RegionProps } from "./types.js";

export function InputBlock(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  if (g.input === null || g.inputContent === null) return <Box />;
  return (
    <Box
      flexDirection="column"
      width={g.input.width}
      height={g.input.height}
      // ⚠️ **画不画框读几何层**（`inputFramed`），本层**不自己判**：两处各判一次的话，几何层算出的
      // `inputContent` 与本层画的框会对不上。
      borderStyle={g.inputFramed ? "round" : undefined}
      borderColor={g.inputFramed ? tone(theme, "idle") : undefined}
      // ⚠️ **模态开着时这一圈框必须自己带遮罩底色**：Ink 画边框**不继承**祖先的 `backgroundColor`，
      // 而框那一圈是**整屏最底下两行** —— 不给的话症状是「遮罩中间横着两条亮线」。
      borderBackgroundColor={props.window === null ? undefined : tone(theme, "scrim")}
    >
      {g.inputTextRows.map((rect, i) => (
        <CaretRow
          key={i}
          rect={rect}
          row={g.inputWrapped[i] ?? { text: "", start: 0 }}
          prompt={i === 0 ? PROMPT : ""}
          cursor={props.cursor}
          ghost={props.ghost}
          theme={theme}
          // ⚠️ **模态开着时那一格不画**：按键已经全被窗口吃掉了（`use-keyboard.ts`），而屏上
          // 留着一个反底色的光标块等于说「焦点还在输入框」。
          caret={props.window === null}
        />
      ))}
      {/* ⚠️ 瞬时消息在**框内最后一行**，画不画读几何层（`inputNotice`）—— 极矮的屏上框内放不下时它
          **整行不出现**，本层不自己比一次。 */}
      {g.inputNotice === null ? null : (
        <Box width={g.inputNotice.width} height={g.inputNotice.height}>
          <Text>{" ".repeat(MAIN_TEXT_X)}</Text>
          {props.notice === null ? null : (
            <Text color={tone(theme, "warn")}>
              {ellipsis(props.notice, Math.max(0, g.inputNotice.width - MAIN_TEXT_X))}
            </Text>
          )}
        </Box>
      )}
      {/* ⚠️ **框内放不下的那几行留白，不补任何东西**：Ink 的列向 flex 默认 `flex-start`，余下的
          空间**留在底部** —— 屏极矮时框内就是少几行空白，那正是「这一帧真的放不下」该有的样子。 */}
    </Box>
  );
}

/** 输入串的一个**视觉行**：插入符用反底色（颜色之外的形状通道），补全建议跟在后面用暗色 */
// ⚠️ 插入符那一格是**反底色**而不是真的移动终端光标（Ink 每次重绘都按自己的假设画）。
// ⚠️ 它画在**折出来的那一行**上，少判这一处的症状是「输入超过一行之后按 ← 光标不跟着走」。
function CaretRow(props: {
  readonly row: WrappedRow;
  readonly prompt: string;
  readonly cursor: number;
  readonly ghost: string | null;
  readonly rect: Rect;
  readonly theme: Theme;
  readonly caret: boolean;
}): React.JSX.Element {
  const { row, rect, theme } = props;
  const at = props.caret ? props.cursor - row.start : -1;
  const inside = at >= 0 && at <= row.text.length;
  const offset = inside ? at : 0;
  const before = row.text.slice(0, offset);
  const cell = inside ? (row.text[offset] ?? " ") : "";
  const after = inside ? row.text.slice(offset + 1) : row.text;
  const sel = tone(theme, "selected");
  const lead = props.prompt === "" ? " " : props.prompt;
  return (
    <Box width={rect.width + widthOf(lead)} height={1}>
      {/* ⚠️ 提示符（续行是同样宽的空格）：它必须**恰好**占 {@link Rect.x} 让出的那几列，后面那段
          文字才会落在 `rect.x` 上 —— 那正是「点输入行落点」用的那一列（悬挂缩进）。 */}
      <Text color={tone(theme, "accent")}>{lead}</Text>
      <Text>{ellipsis(before, rect.width)}</Text>
      {cell === "" ? null : (
        <Text color={sel} backgroundColor={sel}>
          {cell}
        </Text>
      )}
      <Text>{after}</Text>
      {/* ⚠️ 幽灵文本只画在**光标所在那一行**（`inside` 为假的那一行它无处可跟）：Tab 会插在光标
          后面，把它画在光标不在的那一行就是在骗人说「按 Tab 会插在这里」。 */}
      {props.ghost === null || !inside ? null : (
        <Text color={tone(theme, "idle")} dimColor>
          {ellipsis(props.ghost, Math.max(0, rect.width - widthOf(before) - 1))}
        </Text>
      )}
    </Box>
  );
}