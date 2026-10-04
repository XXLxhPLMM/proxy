/**
 * @fileoverview 全屏接管与退出的**对称性**（零 Ink、零 `process.*`）；⚠️ **`?1049` 归 Ink，本模块一条都不许碰**：备用屏幕由 `render(…, { alternateScreen: true })` 负责，在这里再写一遍会让终端的备用屏幕栈错位（此后每一次 alt screen 程序都会少一层），而它**零报错**、只会让人以为终端坏了。故 `ENTER_SEQUENCE` / `EXIT_SEQUENCE` 里没有它、源码里也不许有它 —— `tests/screen/screen.test.ts` 把它钉成一条会红的断言。
 */

import { MOUSE_REPORTING_OFF, MOUSE_REPORTING_ON, type TerminalOut } from "./mouse.js";

/** 收尾函数：重复调用必须无副作用（形状同 `process.once` 的监听器） */
export type ScreenRestore = () => void;

/** 隐藏光标（`?25` 的 reset 侧） */
export const CURSOR_HIDE = "\u001B[?25l";

/** 显示光标（`?25` 的 set 侧） */
export const CURSOR_SHOW = "\u001B[?25h";

/** 进入全屏时写的序列（⚠️ **不含** `?1049`，归 Ink；顺序是「先藏光标、再开鼠标」） */
export const ENTER_SEQUENCE: readonly string[] = Object.freeze([
  CURSOR_HIDE,
  ...MOUSE_REPORTING_ON,
]);

// ⚠️ **对称性**：`EXIT_SEQUENCE` 是 `ENTER_SEQUENCE` 的**逐条取反** —— 漏关鼠标上报的话操作者的终端**一直
// 吞掉选中与粘贴**且看不出来。⚠️ **收尾必须能重复调用**（两条到达路径而它们经常都会跑，故 `chainRestores`
// 让 `finally` 里只有**一个**调用点）。⚠️ 光标显隐是**幂等的 set**（不是 toggle），与 Ink 的重复**不冲突**。
export const EXIT_SEQUENCE: readonly string[] = Object.freeze([
  ...MOUSE_REPORTING_OFF,
  CURSOR_SHOW,
]);

/**
 * 进入全屏接管（写 {@link ENTER_SEQUENCE}），返回一个**幂等**的收尾函数
 * @description 备用屏幕**不在**这里：调用方紧接着用 `render(…, { alternateScreen: true })` 让 Ink 发
 * `?1049h`。收尾要覆盖两条路径，所以调用方必须把它挂到 `try/finally` 或 `process.once("exit")` 上。
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
 * 把若干个收尾合成**一个**（结果仍幂等），让 `finally` 里只有一个调用点；⚠️ 前一个收尾抛了**不许**跳过后面的
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