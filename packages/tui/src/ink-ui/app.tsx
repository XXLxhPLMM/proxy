/**
 * @fileoverview TUI 应用根组件（Ink）
 * @description
 * 整个终端应用的渲染树根。子树组织在 `src/ink-ui/`：
 *   store/     状态（zustand）与宿主上下文封装
 *   theme/     样式基座
 *   components/ 原子构件（与 `ink` / `@inkjs/ui` 协作）
 *   layout/     页面框架
 *   views/      视图（按路由 / 状态切换）
 *
 * 退出边界（退出码 / 信号策略）：由 Ink 接管——`useInput` 把 stdin 拉入 raw
 * mode，Ink 在 raw mode 下拦截 Ctrl+C；Ink 内部的 signal-exit 监听 SIGINT/SIGTERM，
 * 退出时调用 `unmount()`，本组件的清理回调负责释放 Cordis 资源并 `process.exit(0)`。
 * 重构空白期：布局与视图层待填，当前渲染占位文本。
 */

import { useEffect } from "react";
import { Text, useInput } from "ink";
import { useStore } from "@/ink-ui/store/index.js";

/** TUI 应用根组件 */
export function App() {
  const ctx = useStore((s) => s.ctx);

  // 空输入钩子：把 stdin 拉入 raw mode。两层作用——
  // 1) 拉住事件循环：raw mode 下 stdin 被 ref()，进程保持活跃直到 Ink 接管退出；
  // 2) 让 Ink 接管 Ctrl+C：raw mode 下 Ctrl+C 变成 \x03 字符而非 SIGINT，
  //    由 Ink 的 handleInput 拦截并触发 unmount。
  useInput(() => {});

  useEffect(() => {
    // 应用级副作用装配点：全局快捷键、主题注册、错误边界 / 全局错误汇报……
    return () => {
      // 清理
    };
  }, []);

  return (
    <>
      {/* ink-ui/layout：页面框架（页眉 / 状态栏 / 页脚） */}
      {/* ink-ui/views：按当前状态切换的视图 */}
      {/* ink-ui/components：原子构件 */}
      <Text bold>{ctx ? "proxy-tui" : "initializing..."}</Text>
    </>
  );
}
