/**
 * @fileoverview UI 插件（Ink 渲染层）：把 `src/ink-ui/app.tsx` 的根组件挂进终端
 * @module starter/plugins/ui
 * @description
 * 把应用根组件 `App` 经 ink 渲染到终端，使用备用屏幕缓冲（alternateScreen）做全屏接管：
 * App 退出时原终端内容自动恢复，同 htop/vim 行为。
 * 整个进程的生命周期由 Ink 接管：App 中的空 `useInput` 拉起 stdin 的 raw mode（拉住事件循环），
 * Ink 在 raw mode 下拦截 Ctrl+C，内部 signal-exit 又同时监听 SIGINT / SIGTERM，退出时统一
 * 走本插件的清理回调：释放 Cordis 资源（`disposeStarter`）→ `process.exit(0)`。
 * 渲染模式：增量渲染（incrementalRendering）+ 备用缓冲（alternateScreen）。
 *
 * 鼠标是**应用级**设备，所以它的开关也在这里：渲染之后 `startMouse`、清理时 `stopMouse`（谁在开、
 * 什么时候关、控制码怎么写见 `hooks/mouse/` 的 `source.ts`）。视图只管订阅事件 / 读采样。
 */

import { render } from "ink";
import { App } from "@/ink-ui/app.js";
import { useStore } from "@/ink-ui/store/index.js";
import { startMouse, stopMouse } from "@/ink-ui/hooks/mouse/index.js";
import type { Context } from "cordis";
import { disposeStarter } from "@/starter/index.js";

/** 写控制码的通道：直写 stdout，**不走 ink 的 `write`**（那会 clear + 重绘整屏，退出时还可能已卸载） */
function writeStdout(data: string): void {
  process.stdout.write(data);
}

/** UI 插件：加载（渲染）即注册，卸载时反渲染 */
export function uiPlugin(ctx: Context): void {
  let _disposed = false;
  ctx.effect(() => {
    useStore.getState().setCtx(ctx);
    render(<App />, {
      incrementalRendering: true,
      alternateScreen: true,
    });

    // 与 ink 同源的两个前提（ink 读的就是它们，见 `ink.js` 的 isScreenReaderEnabled / interactive）：
    // 非 TTY 写出去的控制码没人解析；读屏模式下 ink 连界面都不画，更不该动终端模式。
    const trackable =
      Boolean(process.stdout.isTTY) && process.env.INK_SCREEN_READER !== "true";
    if (trackable) {
      // 档次是应用级的：`motion`（1003 悬停也报）开着，分隔条的悬停变亮吃它。1003 报得最勤，但中心源
      // 已按 ≈一帧合并（`source.ts` 的 COALESCE_MS），消费方也只在布尔值翻转时才重渲染。
      startMouse(writeStdout, { drag: true, motion: true });
    }

    return () => {
      if (_disposed) return;
      _disposed = true;
      stopMouse();
      disposeStarter(ctx);
    };
  });
}
