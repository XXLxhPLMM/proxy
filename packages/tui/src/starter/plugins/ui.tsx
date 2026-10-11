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
 */

import { render } from "ink";
import { App } from "@/ink-ui/app.js";
import { useStore } from "@/ink-ui/store/index.js";
import type { Context } from "cordis";
import { disposeStarter } from "@/starter/index.js";

/** UI 插件：加载（渲染）即注册，卸载时反渲染 */
export function uiPlugin(ctx: Context): void {
  let _disposed = false;
  ctx.effect(() => {
    useStore.getState().setCtx(ctx);
    render(<App />, {
      incrementalRendering: true,
      alternateScreen: true,
    });
    return () => {
      if (_disposed) return;
      _disposed = true;
      disposeStarter(ctx);
    };
  });
}
