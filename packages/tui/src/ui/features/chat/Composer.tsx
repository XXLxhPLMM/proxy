/**
 * @fileoverview 输入区：整屏**唯一**带框的一块；框恒画、折行由 Ink 的 flex 给，
 * 本层只按**原串下标**画插入符 / 选区 / 幽灵文本（不再读几何层的折行结果）
 */

import { Box, Text } from "ink";

import { PROMPT_COLUMNS } from "@/ui/components/index.js";
import { selectionInk, type Theme } from "@/ui/theme/index.js";
import { tone } from "@/ui/components/index.js";
import type { InputSelection, RegionProps } from "@/ui/components/index.js";

/** 输入串前面那枚字形（⚠️ 显示宽度恒为 1，与 {@link PROMPT_COLUMNS} 是同一件事） */
const GUTTER_ARROW = "❯";

/** 那一帧有没有**别的**东西在收键（模态开着 ⇒ 按键全被它吃掉，而输入行只剩一块背景） */
// ⚠️ **一个 `view` 统管七档**：改名框又住在弹窗里，于是「此刻敲的字去了哪儿」只有一个答案
// —— 提示符恒是 {@link GUTTER_ARROW}，而弹窗开着时那个反底色块整个不画。
function typing(props: RegionProps): boolean {
  return props.view === null;
}

export function Composer(props: RegionProps): React.JSX.Element {
  const { theme } = props;
  // ⚠️ 主区画不出来时整个不画。框与行数一律由 flex 给。
  if (props.mainWidth <= 0) return <Box />;
  const free = typing(props);
  return (
    // ⚠️ 框恒画 `round`：极矮时由父容器的定高与结果区的 `overflow="hidden"` 裁，
    // 而 `flexShrink={0}` 让输入框保住自己的高度 —— 裁的是结果区，不是正在敲字的这一块。
    // ⚠️ **模态开着时这一圈框必须自己带遮罩底色**：Ink 画边框**不继承**祖先的 `backgroundColor`，
    // 而框那一圈是**整屏最底下两行** —— 不给的话症状是「遮罩中间横着两条亮线」。
    <Box
      flexDirection="column"
      flexShrink={0}
      borderStyle="round"
      borderColor={tone(theme, "idle")}
      borderBackgroundColor={free ? undefined : tone(theme, "scrim")}
    >
      {/* ⚠️ 箭头与文字是同一行盒里的两兄弟：续行由 Ink 在文字那一列里折，自然顶在首行文字的左缘之下
          （悬挂缩进）—— 而以前几何层逐行给的那一竖列 `│` 没有了：Ink 不暴露折行位置，那一列画不了。 */}
      <Box flexDirection="row">
        <Box flexShrink={0}>
          <Text color={tone(theme, "accent")}>{`${GUTTER_ARROW} `}</Text>
        </Box>
        <Box flexDirection="row" flexGrow={1} flexShrink={1}>
          <InputText
            input={props.input}
            cursor={props.cursor}
            selection={props.inputSelection}
            ghost={props.ghost}
            active={free}
            theme={theme}
          />
        </Box>
      </Box>
      {/* ⚠️ 瞬时消息在**框内最后一行**：有就画（超宽由 Ink 截断），没有就不占行。
          以前「极矮时整行不出现」那一档现在由 flex 裁剪接管。⚠️ 缩进走 `paddingLeft`：与输入区那些字竖直对齐。 */}
      {props.notice === null ? null : (
        <Box flexDirection="row" flexShrink={0} paddingLeft={PROMPT_COLUMNS}>
          <Box flexDirection="row" flexGrow={1} flexShrink={1}>
            <Text color={tone(theme, "warn")} wrap="truncate">
              {props.notice}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

/** 输入串那一块：原文按插入符 / 选区切成几段，包在一个 `wrap="wrap"` 里由 Ink 折行 */
// ⚠️ **刻意不用 `@inkjs/ui` 的 `TextInput`**：它是单行 + 自管状态 + 自带 `useInput`，
// 而输入行是多行 + 状态全在外部（`input` / `cursor` / 选区由状态层受控）+ 全包只有
// `hooks/useHotkeys.ts` 一处 `useInput` —— 换上去等于多一个按键入口、少掉多行与选区。
// ⚠️ 插入符那一格是**反底色**而不是真的移动终端光标（Ink 每次重绘都按自己的假设画）。
// ⚠️ **选区与插入符是两个不同的通道**：选区答「这一段被选中」，插入符答「光标在第几个字」；
// 两者恒不同时出现（有选区时按任何可打印键都会替换整段），故本层只画其中一个。
function InputText(props: {
  /** 输入串原文（⚠️ **原文**：折行由 Ink 做，本层一次都不自己折） */
  readonly input: string;
  /** 插入符的字符下标（**原串**的下标；`0` = 行首，`input.length` = 行末） */
  readonly cursor: number;
  /** 那一段选区（`null` = 无选区；⚠️ **两端已按「小的在前」排好**，本层不自己比大小） */
  readonly selection: InputSelection | null;
  /** 补全建议的**剩余部分**（`null` = 没有建议） */
  readonly ghost: string | null;
  /** 此刻按键是不是归输入行（`false` ⇒ 只剩一块背景，不画插入符与幽灵文本） */
  readonly active: boolean;
  readonly theme: Theme;
}): React.JSX.Element {
  const { input, cursor, selection, ghost, active, theme } = props;
  const sel = tone(theme, "selected");
  const ink = selectionInk();
  if (selection !== null) {
    // ⚠️ **选区那两端是**原串**的下标**，直接在原文上切 —— 不再经几何层的折行结果换算行内下标。
    const from = Math.max(0, Math.min(selection.start, input.length));
    const to = Math.max(0, Math.min(selection.end, input.length));
    return (
      <Text wrap="wrap">
        <Text wrap="wrap">{input.slice(0, from)}</Text>
        {/* ⚠️ **真反色那一对走 `@/ui/theme`**：呈现层不许自己挑一档 —— 底色与字色同档的话选中的那段
            一个字都看不见，而那个实现在类型上完全合法（两格都是 `Tone`）。 */}
        <Text
          color={tone(theme, ink.foreground)}
          backgroundColor={tone(theme, ink.background)}
          wrap="wrap"
        >
          {input.slice(from, to)}
        </Text>
        <Text wrap="wrap">{input.slice(to)}</Text>
      </Text>
    );
  }
  if (!active) return <Text wrap="wrap">{input}</Text>;
  // ⚠️ 插入符按**原串下标**切（越界时夹进串内）；落在 `\n` 上时画块再补回换行 ——
  // 直接把 `\n` 反色的话那一行没有可画的字，而吞掉它又会把两行拼成一行。
  const at = Math.max(0, Math.min(cursor, input.length));
  const before = input.slice(0, at);
  const rest = input.slice(at);
  const cell = rest.slice(0, 1);
  const hardBreak = cell === "\n";
  return (
    <Text wrap="wrap">
      <Text wrap="wrap">{before}</Text>
      <Text color={sel} backgroundColor={sel} wrap="wrap">
        {cell === "" || hardBreak ? " " : cell}
      </Text>
      {hardBreak ? "\n" : null}
      <Text wrap="wrap">{rest.slice(1)}</Text>
      {/* ⚠️ 幽灵文本跟在光标**后面**：Tab 会插在光标后面，把它画在别处就是在骗人说「按 Tab 会插在这里」。 */}
      {ghost === null ? null : (
        <Text color={tone(theme, "idle")} dimColor wrap="wrap">
          {ghost}
        </Text>
      )}
    </Text>
  );
}
