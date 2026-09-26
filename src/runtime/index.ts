export { buildDefaultServices } from "./services.js";
export { RuntimeContext } from "./context.js";
export type { RuntimeContextOptions } from "./context.js";
export { createProxyRuntime } from "./runtime.js";
// 事件 → 落盘绑定：库调用方自己接事件桥时可以直接用它（`eventLogs: false` 时由 runtime 跳过）
export { bindProxyEventLogs } from "./event-log.js";
export type {
  ProxyRuntime,
  ProxyRuntimeOptions,
  RuntimeServices,
  RuntimeWarning,
} from "./types.js";
// 启动预设（**装配**决策，与 `@/config/presets.ts` 的配置预设完全无关）
export {
  builtinStartupPresets,
  defineStartupPreset,
  getStartupPreset,
  listStartupPresets,
  pickStartupPreset,
  registerStartupPreset,
} from "./presets.js";
export type { StartupPreset } from "./presets.js";
