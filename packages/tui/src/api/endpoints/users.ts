/**
 * @fileoverview 控制面端点表的 `users` 一段 —— 镜像根仓 `src/manager/routes/users.ts`
 * @module api/endpoints/users
 * @description
 * ⚠️ 手抄的弱耦合：这一段与那一侧那个文件里的 `(method, path)` **逐条相等**，**顺序也照抄**
 * （`GET /api/users` 在 `POST /api/users` 之前，装配表才与 `managerRoutes()` 的文档顺序一致）。
 * 牙齿在根仓 `tests/unit/manager-tui-contract.test.ts`（从**两侧源码文本**现取再比集合，不从任何一侧 import）。
 *
 * `:username` 两条是**模板**：代入与编码在 `@/utils/http.js:endpointPath`。
 *
 * @module
 */

/** `/api/users` 的五条：列表 / 单条 / 新建（成功 **201**）/ 改 / 删 */
export const USERS_ENDPOINTS = [
  { method: "GET", path: "/api/users" },
  { method: "GET", path: "/api/users/:username" },
  { method: "POST", path: "/api/users" },
  { method: "PUT", path: "/api/users/:username" },
  { method: "DELETE", path: "/api/users/:username" },
] as const;