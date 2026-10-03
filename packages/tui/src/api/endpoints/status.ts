/**
 * @fileoverview 控制面端点表的 `status` 一段 —— 镜像根仓 `src/manager/routes/status.ts`
 * @module api/endpoints/status
 * @description
 * ⚠️ 手抄的弱耦合：这一段与那一侧那个文件里的 `(method, path)` **逐条相等**。牙齿在根仓
 * `tests/unit/manager-tui-contract.test.ts`（从**两侧源码文本**现取再比集合，不从任何一侧 import）。
 * 形状在 `@/api/types.js:StatusBody`，逐字段判据在 `@/api/wire.js`。
 *
 * @module
 */

/** `/api/status` 一条（服务端：本进程事实 + 数据面活状态 + 数据源事实） */
export const STATUS_ENDPOINTS = [{ method: "GET", path: "/api/status" }] as const;