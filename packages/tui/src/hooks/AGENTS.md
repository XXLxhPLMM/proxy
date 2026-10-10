# src/hooks/ — 输入订阅挂在哪儿

一个 React 订阅口，**只有一处**：键位（`useHotkeys.ts`，本包唯一挂 `useInput` 的文件）。对外唯一出口
`@/hooks/index.js`。宿主采集与退出边界在 `@/cli.tsx`。

## 相关

`@/AppState.js`（唯一调用方，它把回调造好传进来）
`@/commands/index.js`（`enterOutcomeOf`）· `@/store/index.js`