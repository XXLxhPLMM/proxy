/**
 * @fileoverview 标准节流 / 防抖：把一个函数改造成「按节奏调用」的新函数
 * @module ink-ui/utils/flow-control
 * @description
 * ```ts
 * const onResize = throttle(handleResize, 100); // 100ms 内最多执行一次
 * const onType = debounce(search, 300); // 停手 300ms 才查一次
 * onResize(); onType(); // 当普通函数调
 * ```
 *
 * - `throttle(fn, waitMs)`：**leading + trailing**。窗口外立即执行；窗口内覆盖式合并成最后一次，
 *   窗口到点补执行一次。连续拖动表现为「定期放行 + 停手必到最后一帧」。
 * - `debounce(fn, waitMs)`：**trailing**。连续调用期间一次都不执行，静默满一窗才执行最后一次。
 *
 * 选哪个：要过程中的中间态用节流（拖动跟随、悬停高亮），要停稳后只做一次用防抖（输入框查库、
 * 自动保存）。差别只在基准——节流以**上次执行**为准，防抖以**上次收到**为准。
 *
 * 两者返回同一个形状（`PacedFn`）：直接当函数调，另带 `flush()`（挂起的那次立刻执行：卸载前补发、
 * 离散事件插入前保证顺序）与 `cancel()`（丢弃挂起的那次，此后不再执行）。
 *
 * 时序：窗口外的那次在**调用它的同一刻**就回调 `fn`（同步发生），窗口内的那次才落在定时器上。
 *
 * 零 IO、零 React、零依赖（定时器就是全局 `setTimeout`，测试用 fake timers）：规约见
 * `@/ink-ui/utils/index.js`。
 */

/** 定时器句柄 */
type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * @typeParam A 被包函数的参数表
 */
export interface PacedFn<A extends unknown[]> {
  (...args: A): void;
  /** 立刻执行挂起的那次调用；没有挂起则什么都不做 */
  flush(): void;
  /** 丢弃挂起的那次调用并撤销未到点的定时器 */
  cancel(): void;
}

/**
 * @param fn 被包的函数
 * @param waitMs 最小执行间隔（毫秒）；`<= 0` = 每次立即执行
 */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): PacedFn<A> {
  /** 上次执行的时刻；`-Infinity` ⇒ 第一次立即执行 */
  let lastCallAt = Number.NEGATIVE_INFINITY;
  /** 窗口内被覆盖式合并的那次调用（只留最新） */
  let pending: A | null = null;
  let timer: TimerHandle | null = null;

  const stopTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const call = (args: A) => {
    lastCallAt = Date.now();
    fn(...args);
  };

  const flush = () => {
    stopTimer();
    if (pending === null) return;
    const held = pending;
    pending = null;
    call(held);
  };

  const cancel = () => {
    stopTimer();
    pending = null;
  };

  return Object.assign(
    (...args: A) => {
      const now = Date.now();
      if (now - lastCallAt >= waitMs) {
        stopTimer(); // 挂起的那次已被更新的调用取代
        pending = null;
        call(args);
        return;
      }
      pending = args;
      if (timer !== null) return; // 已有定时器：不重排、不重置窗口（一重置就退化成防抖）
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, waitMs - (now - lastCallAt));
    },
    { flush, cancel },
  );
}

/**
 * @param fn 被包的函数
 * @param waitMs 静默时长（毫秒）；`<= 0` = 下一次 tick 执行
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): PacedFn<A> {
  /** 静默窗口内被覆盖式合并的那次调用（只留最新） */
  let pending: A | null = null;
  let timer: TimerHandle | null = null;

  const stopTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const flush = () => {
    stopTimer();
    if (pending === null) return;
    const held = pending;
    pending = null;
    fn(...held);
  };

  const cancel = () => {
    stopTimer();
    pending = null;
  };

  return Object.assign(
    (...args: A) => {
      stopTimer(); // 每次调用都是整窗：旧定时器作废、重排
      pending = args;
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, waitMs);
    },
    { flush, cancel },
  );
}
