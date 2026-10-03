# src/view/ — 界面层（几何 + 组件）

**坐标的算术真相**（`geometry.ts`）与**把坐标画出来**（`layout.tsx` + `components/`）。本目录是本包唯一
挂 Ink 的地方，也是唯一知道「一屏长什么样」的地方；对外唯一出口 `@/view/index.js`。
**零 HTTP、零 `fs`**：只认「一行字 + 一个颜色」，不认识控制面任何字段语义。

| 路径 | 答什么 |
|---|---|
| `geometry.ts` | 整屏每一个矩形的唯一来源（`geometry()` / `hitTest` / 折行 / 插入符定位） |
| `components/types.ts` | 组件 props 契约（`LayoutProps` / `SessionRow` / `PaletteView` / `WindowView` …），**零组件** |
| `components/constants.ts` | 两个以上组件共用的常量（`PROMPT` / `ECHO_PREFIX` / 高亮记号）与 `tone()` |
| `components/*.tsx` | 每组件一个文件：`sidebar` / `palette` / `output` / `welcome` / `input-block` / `status-line` / `window` / `close-chip` |
| `layout.tsx` | 根组件 `Layout`：把这些块组装成整屏 |
| `index.ts` / `components/index.ts` | barrel，只转发 |

## 层不变量

- ⚠️ **绘制与命中测试读同一个 `geometry()` 结果**：组件一行坐标都不许自己从 props 算，`Geometry.inputTextRows` 是唯一那份「字画在哪」的数组。
- ⚠️ **输入框是整屏唯一带框的一块**（模态窗口除外），**状态行在框外**贴着屏底；`inputFramed` 由几何层决定，放不下就**如实不画框**。
- **矩形一律半开区间** `[x, x+w)` × `[y, y+h)`，真重叠时**后来者赢**；非整数坐标 `hitTest` 返回 `-1`。
- **选中态没有反底色**（最亮那一档 + 加粗），那一列的底色归 **hover** —— 「我选了哪台」与「指针在哪」是两个通道。
- ⚠️ **模态窗口开着时背后那层的点击与键盘全被吞掉**，`CloseChip` 画在 `Window` 之后。

## 相关

`@/ui/index.js`（`themeOf` / `toneColor` / `widthOf` / `ellipsis` / `padToWidth` / `BANNER`） · `@/log/index.js`（`flatten()` 的行由 `output.tsx` 画） · `@/app/app.tsx`（唯一上游，`LayoutProps` 里没有一个坐标）
`tests/geometry.test.ts`（九条纯算术） · `tests/layout.test.ts` + `tests/input.test.ts`（假 TTY 真渲染）
