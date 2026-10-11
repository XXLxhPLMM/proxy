/**
 * @fileoverview 鼠标能力的对外出口：只转出 `useMouse` 这一个 hook
 * @module ink-ui/hooks/mouse
 * @description
 * 视图层要用鼠标，只认这一个入口：`@/ink-ui/hooks/mouse/index.js`。
 *
 * ⚠️ **barrel 只出 `useMouse` 与它的选项类型**：`protocol.ts` / `tracking.ts` 是同目录的
 * 实现细节（零 IO 的解码与开关码拼串），不往外转。要直接解上报——比如按键处理器滤掉漏进
 * `useInput` 的鼠标噪声（见 `use-mouse.ts` 的 ⚠️）——自己从 `@/ink-ui/hooks/mouse/protocol.js` 引。
 */

export { useMouse } from "./use-mouse.js";
export type { UseMouseOptions } from "./use-mouse.js";