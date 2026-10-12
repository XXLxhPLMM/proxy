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
 * 两者返回同一个形状（`PacedFn`）：直接当函数调，另带两个方法
 * - `flush()`：立刻把挂起的那次执行掉（卸载前补发、离散事件插入前的顺序保证）；
 * - `cancel()`：丢掉挂起的那次并撤销未到点的执行（此后永不执行它）。
 *
 * ⚠️ **`flush()` 不是 `cancel()` 的反面**：`cancel` 之后挂起的那次永远不发生，`flush` 是「现在就做」。
 * ⚠️ **执行可能同步发生**：窗口外的那次会在你调用它的**同一刻**就回调 `fn`，不要假定回调总在之后
 * 的某个 tick（这也是 `flush()` 在离散事件前必须显式调用的原因）。
 * ⚠️ **`waitMs <= 0`**：节流退化成「每次立即执行」；防抖按标准语义排一个 0ms 定时器（下一次 tick
 * 执行，不是同步执行）。
 *
 * 零 IO、零 React、零依赖（定时器就是全局 `setTimeout`，测试用 fake timers）：规约见
 * `@/ink-ui/utils/index.js`。
 */

/** 定时器句柄（只在本模块内部用） */
type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * 节流 / 防抖之后的函数：签名与被包的函数一致，另带两个控制方法。
 *
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
 * 节流：`waitMs` 内最多执行一次，且停手时必执行最后一次（leading + trailing）。
 *
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
 * 防抖：静默满 `waitMs` 才执行最后一次（trailing）。
 *
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
