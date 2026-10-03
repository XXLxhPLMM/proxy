/** @fileoverview 端点表的 `usage` 一段 —— 镜像根仓 `src/manager/routes/usage.ts`（⚠️ 手抄的弱耦合） */

/** 全量账本 / 单个用户；⚠️ 两条**不同形**（判据在 `@/api/wire.js` 的 `usage` / `usageOne`） */
export const USAGE_ENDPOINTS = [
  { method: "GET", path: "/api/usage" },
  { method: "GET", path: "/api/usage/:username" },
] as const;
