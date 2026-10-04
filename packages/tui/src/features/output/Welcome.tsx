/**
 * @fileoverview 引导屏：主区**正中**那一块（标记 + 底下几行提示）；⚠️ 位置与尺寸读 `Geometry.welcome`，放不下就不画标记而仍画提示
 */

import { Box, Text } from "ink";
import { LOGO, LOGO_TAG } from "./logo.js";
import { ellipsis } from "@/lib/index.js";
import type { Tone } from "@/theme/index.js";
import { tone } from "@/components/index.js";
import type { RegionProps } from "@/components/index.js";

export function Welcome(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  if (g.output === null) return <Box />;
  const width = g.outputWidth;
  const mark = g.welcome;

  const hints: Array<{ readonly text: string; t: Tone }> = [];
  if (props.managerStates.length === 0) {
    hints.push({
      text: "台账里还没有控制面。用 target add <名字> <地址> <token> 加一个。",
      t: "muted",
    });
  } else {
    hints.push({
      // ⚠️ 键位**必须与 `@/hooks/useHotkeys.ts` 的键位表逐字一致**：说「回车切」而回车是「执行命令」时，
      // 操作者会先按一次回车、看见自己那条空命令没有任何反应。
      text: "左边点一个会话（或按 ↑ ↓ 切换）。控制面用 /managers 选。help 看全部。",
      t: "muted",
    });
  }
  if (props.mouseHint !== null) hints.push({ text: props.mouseHint, t: "warn" });

  return (
    <Box flexDirection="column" width={g.output.width} height={g.outputBlockRows}>
      {mark === null ? null : <Box height={mark.y} flexShrink={0} />}
      {/* ⚠️ **横向的偏移是 `marginLeft`**：Ink 的列向盒把子元素顶格排，而「居中」由几何层算成
          一个绝对列号 —— 偏移是**相对结果区左缘**的（`mark.x - output.x`）。 */}
      {mark === null ? null : (
        <Box flexDirection="column" marginLeft={mark.x - g.output.x} flexShrink={0}>
          {/* ⚠️ **逐行一色**（素材自带 truecolor），而它**不是**主题 token：无色档下**一个字都不上色**。 */}
          {LOGO.map((line, i) => (
            <Text key={i} color={props.color ? line.color : undefined}>
              {line.text}
            </Text>
          ))}
          <Text color={tone(theme, "muted")}>
            {" ".repeat(Math.floor((mark.width - LOGO_TAG.length) / 2))}
            {LOGO_TAG}
          </Text>
        </Box>
      )}
      {/* ⚠️ 提示接在**标记之下**、中间恒隔一行 —— 贴着艺术字底部的那行字会读成艺术字的一部分。
          ⚠️ **居中由 `alignItems` 做而本层一次都不算列号**：那一列的行盒宽 = 字宽，故 Yoga 把它摆在
          （内容区宽 − 字宽）的一半处；而 {@link mark} 的偏移是几何层给的**绝对**列号，两者不是同一件事，
          故这一段必须是**独立**的一个盒子（给上面那个盒子加 `alignItems` 会连艺术字一起再挪一次）。 */}
      <Box flexDirection="column" alignItems="center" flexShrink={0}>
        {hints.map((line, i) => (
          <Box key={i} height={1} marginTop={1} flexShrink={0}>
            <Text color={tone(theme, line.t)}>{ellipsis(line.text, width)}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}