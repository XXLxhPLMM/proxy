/**
 * @fileoverview `useMouse` 一族：把中心源的鼠标数据接进组件（ink 7 没有内置 `useMouse`，本 hook 是本包的）
 * @module ink-ui/hooks/mouse/use-mouse
 * @description
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useInput } from "ink";
import type { MouseEvent } from "./protocol.js";
import type { MouseListener } from "./source.js";
import { getMouseSnapshot, pushMouseSequence, subscribeMouse } from "./source.js";

export function useMouseInput(): void {
  // `useInput` 自带 raw mode（没有它就没有输入）
  useInput((input) => {
    pushMouseSequence(input);
  });
}

/**
 * 订阅鼠标事件：`move` / `drag` 按 33ms 合并，`down` / `up` / `wheel` 一条不丢。
 *
 * ```tsx
 * useMouse((event) => {
 *   if (event.type === "wheel") return scroll(event.direction);
 *   if (event.type === "down" && event.button === "left") return select(event.x, event.y);
 * });
 * ```
 */
export function useMouse(handler: MouseListener): void {
  useEffect(() => subscribeMouse(handler), [handler]);
}

/**
 * 读鼠标采样：`selector` 从「最新一次事件」里挑出要的值，挑出来的值没变就不重渲染。
 *
 * ```tsx
 * const column = useMouseState((event) => event?.x ?? 0); // 只有列变了才重渲染
 * ```
 *
 * 采样只留最新一条事件，所以中间值会丢：连续的 `drag` 已被合并，`down` + `up` 并进同一次渲染时也
 * 只看得到后一个。
 */
export function useMouseState<T>(
  selector: (event: MouseEvent | null) => T,
): T {
  /**
   * 选择器的结果按**快照 + 选择器**缓存：`useSyncExternalStore` 要求「快照没变就返回同一个值」
   * （否则它判定你在无限更新），而同一次提交里它会问好几遍。快照本身引用稳定（没新事件就是同一个
   * 对象），选择器也要进键——不然换了个选择器还会拿到上一个选择器的结果。
   */
  const cache = useRef<{
    event: MouseEvent | null;
    selector: (event: MouseEvent | null) => T;
    value: T;
  } | null>(null);

  return useSyncExternalStore(subscribeMouse, () => {
    const event = getMouseSnapshot();
    if (cache.current?.event === event && cache.current.selector === selector) {
      return cache.current.value;
    }
    const value = selector(event);
    cache.current = { event, selector, value };
    return value;
  });
}
