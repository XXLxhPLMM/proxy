/**
 * @fileoverview 一屏的**组合出口**：算一次几何，按区域派给各个组件
 * @module view/layout
 * @description
 * 全屏 console 的**纯呈现**，而**本文件不算任何坐标**：每个组件画在哪都读同一个 {@link geometry}
 * 结果，故绘制与命中测试在类型上就不可能错开。
 *
 * ## 一屏由哪几块拼成（那一带的坐标全在 {@link ./geometry.ts} 的文件头）
 *
 * ```
 * ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│ 进程    running    pid 12345        ← Output（可滚）
 * ▓▓ 会话 1     ▓│ 名称    状态    上限      本月用量
 * ▓▓ live-ok    ▓│ alice   启用    1.0 GB    128.4 MB
 * ▓▓ 会话 2     ▓│  ⇅ 下方还有 12 行 · PgDn 下翻
 * ▓▓ 未选控制面  ▓│ ╭──────────────────────────────────────╮  ← Palette（≤ 内容行 40%）
 * ▓▓ …还有 3 个  ▓│ │  ▍ /help    列出命令，或给一条命令看用法 │
 * ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│ ╰──────────────────────────────────────╯  ← InputBlock（**只有它**有框）
 * ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│  ● 3   ▲ 1   ○ 2                    v5.2.0   ← StatusLine 在框**外**
 * ```
 *
 * ## 三条**跨区域**的判据
 * @description 各块自己的判据写在那个组件的文件头；下面三条只有在这一层才成立。
 * - **顶部零横向区域**：全部会话级事实都在底部状态行，而「现在是哪个会话」由侧边栏那一项的**文字
 *   颜色**回答 —— 顶部那一行是整屏最贵的一行，不拿去重复已经有的信息。
 * - **整屏只有输入区与模态窗口带框**：满屏接管之后屏上并没有别的窗口，多一圈竖线只会把一屏切成
 *   两块「小窗口」。
 * - **每一行都裁到它的可用宽度**（`@/ui/format.js:ellipsis` 是**唯一**裁剪出口）：Ink 对过宽的
 *   `<Text>` 是**静默软换行**，一换行整屏就往下移，而屏上没有任何东西解释它去哪了。
 *
 * ## 已知缺口（是「不变量」，不是「没来得及」）
 *
 * - **窗口开着时背后的点击全部被吞掉**：这是模态的定义。⚠️ 代价是「关掉窗口」只有两条路（点右上角
 *   那枚 `esc` / 按 `Esc`），而两条**必须都在** —— 只有一条的话，另一种终端上窗口就出不来了。
 *
 * @module
 */

import { Box } from "ink";
import { themeOf } from "@/ui/theme.js";
import { SIDEBAR_GAP, geometry } from "./geometry.js";
import {
  CloseChip,
  InputBlock,
  Output,
  Palette,
  Sidebar,
  StatusLine,
  Welcome,
  Window,
} from "./components/index.js";
import type { LayoutProps, SessionRow } from "./components/types.js";
import { tone } from "./components/constants.js";

// ⚠️ 这两个类型住在 `components/types.ts`，而**本文件是对外的组合出口** —— 于是这里转发一次
// （`tests/layout.test.ts` 就是从 `@/view/layout.js` 取它们的）。
export type { LayoutProps, SessionRow };

export function Layout(props: LayoutProps): React.JSX.Element {
  const theme = themeOf(props.color);
  // ⚠️ **与 `@/app.tsx` 喂的是同一个对象上的同一组字段**（那份对象就是本 props），故两处
  // {@link geometry} 的结果逐字相同。
  const g = geometry({
    columns: props.columns,
    rows: props.rows,
    sidebarWidth: props.sidebarWidth,
    input: props.input,
    paletteCount: props.palette === null ? 0 : props.palette.total,
    window: props.window !== null,
    windowRows: props.window === null ? 0 : props.window.rows.length,
    windowFooter: props.window !== null && props.window.footer !== null,
  });
  const mainWidth = g.output === null ? 0 : g.output.width;
  return (
    // ⚠️ **窗口开着时这一行铺一层 `scrim`**：这就是「窗口背面的颜色变浅」的实现 —— Ink 按**整块
    // 矩形**铺背景，故侧边栏那一列、间隔列与主区一起变浅。
    <Box
      flexDirection="row"
      width={props.columns}
      height={props.rows}
      backgroundColor={props.window === null ? undefined : tone(theme, "scrim")}
    >
      {g.sidebar === null ? null : <Sidebar {...props} g={g} theme={theme} />}
      {/* ⚠️ **那一列间隔必须真的占掉一个元素**：Ink 只把**兄弟**排在一起，不插这个空盒子的话主区
          就贴在侧边栏右边，「画出来的」与「算给命中测试用的」错开一列。
          ⚠️ `flexShrink={0}`：Ink 的 `<Box>` 默认 `flexShrink: 1`，零内容的盒子被压缩时塌成零宽。 */}
      <Box width={SIDEBAR_GAP} height={props.rows} flexShrink={0} />
      {/* ⚠️ 主区**不画框**，宽**必须正好**是 `mainWidth`：给窄一列的话框里的子元素仍按
          `mainWidth` 要宽度，于是 Ink 静默软换行，整屏内容往下掉。 */}
      <Box flexDirection="column" width={mainWidth} height={props.rows}>
        {props.palette === null && props.showLogo ? (
          <Welcome {...props} g={g} theme={theme} />
        ) : (
          <Output {...props} g={g} theme={theme} />
        )}
        {props.palette === null ? null : <Palette {...props} g={g} theme={theme} />}
        <InputBlock {...props} g={g} theme={theme} />
        <StatusLine {...props} g={g} theme={theme} />
      </Box>
      {/* ⚠️ **窗口与那枚 esc 是绝对定位的两个兄弟，且必须排在最后**：Ink 逐个把节点写进同一张格子表，
          后写的覆盖先写的 —— 故「esc 压在窗口上边框上」不需要任何负偏移。 */}
      {props.window === null ? null : <Window {...props} g={g} theme={theme} />}
      {props.window === null || g.windowClose === null ? null : (
        <CloseChip {...props} g={g} theme={theme} />
      )}
    </Box>
  );
}