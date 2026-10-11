/**
 * @fileoverview 组合根（入口）：初始化 Cordis 插件树（starter + 默认预设）
 * @description ⚠️ 重构空白期：退出边界已交由 Ink 接管——App 中的空 `useInput` 拉起 stdin 的 raw
 * mode（拉住事件循环，使进程保持活跃），Ink 在 raw mode 下拦截 Ctrl+C，其内部的 signal-exit 同时
 * 监听 SIGINT / SIGTERM，退出时由 UI 插件的清理回调统一释放 Cordis 资源并 `process.exit(0)`。
 * 本入口不再监听 SIGINT / SIGTERM。
 * 宿主来源（配置文件、库落点）不从入口注入——归 `config/` 与 `ctx.cfg`。
 */

import { pathToFileURL } from "node:url";
import { createStarter } from "@/starter/index.js";
import { defaultPreset } from "@/starter/presets/default.js";

async function main(): Promise<void> {
  await createStarter(defaultPreset);
  // 正常情况：进程由 stdin 的 raw mode 拉住，等待 Ink 接管退出（Ctrl+C / SIGTERM）。
}

// ⚠️ 入口判据（ESM 无 require.main）：`import.meta.url` 与 `process.argv[1]` 的 file: URL 逐字相等才跑
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err: unknown) => {
    process.stderr.write(`[proxy-tui] 启动失败：${err instanceof Error ? err.message : String(err)}\n`);
    // stdin 已被 raw mode ref 拉住，这里必须直接退出，不能只设 exitCode。
    process.exit(1);
  });
}
