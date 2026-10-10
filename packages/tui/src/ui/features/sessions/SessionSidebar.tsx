/**
 * @fileoverview 左侧那一列：会话清单（顶部留白 + 每项两行 + 项间那一行间隔）+ 名字前面那枚记号
 * （flex 布局：定宽竖列 + 超高由 Ink 裁）
 */
// ⚠️ **记号不吃选中色**（名字吃）：「我选了哪一项」与「它在干什么」是两个事实，共用一档色时屏上只剩一个。
// 代价是 `idle` 那一项被选中时记号看着是暗的 —— 而那正是它该有的样子：它没在跑。
import { Box, Text } from "ink";

import {
  SESSION_GAP_ROWS,
  SESSION_MARK_COLUMNS,
  SIDEBAR_TEXT_X,
  SIDEBAR_TOP_PAD_ROWS,
} from "@/ui/components/index.js";
import { tone } from "@/ui/components/index.js";
import type { RegionProps } from "@/ui/components/index.js";
import { runMarkOf } from "@/ui/theme/index.js";

/** 侧边栏第二行「这个会话还没连任何控制面」那一句 */
// ⚠️ **必须是一句人话而不是空串**：空串与「选了个名字是空的控制面」在屏上长得一样。
const NO_MANAGER_TEXT = "未选控制面";

export function SessionSidebar(props: RegionProps): React.JSX.Element {
  const { theme } = props;
  const width = props.sidebarWidth;
  // ⚠️ **只剩这一个判据**：宽为 0 = 侧边栏收起，整个不画。
  if (width <= 0) return <Box />;
  /** 记号位恒占 {@link SESSION_MARK_COLUMNS} 列，两侧**等宽** —— 那一格宽是奇数才排得出「居中」 */
  const markPad = " ".repeat(Math.floor(SESSION_MARK_COLUMNS / 2));
  // ⚠️ 首项号只读状态层的 `sessionsTop`（再夹一次防越界）。
  const first =
    props.sessions.length === 0
      ? 0
      : Math.max(0, Math.min(props.sessionsTop, props.sessions.length - 1));
  const visible = props.sessions.slice(first);

  return (
    // ⚠️ **底色只在这一列的 `<Box>` 上给一次**（内层 `<Text>` 从父继承）。
    // ⚠️ 定宽 + 定高 + `overflow="hidden"`：装不下的项直接裁，不再按视口行数切片。
    <Box
      flexDirection="column"
      width={width}
      height={props.rows}
      overflow="hidden"
      backgroundColor={tone(theme, "surface")}
    >
      <Box height={SIDEBAR_TOP_PAD_ROWS} flexShrink={0} />
      {/* ⚠️ 这一盒吃掉剩余高度、装不下就裁：它与底部的说明行之间不强制留白。 */}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {visible.flatMap((item, i) => {
          const isSel = item.id === props.selectedSessionId;
          const mark = runMarkOf(item.run, item.seen);
          return [
            i === 0 ? null : (
              <Box key={`gap-${item.id}`} height={SESSION_GAP_ROWS} flexShrink={0} />
            ),
            <Box key={item.id} flexDirection="column" flexShrink={0}>
              <Box flexDirection="row" flexShrink={0}>
                {/* ⚠️ **色档读自己的那一份**（{@link runMarkOf}），名字才吃选中那一档：见文件头。
                    ⚠️ 记号位恒是 `markPad + 字形 + markPad` 那 {@link SESSION_MARK_COLUMNS} 列 ——
                    `idle` 的字形是一个空格，故三档的**列位相同**，而名字不会在两帧之间跳。 */}
                <Box flexShrink={0}>
                  <Text color={tone(theme, mark.tone)} wrap="truncate">{`${markPad}${mark.glyph}${markPad}`}</Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text
                    color={tone(theme, isSel ? "selected" : "muted")}
                    bold={isSel}
                    wrap="truncate"
                  >
                    {item.name}
                  </Text>
                </Box>
              </Box>
              {/* ⚠️ 第二行**恒不参与选中高亮**：它答的是「打给谁」，而「我选了哪一个会话」由第一行回答 ——
                  两行都高亮的话，「这一项被选中了」与「它连着的那台是当前那台」在屏上读起来一样。 */}
              <Box flexDirection="row" flexShrink={0} paddingLeft={SIDEBAR_TEXT_X}>
                <Box flexGrow={1} flexShrink={1}>
                  <Text color={tone(theme, "idle")} wrap="truncate">
                    {item.manager ?? NO_MANAGER_TEXT}
                  </Text>
                </Box>
              </Box>
            </Box>,
          ];
        })}
      </Box>
      {/* ⚠️ 「上还有几个」贴着侧边栏最底下（`flexShrink={0}` 保住这一行，裁的是上面的清单）。
          ⚠️ 已知取舍：下方被裁掉几项没有视口行数答不出来，故这里只说「上面藏了几个 + 一共几个」。 */}
      {first > 0 ? (
        <Box flexDirection="row" flexShrink={0} paddingLeft={SIDEBAR_TEXT_X}>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={tone(theme, "warn")} dimColor wrap="truncate">
              {`上还有 ${String(first)} 个 · 共 ${String(props.sessions.length)} 个`}
            </Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
