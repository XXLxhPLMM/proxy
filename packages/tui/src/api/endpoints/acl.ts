/** @fileoverview 端点表的 `acl` 一段 —— 镜像根仓 `src/manager/routes/acl.ts`（⚠️ 手抄的弱耦合） */

/** `/api/acl` 的三条：读整份 / 加一条 / 删一条；⚠️ 读写靠 `method` 分流，不重复的是 `(method, path)` 组合 */
export const ACL_ENDPOINTS = [
  { method: "GET", path: "/api/acl" },
  { method: "POST", path: "/api/acl" },
  { method: "DELETE", path: "/api/acl" },
] as const;
