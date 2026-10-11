/**
 * @fileoverview `useMouse`：捕获终端鼠标事件（ink 7 没有内置 `useMouse`，本 hook 是本包的）
 * @module ink-ui/hooks/mouse/use-mouse
 * @description
 * 两件事：`useInput` 里把鼠标上报解成结构化事件回调出去；挂载时向 stdout 写控制码开
 * 终端鼠标跟踪，卸载时写回关闭。协议解码（`protocol.ts`）与开关码（`tracking.ts`）是同目录
 * 的两个纯模块，这里只管「谁在用」：React 生命周期 + 多使用者共用的引用计数。
 *
 * ⚠️ **鼠标上报会同时漏进本组件之外的每个 `useInput` 处理器**：ink 把每个输入事件广播给
 * 所有 `useInput` 订阅者（同一个 emitter），它自己不识别鼠标、没有拦截点；而根组件的
 * `useInput` 晚于子组件的 effect 注册（React 先跑子 effect），所以父层也拦不住兄弟组件。
 * 表现是别的按键处理器会收到形如 `[<0;12;34M` 的 `input`。**判键前先滤掉这类噪声**：判据是
 * 同目录 `parseMouseSequence(input) !== null`——⚠️ 它没从本目录的 barrel 转出（barrel 只出
 * `useMouse`），要用的按键处理器自己从 `@/ink-ui/hooks/mouse/protocol.js` 引。
 *
 * ⚠️ **跟踪开关是全进程引用计数，不按组件走**：多个视图各自 `useMouse` 时，任一视图卸载
 * 都不会关掉别人还在用的跟踪；只有最后一个使用者卸载才整体关闭，且中途只升不降
 * （先关掉的视图若要过 1003，剩余视图也一并留着）。代价是「先挂的视图要拖拽、后挂的不要」
 * 这种组合下多开着 1003。
 *
 * ⚠️ **非 TTY / 读屏模式下不开跟踪**：stdout 不是 TTY（管道、CI）或 ink 判定读屏在跑时，
 * 写出去的开关码没人解析，事件也永远不会来，只在输出流里多一串控制字符。
 */

import { useEffect } from "react";
import { useInput, useIsScreenReaderEnabled, useStdout } from "ink";
import type { MouseEvent } from "./protocol.js";
import type { MouseTracking } from "./tracking.js";
import { parseMouseSequence } from "./protocol.js";
import { disableMouseTracking, enableMouseTracking, mergeTracking } from "./tracking.js";

export interface UseMouseOptions {
  /** 是否捕获：关掉时既不派发事件也不碰终端开关码（默认 `true`） */
  isActive?: boolean;
  /** 拖拽：按键按住时的移动（模式 1002，默认 `true`） */
  drag?: boolean;
  /** 空按移动：悬停也派发 `move`（模式 1003，默认 `true`）⚠️ 高频重绘，视图里慎开 */
  motion?: boolean;
}

/** 当前有多少个 `useMouse` 在场；归零才关跟踪 */
let consumers = 0;

/** 已经开着的档次（只升不降，见文件头） */
let enabled: MouseTracking = { drag: false, motion: false };

/**
 * 占一个使用者名额并确保跟踪开着，返回释放函数。
 *
 * @param write ink 的输出通道（写出去不会打乱它自己那一帧）
 * @param tracking 本次使用要的档次
 */
function acquire(write: (data: string) => void, tracking: MouseTracking): () => void {
  consumers += 1;
  const wanted = mergeTracking(enabled, tracking);
  if (wanted.drag !== enabled.drag || wanted.motion !== enabled.motion) {
    write(enableMouseTracking(wanted));
    enabled = wanted;
  }
  let released = false;
  return () => {
    // 幂等：React 严格模式与 StrictMode 的双挂载都会调两次释放
    if (released) return;
    released = true;
    consumers -= 1;
    if (consumers > 0) return;
    write(disableMouseTracking());
    enabled = { drag: false, motion: false };
  };
}

/**
 * 捕获终端鼠标事件：按下 / 释放 / 拖拽 / 空按移动 / 滚轮（含 Shift / Alt / Ctrl 与 1 基坐标）。
 *
 * ```tsx
 * useMouse((event) => {
 *   if (event.type === "wheel") return scroll(event.direction);
 *   if (event.type === "down" && event.button === "left") return select(event.x, event.y);
 * });
 * ```
 *
 * 跟踪由本进程共享：每个用鼠标的组件各调一次即可，不必指定谁来开谁来关。
 */
export function useMouse(
  handler: (event: MouseEvent) => void,
  options: UseMouseOptions = {},
): void {
  const { isActive = true, drag = true, motion = true } = options;
  const { write, stdout } = useStdout();
  const screenReader = useIsScreenReaderEnabled();
  const supported = Boolean(stdout.isTTY) && !screenReader;

  useEffect(() => {
    if (!isActive || !supported) return;
    return acquire(write, { drag, motion });
  }, [isActive, supported, drag, motion, write]);

  // `useInput` 自带 raw mode：没有它就没有输入，鼠标上报也到不了
  useInput(
    (input) => {
      const event = parseMouseSequence(input);
      if (event) handler(event);
    },
    { isActive: isActive && supported },
  );
}