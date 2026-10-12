/**
 * @fileoverview 鼠标能力的对外出口：中心源的三个消费者 + 一对应用级开关 + 事件类型 + 噪声判据
 * @module ink-ui/hooks/mouse
 * @description
 * 要用鼠标，只认这一个入口：`@/ink-ui/hooks/mouse/index.js`。
 *
 * 三类调用方，别串岗：
 * - **组合根**（`starter/plugins/ui.tsx`）：`startMouse` / `stopMouse`。开 / 关跟进程生命周期走。
 * - **应用根**（`app.tsx`）：`useMouseInput`。接线一次，别处不许调。
 * - **视图**：`useMouse`（事件）/ `useMouseState`（采样）。不碰开关，也不知道谁在开。
 *
 * ⚠️ **事件类型与 `isMouseSequence` 必须转出**：处理器多半是单独定义的函数，标注参数类型要用
 * `MouseEvent`；而**每个**按键处理器都得先滤掉漏进 `useInput` 的鼠标上报（见 `use-mouse.ts` 的
 * ⚠️ —— 跟踪常开，这类噪声一直都在），让它们为此深引 `protocol.js` 等于把「跨目录走 barrel」的
 * 规约变成一条人人违反的规约（与 `hooks/keyboard` 转出事件类型同理）。
 *
 * `tracking.ts`（控制码怎么拼）与 `source.ts` 的内部件（快照 / 订阅 / 节流器）仍是实现细节，
 * 不往外转。
 */

export { useMouse, useMouseInput, useMouseState } from "./use-mouse.js";
export { startMouse, stopMouse } from "./source.js";
export { isMouseSequence } from "./protocol.js";
export type {
  MouseButton,
  MouseEvent,
  MouseEventType,
  MouseModifiers,
  WheelDirection,
} from "./protocol.js";
