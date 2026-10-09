/**
 * @fileoverview 输入区：整屏**唯一**带框的一块；⚠️ 框、折行与**箭头槽**都由几何层给，本组件一次都不自己算
 */

import { Box, Text } from "ink";

import {
  PROMPT_COLUMNS,
  caretRowOf,
  ellipsis,
  widthOf,
  type Rect,
  type WrappedRow,
} from "@/lib/index.js";
import { selectionInk, type Theme } from "@/theme/index.js";
import { tone } from "@/components/index.js";
import type { InputSelection, RegionProps } from "@/components/index.js";

/** 箭头槽第 0 格那枚字形（⚠️ 它与 `PROMPT_COLUMNS` 是同一件事：显示宽度恒为 1） */
const GUTTER_ARROW = "❯";

/** 箭头槽下面几格那一竖列（⚠️ **竖线而不是空格**：续行顶格画的话，硬换行之后第一个字与第一行的字差着两列） */
const GUTTER_BAR = "│";

/** 那一帧有没有**别的**东西在收键（模态开着 ⇒ 按键全被它吃掉，而输入行只剩一块背景） */
// ⚠️ **一个 `view` 统管七档**：改名框又住在弹窗里，于是「此刻敲的字去了哪儿」只有一个答案
// —— 提示符恒是 {@link GUTTER_ARROW}，而弹窗开着时那个反底色块整个不画。
function typing(props: RegionProps): boolean {
  return props.view === null;
}

export function Composer(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  if (g.input === null || g.inputContent === null) return <Box />;
  const free = typing(props);
  // ⚠️ **插入符落在哪一行由几何层那份折行结果答**（`caretRowOf` 与绘制读的是同一个 `inputWrapped`）：
  // 各行按 `cursor - row.start` 自己判的话，光标停在硬换行处时两行都自称命中 ⇒ 屏上两个块。
  const caret = free ? caretRowOf(g.inputWrapped, props.cursor) : { row: -1, offset: -1 };
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
      borderBackgroundColor={free ? undefined : tone(theme, "scrim")}
    >
      {/* ⚠️ **箭头槽与它右边那些字在同一个行盒里**（两者是兄弟而不是上下两段）：段与段是
          **同一视觉行**的两块，而把它们排成上下两行时那一列就与文字差了一整行（症状是
          「输入串在箭头下面一行，而框里第一行空着」）。⚠️ 文字那一块宽**恒等于**几何层给的
          那个文本矩形，而箭头槽那一块恒占 {@link PROMPT_COLUMNS} 列 —— 两者首尾相接落在
          `inputContent.x` 起，也就是「点输入行落点」用的那一列（悬挂缩进）。
          ⚠️ **箭头恒在最上面那一格**，下面每一格是一竖线：续行顶格画的话，硬换行之后第一个字
          与第一行的字差着两列（症状是「敲了换行字串到左边去了」）。
          ⚠️ **只画文本行那几格**：紧跟着的那一行是框内的瞬时消息，它不是「敲的字」，
          而它头上悬一竖线会读成「这一行也在输入框里」。 */}
      {g.inputTextRows.map((rect, i) => (
        <InputLine
          key={i}
          row={g.inputWrapped[i] ?? { text: "", start: 0 }}
          text={rect}
          gutter={g.inputGutter === null ? null : i === 0 ? `${GUTTER_ARROW} ` : `${GUTTER_BAR} `}
          caret={caret.row === i ? caret.offset : -1}
          selection={props.inputSelection}
          ghost={props.ghost}
          theme={theme}
        />
      ))}
      {/* ⚠️ 瞬时消息在**框内最后一行**，画不画读几何层（`inputNotice`）—— 极矮的屏上框内放不下时它
          **整行不出现**，本层不自己比一次。⚠️ 缩进吃 {@link PROMPT_COLUMNS}：与输入区那些字竖直对齐。 */}
      {g.inputNotice === null ? null : (
        <Box width={g.inputNotice.width} height={g.inputNotice.height}>
          <Text>{" ".repeat(PROMPT_COLUMNS)}</Text>
          {props.notice === null ? null : (
            <Text color={tone(theme, "warn")}>
              {ellipsis(props.notice, Math.max(0, g.inputNotice.width - PROMPT_COLUMNS))}
            </Text>
          )}
        </Box>
      )}
      {/* ⚠️ **框内放不下的那几行留白，不补任何东西**：Ink 的列向 flex 默认 `flex-start`，余下的
          空间**留在底部** —— 屏极矮时框内就是少几行空白，那正是「这一帧真的放不下」该有的样子。 */}
    </Box>
  );
}

