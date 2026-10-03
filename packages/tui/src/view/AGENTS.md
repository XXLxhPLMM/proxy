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
- ⚠️ **输入框是整屏唯一带框的一块**（模态是**没有框**的一块卡片），**状态行在框外**贴着屏底；`inputFramed` 由几何层决定，放不下就**如实不画框**。
- **矩形一律半开区间** `[x, x+w)` × `[y, y+h)`，真重叠时**后来者赢**；非整数坐标 `hitTest` 返回 `-1`。
- **选中态没有反底色**（最亮那一档 + 加粗），那一列的底色归 **hover** —— 「我选了哪台」与「指针在哪」是两个通道。
- ⚠️ **模态窗口开着时背后那层的点击与键盘全被吞掉**，`CloseChip` 画在 `Window` 之后。

### ⚠️ 模态那一组：**尺寸与落点只认整屏**，**没有框**，而**遮罩必须盖住整屏**

- **落点与宽高只由 `columns` / `rows` 决定**（`geometry.ts:windowRect`）：宽 = 整屏 × `WINDOW_WIDTH_RATIO`
  （至少 `WINDOW_MIN_WIDTH`）、高 = **屏高 × `WINDOW_HEIGHT_RATIO` 与「内容要几行」里大的那个**
  （至少 `WINDOW_MIN_HEIGHT`，上限屏高减二）。⚠️ 按主区算的话，拖一下侧边栏窗口就变形，
  而它在宽屏上会整个泡在主区里 —— 读起来是「内容区里的一块小面板」，不是「压在整屏上的一块东西」。
- ⚠️ **它没有框**：`windowContent` **恒等于** `windowBox`，而「浮在上面」靠的是**明暗差**
  （浅遮罩 + 深卡片）。⚠️ 右上角那一枚 `esc` 因此**坐在标题那一行**上，而标题的裁剪预算
  **必须读 `Geometry.windowTitle`**（它已经把 `esc` 那几列让出来了）—— 两处各减一次就是长标题压住 `esc`。
- ⚠️ **Ink 没有半透明，遮罩是「重新铺一层不透明底色」**：而**任何自己带底色的盒子都会盖在它上面**
  （后画的赢），**任何带边框的盒子都会把它挖空**（`render-border` 只读节点自己的 `borderBackgroundColor`，
  **不继承**祖先底色）。故遮罩开着时：侧边栏那一列拿**遮罩态的 `surface`**、输入框那两行上下框给
  `borderBackgroundColor={scrim}`、卡片与 `esc` 那一枚自带 `panel` 那一档。
  ⚠️ 症状全是「屏上看着没毛病」：整屏洗白了而侧边栏没洗、屏最底下横着两条亮线 —— **判据只能逐格比两帧**
  （`tests/layout.test.ts` ⑥「背后整屏洗白」），查「某一个格子有没有遮罩」对它恒绿。
- ⚠️ **模态开着时输入框**不画插入符**：按键已全被窗口吃掉（`use-keyboard.ts`），而屏上留着一个
  反底色的光标块等于说「焦点还在输入框」。

### ⚠️ 侧边栏那一列：三个**必须一起记**的事实

1. **`sidebarRows[i]` 是第 `sessionFirst + i` 个会话**（`Geometry.sessionFirst`）。呈现层切片与
   `@/app/use-mouse.ts` 的每一处回查**都要加它** —— 漏一处的症状是「画的是会话 3、点的是会话 1」，
   而**全屏没有一处会因此报错**。几何层**只夹不推**（它故意不管「当前会话必须在窗口里」），
   那份判断住在 `@/app/app.tsx:revealSession`。
2. **第一项之上有 `SIDEBAR_TOP_MARGIN` 行留白，而它必须由 `sidebar.tsx` 显式画成一个 `height` 定的
   空盒子**：Ink 不替我们留，少一个盒子时每一项都往上挪一整行，而命中测试仍按几何（含留白）判。
3. **`SESSION_CLOSE_COLUMNS` 那两列是恒预留的**（理由写在 `geometry.ts` 的常量注释里）：名字的裁剪
   预算**恒**扣掉它，与「指针在哪儿」无关 —— 悬停只决定**画不画**那一枚 `✕`，不决定**文字有多宽**。
   ⚠️ `✕`（U+2715）在 East Asian Width 里是 **Ambiguous**，而 `string-width` 按一列算。

⚠️ **溢出说明行是判据而不只是坐标**：呈现层按 `sidebarOverflowRow` 是不是 `null` 决定画不画那句话，
而它的文案**必须跟着窗口滚**（写死首项号的实现会在滚过之后说「1–5」而屏上是 3–7）。

## 相关

`@/ui/index.js`（`themeOf` / `toneColor` / `widthOf` / `ellipsis` / `padToWidth` / `BANNER`） · `@/log/index.js`（`flatten()` 的行由 `output.tsx` 画） · `@/app/app.tsx`（唯一上游，`LayoutProps` 里没有一个坐标）
`tests/geometry.test.ts`（九条纯算术） · `tests/layout.test.ts` + `tests/input.test.ts`（假 TTY 真渲染）
