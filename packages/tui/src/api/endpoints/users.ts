/** @fileoverview 端点表的 `users` 一段 —— 镜像根仓 `src/manager/routes/users.ts`（⚠️ 手抄的弱耦合） */

/** 列表 / 单条 / 新建（成功 **201**）/ 改 / 删；⚠️ 含 `:username` 的三条是**模板** */
export const USERS_ENDPOINTS = [
  { method: "GET", path: "/api/users" },
  { method: "GET", path: "/api/users/:username" },
  { method: "POST", path: "/api/users" },
  { method: "PUT", path: "/api/users/:username" },
  { method: "DELETE", path: "/api/users/:username" },
] as const;