/** 输入串的一个**视觉行**：左边箭头槽那一列 + 右边那些字；选区走**真反色**、插入符走反底色块 */
// ⚠️ 插入符那一格是**反底色**而不是真的移动终端光标（Ink 每次重绘都按自己的假设画）。
// ⚠️ **选区与插入符是两个不同的通道**：选区答「这一段被选中」，插入符答「光标在第几个字」；
// 两者恒不同时出现（有选区时按任何可打印键都会替换整段），故本层只画其中一个。
function InputLine(props: {
  readonly row: WrappedRow;
  /** 这一行**文字**那个矩形（几何层给的；⚠️ 它的 `x` 恒在箭头槽右缘那一列） */
  readonly text: Rect;
  /** 箭头槽那一格那一行（`null` = 主区比箭头槽还窄，于是那一格不存在） */
  readonly gutter: string | null;
  /** 插入符落在**行内**第几个字符（`-1` = 不在这一行、或此刻压根不画插入符） */
  readonly caret: number;
  readonly selection: InputSelection | null;
  readonly ghost: string | null;
  readonly theme: Theme;
}): React.JSX.Element {
  const { row, text: rect, theme } = props;
  const sel = tone(theme, "selected");
  const ink = selectionInk();
  // ⚠️ **选区那两端是**原串**的下标**，而这里量的是**行内**下标：两端都夹进这一行那一段，
  // 少夹一处的话跨行的选区会在**每一行**都从第 0 个字开始吃（症状是「只选了几个字，前面的全没了」）。
  const rowEnd = row.start + row.text.length;
  const picked = props.selection === null ? null : props.selection;
  const from = picked === null ? 0 : Math.max(0, Math.min(picked.start, rowEnd) - row.start);
  const to = picked === null ? 0 : Math.max(0, Math.min(picked.end, rowEnd) - row.start);
  const caret = picked === null ? props.caret : -1;
  /** 三个片段：**前面 / 中间 / 后面**。⚠️ 中间那一段在有选区时是「选中的那几个字」，没有选区时是空的。 */
  const segments =
    caret >= 0
      ? { before: row.text.slice(0, caret), cell: row.text[caret] ?? " ", picked: "", after: row.text.slice(caret + 1) }
      : picked === null
        ? { before: row.text, cell: "", picked: "", after: "" }
        : { before: row.text.slice(0, from), cell: "", picked: row.text.slice(from, to), after: row.text.slice(to) };
  return (
    <Box height={1}>
      {/* ⚠️ **箭头槽那一格恒是 {@link PROMPT_COLUMNS} 列**（哪怕折出来的续行一个字都没有）：
          少一格的话这一行整体左移一列，而下一行的字与这一行就对不齐了。 */}
      {props.gutter === null ? null : (
        <Box width={PROMPT_COLUMNS} height={1} flexShrink={0}>
          <Text color={tone(theme, "accent")}>{props.gutter}</Text>
        </Box>
      )}
      <Box width={rect.width} height={1}>
        <Text>{ellipsis(segments.before, rect.width)}</Text>
        {segments.cell === "" ? null : (
          <Text color={sel} backgroundColor={sel}>
            {segments.cell}
          </Text>
        )}
        {picked === null ? null : (
          // ⚠️ **真反色那一对走 `@/theme`**：呈现层不许自己挑一档 —— 底色与字色同档的话选中的那段
          // 一个字都看不见，而那个实现在类型上完全合法（两格都是 `Tone`）。
          <Text color={tone(theme, ink.foreground)} backgroundColor={tone(theme, ink.background)}>
            {ellipsis(segments.picked, rect.width)}
          </Text>
        )}
        <Text>{ellipsis(segments.after, rect.width)}</Text>
        {/* ⚠️ 幽灵文本只画在**光标所在那一行**（不在那一行的话它无处可跟）：Tab 会插在光标
            后面，把它画在光标不在的那一行就是在骗人说「按 Tab 会插在这里」。 */}
        {props.ghost === null || caret < 0 ? null : (
          <Text color={tone(theme, "idle")} dimColor>
            {ellipsis(
              props.ghost,
              Math.max(0, rect.width - widthOf(segments.before) - widthOf(segments.cell)),
            )}
          </Text>
        )}
      </Box>
    </Box>
  );
}