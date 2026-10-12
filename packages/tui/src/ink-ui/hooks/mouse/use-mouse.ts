/**
 * @fileoverview `useMouse` 一族：把中心源的鼠标数据接进组件（ink 7 没有内置 `useMouse`，本 hook 是本包的）
 * @module ink-ui/hooks/mouse/use-mouse
 * @description
 * 解析、合并、开 / 关跟踪都在同目录 `source.ts`（全进程一份；`startMouse` / `stopMouse` 由组合根
 * `starter/plugins/ui.tsx` 在应用启动 / 退出时调）。本文件只剩三件事：
 *
 * | 出口 | 干什么 | 用在哪 |
 * |---|---|---|
 * | `useMouseInput()` | 把 ink 的输入喂给中心源 | **应用根挂一次**（`app.tsx`），别处不许调 |
 * | `useMouse(handler)` | 订阅事件：`down` / `up` / `wheel` 一条不丢、且序对 | 按下 / 松开 / 拖动这类交互 |
 * | `useMouseState(selector)` | 读采样：只关心「现在是什么」 | 悬停高亮、坐标读数 |
 *
 * ⚠️ **上报会同时漏进本组件之外的每个 `useInput` 处理器**（ink 把每个输入广播给所有订阅者，
 * 它自己不识别鼠标、也没有拦截点），别的按键处理器会收到形如 `[<0;12;34M` 的 `input`。**判键前
 * 先滤掉这类噪声**：用 barrel 转出的 `isMouseSequence(input)`。
 *
 * ⚠️ **档次与开关是应用级的，视图不参与**：跟踪在应用启动时就开了（见 `source.ts` 的 ⚠️），所以
 * 这里**没有** per-call 的开关 —— 视图既关不掉（关掉别人也收不到），也不该关。要「这段时间别派发
 * 给我」，在自己的处理器里判条件即可：重订阅不影响任何窗口（见下一条）。
 *
 * ⚠️ **回调换了就换订阅，不把回调存下来**：退订与再订阅在同一个同步 flush 里跑完，外部事件插不
 * 进去，所以重订阅不会丢事件；而节流窗口住在中心源里，也不受重订阅影响 —— 因此这里既不需要
 * `useRef` 也不需要 `useEffectEvent`，活过 render 的东西只有中心源那一个。
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useInput } from "ink";
import type { MouseEvent } from "./protocol.js";
import type { MouseListener } from "./source.js";
import { getMouseSnapshot, pushMouseSequence, subscribeMouse } from "./source.js";

/**
 * 中心源的接线：**应用里只许调一次**（`app.tsx`）。
 *
 * 多调一次就会把同一条上报喂两遍（中心源不认订阅者是谁）。它不碰跟踪开关 —— 开不开在
 * `startMouse` 那边，这里只负责把输入递下去。
 */
export function useMouseInput(): void {
  // `useInput` 自带 raw mode（没有它就没有输入），ink 会把每条输入广播给每个订阅者
  useInput((input) => {
    pushMouseSequence(input);
  });
}

/**
 * 订阅鼠标事件：`down` / `up` / `wheel` 每条都到，`move` / `drag` 按 33ms 合并。
 *
 * ```tsx
 * useMouse((event) => {
 *   if (event.type === "wheel") return scroll(event.direction);
 *   if (event.type === "down" && event.button === "left") return select(event.x, event.y);
 * });
 * ```
 *
 * 关心每一次按下 / 松开用这个；只读「当前值」用 `useMouseState`。
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
 * ⚠️ **采样会丢中间值**（见 `source.ts` 的 ⚠️）：判断「拖拽的起止」必须用 `useMouse`。
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
