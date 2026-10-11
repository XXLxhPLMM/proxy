/**
 * @fileoverview `useKeyboard`：结构化键盘事件（ink 7 的 `useInput` 外面那层归一）
 * @module ink-ui/hooks/keyboard/use-keyboard
 * @description
 * 一件事：把 ink 收到的输入折成 `KeyboardEvent` 回调出去，顺带滤掉混进来的鼠标上报。
 * 归一规则与键位词表在同目录 `keys.ts`（零 IO 纯模块），这里只管「谁在用」：React 生命周期。
 *
 * ```tsx
 * useKeyboard((event) => {
 *   if (event.type === "paste") return insert(event.text);
 *   if (event.type === "text") {
 *     if (event.modifiers.ctrl) return; // Ctrl+字母在 ink 那边已翻成 text，快捷键走这条
 *     return insert(event.text);
 *   }
 *   if (event.key === "return") return submit();
 *   if (event.key === "backspace") return erase();
 * });
 * ```
 *
 * ⚠️ **别在本层碰 stdin**：ink 自己是用 `'readable'` + `stdin.read()` **拉**输入的
 * （它 `components/App.js` 的 attachReadableListener）。往同一个流上挂 `'data'` 监听器会把它切进
 * flowing 模式，ink 的 `read()` 就再也读不到数据 ⇒ 全应用键盘输入死掉（多个监听器不是广播，
 * 谁先 `read()` 谁拿走字节）。要原始字节只能另开一条流，本包不开。
 *
 * ⚠️ **Ctrl+C 永远到不了这里**：ink 的 `render()` 默认 `exitOnCtrlC: true`，`\x03` 在它派发给
 * `useInput` 之前就被 `handleExit()` 吃掉了。想拿 Ctrl+C 当快捷键，得在渲染入口
 * （`starter/plugins/ui.tsx`）显式传 `exitOnCtrlC: false`，并自己接管退出。
 *
 * ⚠️ **`paste: true` 是全应用的一次性决定**：bracketed paste（`\x1b[?2004h`）是**终端全局**开关，
 * 而 ink 对粘贴的路由也是**进程全局**的——只要进程里存在任何一个 `usePaste` 订阅者，整块粘贴就
 * 全走 paste 通道，一个字也不会再进 `useInput`。所以要么全应用都不开（粘贴表现为多字符
 * `text` 事件，与连打不可区分），要么所有要处理粘贴的地方都开。
 *
 * 多个组件同时 `useKeyboard` 没问题：ink 的 raw mode 与 bracketed paste 都是引用计数，
 * 最后一个使用者卸载时才整体关。
 */

import { useInput, usePaste } from "ink";
import type { KeyboardEvent } from "./keys.js";
import { toKeyboardEvent } from "./keys.js";

export interface UseKeyboardOptions {
  /** 是否捕获：关掉时不订阅、不碰终端模式（默认 `true`） */
  isActive?: boolean;
  /** 整块粘贴走独立的 `paste` 事件（默认 `false`）——语义见文件头 ⚠️ */
  paste?: boolean;
}

/**
 * 捕获键盘事件：命名键、可打印文本（Ctrl 组合在这里）、整块粘贴。
 *
 * 鼠标上报不往回调（那是 `useMouse` 的事）；ink 丢掉的键（F1–F12 / insert / clear）也
 * 不报——理由见同目录 `keys.ts` 的文件头。
 */
export function useKeyboard(
  handler: (event: KeyboardEvent) => void,
  options: UseKeyboardOptions = {},
): void {
  const { isActive = true, paste = false } = options;

  // `useInput` 自带 raw mode：没有它就没有输入
  useInput(
    (input, key) => {
      const event = toKeyboardEvent(input, key);
      if (event !== null) handler(event);
    },
    { isActive },
  );

  // 粘贴走 ink 的独立通道（见文件头 ⚠️），不与按键混在同一支里
  usePaste((text) => handler({ type: "paste", text }), { isActive: isActive && paste });
}