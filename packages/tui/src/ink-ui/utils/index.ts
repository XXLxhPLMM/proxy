/**
 * @fileoverview ink-ui 的通用工具出口：跨层可用的纯逻辑（零 IO、零 React、不依赖上层）
 * @module ink-ui/utils
 * @description
 * 上层要用这些工具，只认这一个入口：`@/ink-ui/utils/index.js`。
 *
 * ⚠️ **本目录是叶子层**：自己**不许**引 `hooks/` / `layout/` / `views/` / `components/` / `store/`
 * —— 反向依赖会成环，而本包的 lint/typecheck 都拦不住循环 import。策略（哪些事件该合并之类）
 * 归调用方，这里只管机制。
 *
 * ⚠️ 这里允许的工具**没有调用者也可以留着**（如 `memo.ts`）：它们是通用机制，不是应用代码，
 * 判定标准是「接线之后收益是否为正」。但**未被接线的工具没有测试兜底**，改动它得自己核对语义。
 */

export { throttle, debounce } from "./flow-control.js";
export type { PacedFn } from "./flow-control.js";
export { createLastCallMemo } from "./memo.js";
