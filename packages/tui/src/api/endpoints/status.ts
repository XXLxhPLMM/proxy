/** @fileoverview 端点表的 `status` 一段 —— 镜像根仓 `src/manager/routes/status.ts`（⚠️ 手抄的弱耦合） */

/** 本进程事实 + 数据面活状态 + 数据源事实（形状在 `@/api/types.js`，逐字段判据在 `@/api/wire.js`） */
export const STATUS_ENDPOINTS = [{ method: "GET", path: "/api/status" }] as const;
