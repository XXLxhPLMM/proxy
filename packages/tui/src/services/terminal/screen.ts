/**
 * @fileoverview 收尾的**唯一结构**：`ScreenRestore` 的类型与把若干个收尾合成一个（零 Ink、零 `process.*`）。⚠️ **本模块一个字的控制序列都不发**：全屏接管归 `render(…, { alternateScreen: true })`、光标显隐（`?25`）与备用屏幕归 Ink —— ⚠️ **`?1049` 归 Ink，本模块一条都不许碰**（备用屏幕栈少一层/多一层都零报错），而**鼠标上报的唯一 owner 是 `./mouse.js` 的 `start()` / `stop()`**（两侧各自带幂等守卫）；每一族为什么这么分、错了是什么症状，逐条见 `AGENTS.md`「每一族控制序列都只有一个 owner」。
 */

/** 收尾函数：重复调用必须无副作用（形状同 `process.once` 的监听器） */
export type ScreenRestore = () => void;

/**
 * 把若干个收尾合成**一个**（结果仍幂等）。⚠️ 前一个抛了**不许**跳过后面的，而**第一个异常在全部跑完之后才重抛**
 * —— 中途就抛等于把「剩下那几件还没收」变成一个没人看的错误；为什么是这两条，见 `AGENTS.md`。 */
export function chainRestores(...restores: readonly ScreenRestore[]): ScreenRestore {
  let done = false;
  return (): void => {
    if (done) return;
    done = true;
    let firstFailure: unknown;
    let failed = false;
    for (const restore of restores) {
      try {
        restore();
      } catch (failure: unknown) {
        if (!failed) {
          failed = true;
          firstFailure = failure;
        }
      }
    }
    if (failed) throw firstFailure;
  };
}