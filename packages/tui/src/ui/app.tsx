/** @fileoverview 一屏的**组合出口**：纯 flex，按区域派给各个组件（本文件不算任何坐标） */

import { Box } from "ink";

import {
  CommandPalette,
  Composer,
  ModelStatusLine,
  OutputView,
  SessionMenu,
  SessionSidebar,
  Welcome,
} from "@/ui/features/index.js";
import {
  Footer,
  Window,
  tone,
  type LayoutProps,
  type SessionRow,
} from "@/ui/components/index.js";
import { themeOf } from "@/ui/theme/index.js";

// ⚠️ 这两个类型住在 `components/types.ts`，而本文件是对外的组合出口。
export type { LayoutProps, SessionRow };

export function Layout(props: LayoutProps): React.JSX.Element {
  // ⚠️ **两份主题，而「是哪一份」只在这一层判**：背景层拿盖上遮罩的那份（前景被压到与遮罩几乎同色，
  // 卡片自己拿没盖的那份）—— 卡片一起被压暗的话「窗口叫什么」就与背后的轮廓同色。⚠️ **七档都算「开着」**：
  // 漏掉任何一档整屏都不会被压暗，而症状是「卡片浮在一块亮屏上」。
  const open = props.view !== null;
  const plain = themeOf({ color: props.color, scrimmed: false });
  const theme = open ? themeOf({ color: props.color, scrimmed: true }) : plain;
  const showSidebar = props.sessions.length > 0 && props.sidebarWidth > 0 && props.mainWidth < props.columns;
  return (
    // ⚠️ 窗口开着时这一行铺一层 `scrim`：Ink 按**整块矩形**铺底色，故侧边栏那一列、间隔列与主区一起暗。
    // ⚠️ 它只盖得到底色 —— Ink 没有半透明，遮罩是「重铺一层不透明的底色」，背后那些**字**仍在上面
    //（子节点后画），而那一层要真是「什么都没有」，`/managers` 开着时连自己敲的什么都看不见。
    <Box
      flexDirection="row"
      width={props.columns}
      height={props.rows}
      backgroundColor={open ? tone(theme, "scrim") : undefined}
    >
      {showSidebar ? <SessionSidebar {...props} theme={theme} /> : null}
      {/* ⚠️ **那一列间隔必须真的占掉一个元素**：不插这个空盒子的话主区就贴在侧边栏右边。
          ⚠️ `flexShrink={0}`：Ink 的 `<Box>` 默认 `flexShrink: 1`，零内容的盒子被压缩时塌成零宽。 */}
      <Box width={1} height={props.rows} flexShrink={0} />
      {/* ⚠️ 主区**不画框**，宽**必须正好**是 `mainWidth`：给窄一列的话框里的子元素仍按
          `mainWidth` 要宽度，于是 Ink 静默软换行，整屏内容往下掉。 */}
      <Box flexDirection="column" width={props.mainWidth} height={props.rows}>
        {props.palette === null && props.showLogo ? (
          <Welcome {...props} theme={theme} />
        ) : (
          <OutputView {...props} theme={theme} />
        )}
        {props.palette === null ? null : <CommandPalette {...props} theme={theme} />}
        <Composer {...props} theme={theme} />
        {/* ⚠️ **「提供商 · 推理强度」夹在输入框与底部状态行之间**：它是「这一次的问话发去哪里」，
            而它必须**在框外**（框是「我现在能敲字的地方」，而这一行不是可编辑内容）。 */}
        <ModelStatusLine {...props} theme={theme} />
        <Footer {...props} theme={theme} />
      </Box>
      {/* ⚠️ **卡片是绝对定位的 overlay，必须排在最后**：Ink 逐个把节点写进同一张格子表，
          后写的覆盖先写的。⚠️ 卡片喂 **`plain`**（没盖遮罩的那份主题）—— 一起被压暗的话
          「窗口叫什么」就与背后的轮廓同色。⚠️ 那枚 `esc` 已收进卡片标题行（`WindowCard`
          内 `space-between` 的右端），这里不再单画。 */}
      {open ? <Window {...props} theme={plain} /> : null}
      {/* ⚠️ **菜单排在最后**：它浮在侧边栏与输入框**之上** —— 排在中间的话输入框那圈边框会盖在它上面（Ink 的边框后画就赢）。 */}
      <SessionMenu {...props} theme={plain} />
    </Box>
  );
}
