/** 结果区那一块：可滚的结果文本 + 底部那一行滚动/丢弃提示（flex 布局，行高不再手算） */

import { Box, Text } from "ink";
import { visibleLines, type LogLine } from "@/lib/log/index.js";
import { MAIN_TEXT_X } from "@/ui/components/index.js";
import type { Tone } from "@/ui/theme/index.js";
import { ECHO_PREFIX, tone } from "@/ui/components/index.js";
import type { RegionProps } from "@/ui/components/index.js";
import { UserBubble, USER_TEXT_TONE } from "./UserBubble.js";

/** 结果区每类行的默认色档（⚠️ **穷举**：行模型加一档时这张表就在 `tsc` 那一层红） */
const TONE_OF: Record<LogLine["kind"], Tone> = {
  echo: "accent",
  // ⚠️ **这一档不许与 `echo` 同色**：`❯ ` 两边都有，只剩**文字色**这一个通道能说「我说的」与
  // 「要执行的那条」不是一件事，而色档取自 {@link USER_TEXT_TONE} —— 与行模型给那一档定的同一档。
  user: USER_TEXT_TONE,
  head: "accent",
  kv: "muted",
  table: "muted",
  note: "warn",
  err: "danger",
};

/**
 * 「这一行是**操作者敲的那一句**」那一档行（**命令回显不在其中**）
 * @description 判据是**行模型那一档**、而绝不是嗅探字符串：那样 `/providers` 那条**要执行的**命令
 * 会被当成一句话（两个事实渲染成同一个东西）。而这一个出口的**判据形状**在 `tests/render/` 的接线那一档。
 */
// ⚠️ 判据**不读字符串**：命令回显与用户消息今天渲染成同一个东西，而屏上必须分得开哪一条会被执行。
const USER_LINE_KINDS: ReadonlySet<string> = new Set(["user"]);

export function OutputView(props: RegionProps): React.JSX.Element {
  const { theme } = props;
  // ⚠️ 滚动窗口的行数由父给（`outputRows`）：「从第几行开始画 / 下面还剩几行」没有视口行数答不出来。
  // 高度一律由 flex 给：外层 `flexGrow` 吃掉主区剩余高度（定高由父容器给），多画的行由
  // `overflow="hidden"` 裁掉。
  if (props.mainWidth <= 0) return <Box />;
  const lines = visibleLines(props.flat, props.top, props.outputRows);
  const below = Math.max(0, props.flat.height - (props.top + props.outputRows));
  const above = Math.max(0, props.top);
  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {lines.map((line, i) =>
        // ⚠️ **两种形状、两个出口**：用户消息是一块带底色与箭头的行，其余各档是「一色一行」；
        // 而前缀 `❯ ` 两者都有（那个字形答「这句话是我说的」，底色答「它**不是**一条要执行的命令」）。
        USER_LINE_KINDS.has(line.kind) ? (
          <UserBubble
            key={`${String(line.entryId)}:${String(line.part)}:${String(i)}`}
            text={line.text}
            width={props.outputWidth}
            theme={theme}
          />
        ) : (
          // ⚠️ 超宽由 Ink 截断（`truncate` 恒是一行）：本层不再按列宽手算 `ellipsis`。
          <Text
            key={`${String(line.entryId)}:${String(line.part)}:${String(i)}`}
            color={tone(theme, TONE_OF[line.kind])}
            wrap="truncate"
          >
            {line.kind === "echo" ? `${ECHO_PREFIX}${line.text}` : line.text}
          </Text>
        ),
      )}
      {/* ⚠️ 滚动提示恒在末行之后（内容不够时紧跟末行，余量留在底部）；`flexShrink={0}` 保住这一行，
          极矮时裁的是上面的内容行。缩进走 `paddingLeft`（= 原来的主区缩进）。 */}
      <Box flexDirection="row" flexShrink={0} paddingLeft={MAIN_TEXT_X}>
        <Box flexDirection="row" flexGrow={1} flexShrink={1}>
          <Text
            color={tone(theme, below > 0 || above > 0 ? "warn" : "muted")}
            dimColor={below === 0}
            wrap="truncate"
          >
            {scrollHintOf(above, below, props.droppedHint)}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

/** 结果区底部那一行（**永远在**：它是唯一区分「已到底」与「下面还有内容」的地方） */
// ⚠️ **位置**与**丢弃声明**是两句独立的话，先算位置再缀丢弃。
function scrollHintOf(above: number, below: number, droppedHint: string | null): string {
  const position =
    above > 0 && below > 0
      ? `上 ${String(above)} 行 · 下 ${String(below)} 行`
      : above > 0
        ? `上方还有 ${String(above)} 行 · PgUp / 滚轮上翻`
        : below > 0
          ? `下方还有 ${String(below)} 行 · PgDn / 滚轮下翻`
          : "已到底";
  return droppedHint === null ? `⇅ ${position}` : `⇅ ${position} · ${droppedHint}`;
}
