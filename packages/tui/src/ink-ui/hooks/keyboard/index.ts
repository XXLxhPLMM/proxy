/**
 * @fileoverview 键盘能力的对外出口：转出 `useKeyboard` 与键盘事件的类型词汇
 * @module ink-ui/hooks/keyboard
 * @description
 * 视图层要用键盘，只认这一个入口：`@/ink-ui/hooks/keyboard/index.js`。
 *
 * ⚠️ **barrel 只转出 hook、选项类型与事件类型**：`keys.ts` 是同目录的实现细节（零 IO 的归一
 * 函数），不往外转。事件类型反而必须转出——处理器多半是单独定义的函数，标注参数类型时要用
 * （与 `hooks/mouse` 的 barrel 只转 `useMouse` 一处不同，理由就在这）。
 */

export { useKeyboard } from "./use-keyboard.js";
export type { UseKeyboardOptions } from "./use-keyboard.js";
export type { KeyboardEvent, KeyModifiers, NamedKey } from "./keys.js";