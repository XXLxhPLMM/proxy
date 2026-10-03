/**
 * @fileoverview 全屏接管与退出的**对称性**：进入/退出的成对序列 + 幂等收尾（零 Ink、零 `process.*`）
 * @module terminal/screen
 * @description
 * 本模块只负责 **Ink 不管的那一半**全屏接管，两件事：光标显隐、鼠标上报。
 *
 * ⚠️ **`?1049` 归 Ink，本模块一条都不许碰**：备用屏幕由 `render(…, { alternateScreen: true })` 负责（Ink
 * 自己发 `\u001B[?1049h` 与 `\u001B[?1049l`）。在这里再写一遍会让终端的备用屏幕栈错位 —— 进入两次、离开一次，
 * 退出后回到的是一个**已经不在的屏幕**，且此后每一次 alt screen 程序都会少一层。这个错误不会有任何一行报错，
 * 只会让人以为终端坏了。故 `ENTER_SEQUENCE` / `EXIT_SEQUENCE` 里没有它，源码里也不许有它
 * （`tests/screen.test.ts` 把它钉成一条会红的断言，而不只是注释里的一句叮嘱）。
 *
 * ⚠️ **对称性：本模块发的每一条都要有配对的撤销** —— {@link EXIT_SEQUENCE} 是 {@link ENTER_SEQUENCE} 的**逐条
 * 取反**。漏一条的代价分两种：漏关鼠标上报 → 操作者的终端**一直吞掉选中与粘贴**且看不出来；漏显光标 → 退出后
 * 留一个看不见的光标。两种都不会报错，只能靠这条不变式挡住。⚠️ **收尾必须能重复调用**（{@link ScreenRestore}
 * 幂等），因为收尾有**两条**到达路径（`try/finally` 与 `process.once("exit")` 兜底）而它们经常都会跑；组合根
 * 用 {@link chainRestores} 把它与别的收尾串成一个，于是 `finally` 里只有**一个**调用点。
 *
 * @module
 */

import { MOUSE_REPORTING_OFF, MOUSE_REPORTING_ON, type TerminalOut } from "./mouse.js";

/**
 * 收尾函数：重复调用必须无副作用（见文件头）
 * @description 形状与 `process.once` 的监听器、`addEventListener` 的 remove 一样：**调一次做掉，调两次什么
 * 都不发生**。这是退出路径上唯一能同时接住「抛异常」与「Ctrl+C」两件事的形状。
 */
export type ScreenRestore = () => void;

/** 隐藏光标（`?25` 的 reset 侧） */
export const CURSOR_HIDE = "\u001B[?25l";

/** 显示光标（`?25` 的 set 侧） */
export const CURSOR_SHOW = "\u001B[?25h";

/**
 * 进入全屏时写的序列（⚠️ **不含** `?1049`，归 Ink）
 * @description 顺序是「先藏光标、再开鼠标」—— 开鼠标必须早于第一帧被点，而**备用屏幕由 Ink 在 `render()`
 * 里切**，本模块跑在它之前，所以它已经开好了。
 */
export const ENTER_SEQUENCE: readonly string[] = Object.freeze([
  CURSOR_HIDE,
  ...MOUSE_REPORTING_ON,
]);

/**
 * 退出全屏时写的序列（⚠️ **不含** `?1049`，归 Ink）
 * @description {@link ENTER_SEQUENCE} 的**逐条取反**：先关鼠标上报，再把光标还回去。⚠️ 与 Ink 退出时补的那一
 * 次「显示光标」重复**不冲突**：光标显隐是**幂等的 set**（不是 toggle），本模块写它是为了「本模块藏起来的光标
 * 一定由本模块放出来」这条对称性不依赖 Ink 是否走到它的收尾。
 */
export const EXIT_SEQUENCE: readonly string[] = Object.freeze([
  ...MOUSE_REPORTING_OFF,
  CURSOR_SHOW,
]);

/**
 * 进入全屏接管（写 {@link ENTER_SEQUENCE}），返回一个**幂等**的收尾函数
 * @description 备用屏幕**不在**这里：调用方紧接着用 `render(…, { alternateScreen: true })` 让 Ink 发
 * `?1049h`。收尾要覆盖两条路径，所以调用方必须把它挂到 `try/finally` 或 `process.once("exit")` 上。
 *
 * @param out 终端输出（组合根采集宿主来源后传进来；本模块**不**自己摸 `process.stdout`）
 */
export function enterFullScreen(out: TerminalOut): ScreenRestore {
  out.write(ENTER_SEQUENCE.join(""));
  let restored = false;
  return (): void => {
    if (restored) return;
    // ⚠️ 守卫**先**置位再写：收尾期间没有第二次机会，写失败时重试也写不进去
    restored = true;
    out.write(EXIT_SEQUENCE.join(""));
  };
}

/**
 * 把若干个收尾合成**一个**（结果仍幂等），让 `finally` 里只有一个调用点
 * @description ⚠️ 前一个收尾抛了**不许**跳过后面的：每一条序列都有它自己的代价（关不掉鼠标上报的那条最贵），
 * 「一失败就都不做」等于把一条已知代价换成另一条已知代价。故先把全部跑完，再把第一个异常抛出去。
 */
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