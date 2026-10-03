/**
 * @fileoverview 控制面端点表的 `usage` 一段 —— 镜像根仓 `src/manager/routes/usage.ts`
 * @module api/endpoints/usage
 * @description
 * ⚠️ 手抄的弱耦合：这一段与那一侧那个文件里的 `(method, path)` **逐条相等**。牙齿在根仓
 * `tests/unit/manager-tui-contract.test.ts`（从**两侧源码文本**现取再比集合，不从任何一侧 import）。
 *
 * ⚠️ **两条的响应体不同形**：`/api/usage` 的 `usage` 是数组，`/api/usage/:username` 的是**一个对象** ——
 * 当成同一个形状会让「查一个人的用量」渲染成一张长度为 1 的表（看着能跑，显示的是错的形态）。
 * 两套判据在 `@/api/wire.js:SHAPES`（`usage` / `usageOne`）。
 *
 * @module
 */

/** `/api/usage` 的两条：全量账本 / 单个用户 */
export const USAGE_ENDPOINTS = [
  { method: "GET", path: "/api/usage" },
  { method: "GET", path: "/api/usage/:username" },
] as const;