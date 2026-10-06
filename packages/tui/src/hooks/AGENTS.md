# src/hooks/ — 输入订阅挂在哪儿

三个 React 订阅口，各**只有一处**：键位（`useHotkeys.ts`，本包唯一挂 `useInput` 的文件）、鼠标（`useMouse.ts`，
唯一挂 `mouse.onMouse` 的文件）、终端宽高（`useTerminalSize.ts`，唯一挂 `resize` 的文件）。对外唯一出口
`@/hooks/index.js`。宿主采集与退出边界在 `@/cli.tsx`。

## 相关

`@/AppState.js`（唯一调用方，它把回调造好传进来）· `@/services/terminal/index.js`（鼠标事件源，生命周期归组合根）
`@/commands/index.js`（`enterOutcomeOf`）· `@/store/index.js` · `@/lib/index.js`（`Geometry.window*` 那一族格子）
`tests/input/`（喂进去的鼠标报告一个字都不许进输入行 + 面板整条交互 + **历史会话弹窗整条交互** + **改窗口大小那一档**）