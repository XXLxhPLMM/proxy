/**
 * @fileoverview 用量数据源的**周期驱动**：本目录唯一的定时器站点
 * @module datasource/quota/flush-loop
 * @description
 * 数据源（`./sqlite-source.ts` / `./jsonl-source.ts`）本身**一个定时器都没有**——它们只暴露
 * 「跑一轮」的 Promise。什么时候跑是**驱动**的事，而驱动只做一件事：按周期把「跑一轮」推一下。
 * 这条职责单独成文件只有一个原因：**让「本目录零定时器」这件事可以被一条源码级断言证明**
 * （`tests/unit/usage-source.test.ts`：数据源两个文件零定时器，`flush-loop.ts` 恰好一处
 * `setTimeout`、零 `setInterval`/`setImmediate`/`nextTick`/`queueMicrotask`）。定时器散落在
 * 数据源 IO 里时那条断言就写不出来了。
 *
 * **一轮 = 落盘 + 回读**：驱动不区分这两件事，因为它们共用同一条串行 Promise 链，而**顺序是
 * 语义的一部分**（先落盘、后回读 ⇒ 同一轮里读出的一定是「已经含本进程这批字节」的那一份，
 * 于是 `mirrorLagBoundMs` 那个 `2P` 上界成立）。驱动侧只知道「周期到了」，具体顺序由数据源
 * 自己的那一轮实现承担。
 *
 * **自重排的 `setTimeout` 链而不是 `setInterval`**：周期是 runtime 相位（`quotaFlushInterval`
 * 经 accessor 现读，**热改即生效**），而 `setInterval` 的周期在创建时就定死，要热改只能「跑到
 * 一半发现周期变了 → 摘掉重建」，那比每轮重排一次更绕。**`unref()`**：定时器**不得**把进程
 * 钉住——CLI 的存活靠监听套接字、库调用方可能压根不跑代理（只 `createProxyRuntime` 不
 * `start`）；一个没 `unref` 的后台定时器会让 `node dist/app.js` 在 Ctrl+C 之后多挂 5 秒，
 * 也让单测的进程句柄计数变脏。
 *
 * **停机必须落盘是正确性要求**，不是「顺手做的整洁工作」：数据源里排队的 delta 是「已计入镜像
 * 判定、但还没进存储」的字节，不落就等于把最近一个周期的用量白送给用户——反复「用一点、
 * Ctrl+C」就能把配额窗口内的额度一次次刷新。`close()` 摘掉本定时器后跑最后一轮。
 *
 * **停机与定时器的竞态**：`stop()` 先 `clearTimeout` 再让数据源跑最后一轮；单线程里只有两种
 * 顺序——tick 先跑完（那一轮完成后 `close` 再跑一次，此时队列已空，是幂等的空转）或 `stop`
 * 先跑（定时器已被摘，之后不会再有 tick）。两种都收敛，**不存在「停机后又被写了一轮」**。
 * 数据源侧的排空本身经一条 Promise 链串行化，所以即便上面两种顺序交错，也没有两次写同时发生。
 */

/** 一个可摘的自重排定时器。 */
export interface FlushLoopHandle {
  /** 摘掉定时器（幂等）。**不**等待在途回调——调用方随后自己跑最后一轮。 */
  stop(): void;
}

/**
 * 把周期夹到 `[1, +∞)` 的整毫秒
 * @description
 * **夹取而不是照用**：`quotaFlushInterval` 有 `int: { min: 1 }` 的校验，但库路径的
 * `ConfigStore` 零校验（`@/datasource/quota-window.ts:clampShiftHours` 的同一段论证：库调用方
 * 可以绕过 `loadConfig` 直接灌 `ConfigStore`），所以 0/负数/NaN 在这里会变成
 * `setTimeout(fn, 0)` 的忙循环 —— 那是一个纯 CPU 挂死。夹到 1 是与 `windowKey` 同一手法的
 * 「在自己这一层守住定义域」。
 *
 * **刻意导出**：误差上界（`./mirror.ts:mirrorLagBoundMs`）必须用**同一个**夹取，否则「上界
 * 报 1ms、实际每 0ms 跑一轮」这类偏差会让那个数失去意义——而一个不真的界住任何东西的
 * 上界比没有上界更坏（它会让人以为多进程偏差已经被管住了）。
 * @param raw - 配置里读到的原始值（可能非有限、可能 < 1）
 */
export function clampFlushIntervalMs(raw: number): number {
  return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 1;
}

/**
 * 起一条自重排的周期定时器
 * @param run - 每轮要做的事（数据源的那一轮；它**永不 reject**，故可放心不 await）
 * @param intervalMs - 本轮到下一轮的间隔 ms，**每次现读**（runtime 相位，热改即生效）
 * @returns 句柄（`stop()` 幂等）
 */
export function startFlushLoop(run: () => void, intervalMs: () => number): FlushLoopHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const arm = (): void => {
    if (stopped) {
      return;
    }
    timer = setTimeout(
      () => {
        // 先重排再执行：run() 是同步入队（内部 `void` 掉了真实 IO），所以这里不会因为
        // 一轮耗时而把后续 tick 挤掉。顺序反过来的话一个慢轮次会累积漂移。
        arm();
        run();
      },
      clampFlushIntervalMs(intervalMs()),
    );
    timer.unref();
  };

  arm();

  return {
    stop: (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
