/**
 * @fileoverview 引导屏：当前会话还没有任何输出时，主区顶上那一块（logo + 副标 + 一句话）
 * @module view/components/welcome
 * @description
 * ⚠️ 它**只是主区里的一段文字**（没框、可被输出顶掉），故高度与 {@link ./output.js:Output} 是同一块
 * {@link ../geometry.js:Geometry.outputBlockRows} —— 两处各算一次就会差一行。
 * @module
 */

import { Box, Text } from "ink";
import { BANNER, TAGLINE } from "@/ui/logo.js";
import { ellipsis } from "@/ui/format.js";
import type { Tone } from "@/ui/theme.js";
import { tone } from "./constants.js";
import type { RegionProps } from "./types.js";

export function Welcome(props: RegionProps): React.JSX.Element {
  const { g, theme } = props;
  if (g.output === null) return <Box />;
  const width = g.outputWidth;
  const body: Array<{ readonly text: string; t: Tone }> = [
    ...BANNER.map((text) => ({ text, t: "accent" as const })),
    { text: TAGLINE, t: "muted" as const },
    { text: "", t: "muted" as const },
  ];
  if (props.managerStates.length === 0) {
    body.push({
      text: "台账里还没有控制面。用 target add <名字> <地址> <token> 加一个。",
      t: "muted",
    });
  } else {
    body.push({
      // ⚠️ 键位**必须与 `@/app.tsx` 的键位表逐字一致**：说「回车切」而回车是「执行命令」时，操作者会先
      // 按一次回车、看见自己那条空命令没有任何反应。⚠️ 「控制面在哪选」这一句必须在这里说 ——
      // 控制面**不在侧边栏**了，于是「怎么换控制面」只剩 `/managers` 一个入口，而这是第一次看到它的
      // 人唯一读到的地方。
      text: "左边点一个会话（或按 ↑ ↓ 切换）。控制面用 /managers 选。help 看全部。",
      t: "muted",
    });
  }
  if (props.mouseHint !== null) body.push({ text: props.mouseHint, t: "warn" });
  return (
    <Box flexDirection="column" width={g.output.width} height={g.outputBlockRows}>
      {body.slice(0, g.outputRows).map((line, i) => (
        <Text key={i} color={tone(theme, line.t)}>
          {ellipsis(line.text, width)}
        </Text>
      ))}
    </Box>
  );
}