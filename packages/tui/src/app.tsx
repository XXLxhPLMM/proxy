/** @fileoverview 一屏的**组合出口**：算一次几何，按区域派给各个组件（本文件不算任何坐标） */

import { Box } from "ink";

import {
  CommandPalette,
  Composer,
  OutputView,
  SessionMenu,
  SessionSidebar,
  Welcome,
} from "@/features/index.js";
import { CloseChip, Footer, Window, tone, type LayoutProps, type SessionRow } from "@/components/index.js";
import { SIDEBAR_GAP, geometry } from "@/lib/index.js";
import { themeOf } from "@/theme/index.js";

// ⚠️ 这两个类型住在 `components/types.ts`，而本文件是对外的组合出口 —— `tests/layout.test.ts`
// 就是从 `@/app.js` 取它们的。
export type { LayoutProps, SessionRow };

export function Layout(props: LayoutProps): React.JSX.Element {
  // ⚠️ **两份主题，而「是哪一份」只在这一层判**：背景层拿盖上遮罩的那份（前景被压到与遮罩几乎
  // 同色，卡片自己拿没盖的那份）—— 卡片要是也一起被压暗，「窗口叫什么」就与背后的轮廓同色。
  // ⚠️ 组件一律不判「我背后有没有遮罩」：它们照旧问「我这个语义要哪一档」。
  const plain = themeOf({ color: props.color, scrimmed: false });
  const theme = props.window === null ? plain : themeOf({ color: props.color, scrimmed: true });
  const g = geometry({
    columns: props.columns,
    rows: props.rows,
    sidebarWidth: props.sidebarWidth,
    sessionCount: props.sessions.length,
    sessionsTop: props.sessionsTop,
    input: props.input,
    paletteCount: props.palette === null ? 0 : props.palette.total,
    window: props.window !== null,
    windowRows: props.window === null ? 0 : props.window.rows.length,
    windowNote: props.window !== null && props.window.note !== null,
    menu:
      props.menu === null
        ? null
        : { x: props.menu.origin[0], y: props.menu.origin[1], items: props.menu.items },
  });
  const mainWidth = g.output === null ? 0 : g.output.width;
  // 一屏由哪几块拼成（那一带的坐标全在 `@/lib/geometry.ts`）：
  // ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│ 进程    running    pid 12345        ← Output（可滚）
  // ▓▓ 会话 1     ✕▓│ 名称    状态    上限      本月用量
  // ▓▓ live-ok    ▓│ alice   启用    1.0 GB    128.4 MB
  // ▓▓ 会话 2     ▓│  ⇅ 下方还有 12 行 · PgDn 下翻
  // ▓▓ 未选控制面  ▓│ ╭──────────────────────────────────────╮  ← CommandPalette（≤ 内容行 40%）
  // ▓▓ 3–7 / 共 12 ▓│ │  ▍ /help    列出命令，或给一条命令看用法 │
  // ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│ ╰──────────────────────────────────────╯  ← Composer（**只有它**有框）
  // ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│  ● 3   ▲ 1   ○ 2                    v5.2.0   ← Footer 在框**外**
  return (
    // ⚠️ 窗口开着时这一行铺一层 `scrim`：Ink 按**整块矩形**铺底色，故侧边栏那一列、间隔列与主区一起暗。
    // ⚠️ 它只盖得到底色 —— Ink 没有半透明，遮罩是「重铺一层不透明的底色」，背后那些**字**仍在上面
    //（子节点后画），而那一层要真是「什么都没有」，`/managers` 开着时连自己敲的什么都看不见。
    <Box
      flexDirection="row"
      width={props.columns}
      height={props.rows}
      backgroundColor={props.window === null ? undefined : tone(theme, "scrim")}
    >
      {g.sidebar === null ? null : <SessionSidebar {...props} g={g} theme={theme} />}
      {/* ⚠️ **那一列间隔必须真的占掉一个元素**：不插这个空盒子的话主区就贴在侧边栏右边，
          「画出来的」与「算给命中测试用的」错开一列。
          ⚠️ `flexShrink={0}`：Ink 的 `<Box>` 默认 `flexShrink: 1`，零内容的盒子被压缩时塌成零宽。 */}
      <Box width={SIDEBAR_GAP} height={props.rows} flexShrink={0} />
      {/* ⚠️ 主区**不画框**，宽**必须正好**是 `mainWidth`：给窄一列的话框里的子元素仍按
          `mainWidth` 要宽度，于是 Ink 静默软换行，整屏内容往下掉。 */}
      <Box flexDirection="column" width={mainWidth} height={props.rows}>
        {props.palette === null && props.showLogo ? (
          <Welcome {...props} g={g} theme={theme} />
        ) : (
          <OutputView {...props} g={g} theme={theme} />
        )}
        {props.palette === null ? null : <CommandPalette {...props} g={g} theme={theme} />}
        <Composer {...props} g={g} theme={theme} />
        <Footer {...props} g={g} theme={theme} />
      </Box>
      {/* ⚠️ **卡片与那枚 esc 是绝对定位的两个兄弟，且必须排在最后**：Ink 逐个把节点写进同一张格子表，
          后写的覆盖先写的 —— 故「esc 压在卡片上、压在标题那一行的右端」不需要任何负偏移。
          ⚠️ 两处都喂 **`plain`**（没盖遮罩的那份主题）。 */}
      {props.window === null ? null : <Window {...props} g={g} theme={plain} />}
      {props.window === null || g.windowClose === null ? null : (
        <CloseChip {...props} g={g} theme={plain} />
      )}
      {/* ⚠️ **菜单排在最后**：它浮在侧边栏与输入框**之上**，而它是绝对定位的（`left` / `top` 读几何层）
          —— 排在中间的话输入框那圈边框会盖在它上面（Ink 的边框后画就赢）。 */}
      <SessionMenu {...props} g={g} theme={plain} />
    </Box>
  );
}