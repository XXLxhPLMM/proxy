# src/hooks/ — 输入订阅挂在哪儿

三个 React 订阅口，各**只有一处**：键位（`useHotkeys.ts`，本包唯一挂 `useInput` 的文件）、鼠标（`useMouse.ts`，
唯一挂 `mouse.onMouse` 的文件）、终端宽高（`useTerminalSize.ts`，唯一挂 `resize` 的文件）。对外唯一出口
`@/hooks/index.js`。宿主采集与退出边界在 `@/cli.tsx`。

## 层不变量

- ⚠️ **三个订阅口各只有一处**：多挂一处的后果不是「多一次重绘」，是「这份输入/这份宽高从哪来」有了第二个答案。
- ⚠️ **不用 Ink 的 `useWindowSize`**：它自带一份兜底（`terminal-size` 再 80×24），会把组合根那份快照在第一次
  resize 之前旁路掉 —— 推导写在 `useTerminalSize.ts` 文件头。
- ⚠️ **少订阅一次 `resize` 的症状不是「不重绘」**：Ink 自己会重排它手里那**上一帧**（按旧尺寸算的那一帧），且
  宽度**变窄**时它先 `clearTerminal` 再把那一帧填回去 —— 屏上于是停着一帧旧布局，永不修复。
- ⚠️ **`columns` / `rows` 只是初值**，而屏上用的是 `useTerminalSize()` 的**当前值**：凡是喂 `geometry()` 与喂
  `<Layout>` 的都读它。拿 props 算 = 「Ink 已按新尺寸重排、本层还按旧尺寸算」的两份几何。
- ⚠️ **输入行有两道闸，顺序是先认领再入状态**：`isMouseReport`（`useHotkeys.ts`）认领终端报文，
  `printableOnly`（`@/lib/input-line.js`）剔 C0 与 `DEL` —— **少任何一道都不成立**（前者不认粘贴进来的 `U+000D`，
  后者挡不住已被 Ink 摘掉 `ESC` 的报文）。
- ⚠️ **模态开着时按键先归窗口**：除 `Esc` / `↑↓` / `Tab` / `Enter` 全被吃掉，且窗口那一支排在任何其它判定之前。
- ⚠️ **`Ctrl+C` 到不了这里**（Ink 自己先处理了它），故本层不实现它。
- ⚠️ **`down` 的判据次序不可换**：窗口（模态）→ 按键 → 手柄 → 「✕」→ 会话项 → 面板 → 输入行；**手柄与那些会话项
  重叠**，反过来会让「按着最右那列拖宽」在起手那一瞬把会话切掉。
- ⚠️ **只有 `move` 认 hover**：`down` 的命中测试**不看**悬停（悬停状态来自上一次 `move` 事件）—— 一次没有
  `move` 的点击会带着过期的悬停状态进来。
- ⚠️ **`useMouse` 的依赖表刻意不含 `set*` 与 `resizingRef`**：前者是 React 恒定的 setter、后者是恒定的 ref。

## 相关

`@/AppState.js`（唯一调用方，它把回调造好传进来）· `@/services/terminal/index.js`（鼠标事件源，生命周期归组合根）
`@/commands/index.js` · `@/store/index.js` · `tests/input.test.ts`（喂进去的鼠标报告一个字都不许进输入行 + 面板整条交互 + **改窗口大小那一档**）