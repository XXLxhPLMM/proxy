/**
 * @fileoverview 引导屏：主区那一块（标记 + 底下几行提示）；flex 居中
 */

import { Box, Text } from "ink";
import { StatusMessage } from "@inkjs/ui";
import { LOGO, LOGO_TAG } from "./logo.js";
import { tone } from "@/ui/components/index.js";
import type { RegionProps } from "@/ui/components/index.js";

export function Welcome(props: RegionProps): React.JSX.Element {
  const { theme } = props;
  const noManagers = props.managerStates.length === 0;
  return (
    <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
      {/* ⚠️ 标记与提示都用 flex 居中 */}
      <Box flexDirection="column" alignItems="center" flexShrink={0}>
        {/* ⚠️ **逐行一色**（素材自带 truecolor），而它**不是**主题 token：无色档下**一个字都不上色**。 */}
        {LOGO.map((line, i) => (
          <Text key={i} color={props.color ? line.color : undefined}>
            {line.text}
          </Text>
        ))}
        <Text color={tone(theme, "muted")}>{LOGO_TAG}</Text>
      </Box>
      {/* ⚠️ 提示接在**标记之下**、中间恒隔一行 —— 贴着艺术字底部的那行字会读成艺术字的一部分。 */}
      <Box flexDirection="column" marginTop={1} flexShrink={0} alignItems="center">
        <StatusMessage variant="info">
          {noManagers
            ? "台账里还没有控制面。用 target add <名字> <地址> <token> 加一个。"
            : "左边点一个会话（或按 ↑ ↓ 切换）。控制面用 /managers 选。help 看全部。"}
        </StatusMessage>
      </Box>
    </Box>
  );
}
