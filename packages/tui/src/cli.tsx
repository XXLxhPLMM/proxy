/**
 * @fileoverview 组合根（入口）：初始化 Cordis 插件树（starter + 默认预设）→ 收尾
 * @description ⚠️ 重构空白期：UI 层重建前，本文件只把插件树启动起来并等退出信号；Ink 渲染与退出边界
 * （退出码 / 信号策略）在 UI 层重建时补在这里（等待那一棒交给 `waitUntilExit()`）。
 * 宿主来源（配置文件、库落点）不从入口注入——归 `config/` 与 `ctx.cfg`。
 */

import { pathToFileURL } from "node:url";
import { createStarter, disposeStarter } from "@/starter/index.js";
import { defaultPreset } from "@/starter/presets/default.js";

/** 等一个终止信号（UI 层重建后由 Ink 的 `waitUntilExit()` 取代） */
function waitForTermination(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

async function main(): Promise<void> {
  const app = await createStarter(defaultPreset);
  try {
    await waitForTermination();
  } finally {
    await disposeStarter(app);
  }
}

// ⚠️ 入口判据（ESM 无 require.main）：`import.meta.url` 与 `process.argv[1]` 的 file: URL 逐字相等才跑
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err: unknown) => {
    process.stderr.write(`[proxy-tui] 启动失败：${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
