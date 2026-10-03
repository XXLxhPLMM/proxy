/**
 * @fileoverview 控制面端点表的 `acl` 一段 —— 镜像根仓 `src/manager/routes/acl.ts`
 * @module api/endpoints/acl
 * @description
 * ⚠️ 手抄的弱耦合：这一段与那一侧那个文件里的 `(method, path)` **逐条相等**。牙齿在根仓
 * `tests/unit/manager-tui-contract.test.ts`（从**两侧源码文本**现取再比集合，不从任何一侧 import）。
 *
 * ⚠️ **同一个 `/api/acl` 上有三条**：读写面共路径而靠 `method` 分流，故「路径重复」本身合法
 * （不重复的是 `(method, path)` **组合**）。`POST` / `DELETE` 都收请求体。
 *
 * @module
 */

/** `/api/acl` 的三条：读整份 / 加一条 / 删一条（`POST` / `DELETE` 幂等，回 `changed: false`） */
export const ACL_ENDPOINTS = [
  { method: "GET", path: "/api/acl" },
  { method: "POST", path: "/api/acl" },
  { method: "DELETE", path: "/api/acl" },
] as const;