/**
 * @fileoverview TUI 应用根组件（Ink）
 * @description
 * 退出边界（退出码 / 信号策略）：由 Ink 接管——`useInput` 把 stdin 拉入 raw
 * mode，Ink 在 raw mode 下拦截 Ctrl+C；Ink 内部的 signal-exit 监听 SIGINT/SIGTERM，
 * 退出时调用 `unmount()`，本组件的清理回调负责释放 Cordis 资源并 `process.exit(0)`。
 *
 * 重构空白期：视图层待填，当前是左右分栏占位——左栏标题、右栏状态，中间分隔条可鼠标拖动。
 */

import { useEffect } from "react";
import { Text, useInput } from "ink";
import { useStore } from "@/ink-ui/store/index.js";
import { useMouseInput } from "@/ink-ui/hooks/mouse/index.js";
import { SplitLayout } from "@/ink-ui/layout/index.js";

/** TUI 应用根组件 */
export function App() {
  const ctx = useStore((s) => s.ctx);

  // 空输入钩子：把 stdin 拉入 raw mode。两层作用——
  // 1) 拉住事件循环：raw mode 下 stdin 被 ref()，进程保持活跃直到 Ink 接管退出；
  // 2) 让 Ink 接管 Ctrl+C：raw mode 下 Ctrl+C 变成 \x03 字符而非 SIGINT，
  //    由 Ink 的 handleInput 拦截并触发 unmount。
  useInput(() => {});

  // 鼠标中心源的接线：全应用唯一一处（解析与合并都在 hooks/mouse/source.ts，订阅用 useMouse /
  // useMouseState）。别处不许再调 —— 多调一次等于把同一条上报喂两遍。开关不在这里，在 UI 插件里。
  useMouseInput();

  useEffect(() => {
    // 应用级副作用装配点：全局快捷键、主题注册、错误边界 / 全局错误汇报……
    return () => {
      // 清理
    };
  }, []);

  return (
    <>
      {/* ink-ui/layout：左右分栏（左标题 / 右状态占位），分隔条可鼠标拖动改左栏列宽 */}
      {/* ink-ui/views：按当前状态切换的视图 */}
      {/* ink-ui/components：原子构件 */}
      <SplitLayout
        left={<Text bold>proxy-tui</Text>}
        right={<Text bold>{ctx ? "ready" : "initializing..."}</Text>}
      />
    </>
  );
}
