/**
 * @fileoverview 流量配额账本的**落盘驱动**：全切片唯一的定时器站点
 * @module core/traffic/flush-loop
 * @description
 * 账本（`./ledger.ts`）本身**一个定时器都没有**——它只暴露「排空队列」的 Promise。什么时候
 * 排空是**驱动**的事，而驱动只做一件事：按 `quotaFlushInterval` 周期性地把排空动作推一下。
 * 这条职责单独成文件只有一个原因：**让「全切片零定时器」这件事可以被一条源码级断言证明**
 * （`tests/unit/traffic-ledger.test.ts`：账本两个文件 `ledger.ts`/`memory.ts` 零定时器，
 * `flush-loop.ts` 恰好一处 `setTimeout`、零 `setInterval`/`setImmediate`/`nextTick`/
 * `queueMicrotask`）。定时器散落在账本 IO 里时那条断言就写不出来了。
 *
 * ## 为什么是「自重排的 `setTimeout` 链」而不是 `setInterval`
 *
 * - **间隔是 runtime 相位**（`QUOTA_FLUSH_INTERVAL` 经 accessor 现读，**热改即生效**）。
 *   `setInterval` 的周期在创建时就定死了，要支持热改就只能「跑到一半发现间隔变了 → 摘掉重建」，
 *   那比每轮重排一次更绕。自重排链每轮读一次现值，**热改在下一轮自然生效**，无额外状态。
 * - **`unref()`**：定时器**不得**把进程钉住。CLI 的存活靠监听套接字、库调用方可能压根不跑
 *   代理（只 `createProxyRuntime` 不 `start`）；一个没 `unref` 的后台定时器会让
 *   `node dist/app.js` 在 Ctrl+C 之后多挂 5 秒，也让单测的进程句柄计数变脏。
 *
 * ## 两条 flush 触发时机
 *
 * ① **本文件的周期定时器**（`quotaFlushInterval`，runtime 相位）。
 * ② **优雅停机**：`runtime.stop()` 摘掉本定时器后 `await ledger.close()`，后者做**最后一次**
 * 排空。`ProxyServer.stop()` 在与 `logger.flush()` **同一个位置**也调一次
 * `ledger.close()`（幂等），让「先落配额账本、再落日志」的次序在 CLI 面上是显式的。
 *
 * **停机必须落盘的原因**：账本里排队的 delta 是「已计入内存判定、但还没进磁盘」的字节。
 * 不落就等于把最近一个间隔的用量白送给用户 —— 反复「用一点、Ctrl+C」就能把配额窗口内的
 * 额度一次次刷新。所以停机路径是**正确性要求**，不是「顺手做的整洁工作」。
 *
 * ## 停机与定时器的竞态
 *
 * `stop()` 先 `clearTimeout` 再让账本排空：单线程里 `stop()` 与某一次 tick 之间的顺序只有
 * 两种可能——tick 先跑完（那次排空完成后 `stop` 再排空一次，此时队列已空，是幂等的空转）
 * 或 `stop` 先跑（定时器已被摘，之后不会再有 tick）。两种都收敛，**不存在「停机后又被
 * 写了一轮」**。账本侧的排空本身经一条 Promise 链串行化（`ledger.ts:flush`），所以即便
 * 上面两种顺序交错，也没有两次写同时发生。
 */

/** 一个可摘的自重排定时器。 */
export interface FlushLoopHandle {
  /** 摘掉定时器（幂等）。**不**等待在途回调——调用方随后自己排空队列。 */
  stop(): void;
}

/**
 * 起一条自重排的落盘定时器
 * @param run - 每轮要做的事（账本的 `flush()`；它**永不 reject**，故可放心不 await）
 * @param intervalMs - 本轮到下一轮的间隔 ms，**每次现读**（runtime 相位，热改即生效）
 * @returns 句柄（`stop()` 幂等）
 * @description
 * **间隔下限夹到 1ms**：`QUOTA_FLUSH_INTERVAL` 有 `int: { min: 1 }` 的校验，但库路径的
 * `ConfigStore` 零校验（见 `window.ts:clampShiftHours` 的同一段论证），所以 0/负数/NaN
 * 在这里会变成 `setTimeout(fn, 0)` 的忙循环 —— 那是一个纯 CPU 挂死。夹到 1 是与
 * `windowKey` 同一手法的「在自己这一层守住定义域」。
 */
export function startFlushLoop(run: () => void, intervalMs: () => number): FlushLoopHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const arm = (): void => {
    if (stopped) {
      return;
    }
    const raw = intervalMs();
    const delay = Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 1;
    timer = setTimeout(() => {
      // 先重排再执行：run() 是同步入队（内部 `void` 掉了真实 IO），所以这里不会因为
      // 一轮耗时而把后续 tick 挤掉。顺序反过来的话一个慢轮次会累积漂移。
      arm();
      run();
    }, delay);
    // 不许把进程钉住（见文件头）
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
