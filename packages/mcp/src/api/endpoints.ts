/**
 * @fileoverview 端点表 —— 镜像根仓 `src/manager/routes/*.ts`（⚠️ 手抄的弱耦合）
 * @module api/endpoints
 * @description **十二条**，顺序与服务端 `managerRoutes()` 一致。加一条必须同时改这里与 `src/api/*.ts`。
 */

export interface Endpoint {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  /** 含 `:username` 段的是**模板**（代入在 `@/utils/request.js:endpointPath`） */
  readonly path: string;
}

/** 本进程事实 + 数据面活状态 + 数据源事实 */
export const STATUS_ENDPOINTS: readonly Endpoint[] = [{ method: "GET", path: "/api/status" }];

/** 全量配置，逐键 phase / restartRequired / 打码值 / 来源；⚠️ **只有读**（服务端刻意没有写端点） */
export const CONFIG_ENDPOINTS: readonly Endpoint[] = [{ method: "GET", path: "/api/config" }];

/** 列表 / 单条 / 新建（成功 **201**）/ 改 / 删 */
export const USERS_ENDPOINTS: readonly Endpoint[] = [
  { method: "GET", path: "/api/users" },
  { method: "GET", path: "/api/users/:username" },
  { method: "POST", path: "/api/users" },
  { method: "PUT", path: "/api/users/:username" },
  { method: "DELETE", path: "/api/users/:username" },
];

/** 读整份 / 加一条 / 删一条 */
export const ACL_ENDPOINTS: readonly Endpoint[] = [
  { method: "GET", path: "/api/acl" },
  { method: "POST", path: "/api/acl" },
  { method: "DELETE", path: "/api/acl" },
];

/** 全量账本 / 单个用户；⚠️ 两条**不同形** */
export const USAGE_ENDPOINTS: readonly Endpoint[] = [
  { method: "GET", path: "/api/usage" },
  { method: "GET", path: "/api/usage/:username" },
];

/** 端点表平表（消费面只认这一个） */
export const ENDPOINTS: readonly Endpoint[] = [
  ...STATUS_ENDPOINTS,
  ...CONFIG_ENDPOINTS,
  ...USERS_ENDPOINTS,
  ...ACL_ENDPOINTS,
  ...USAGE_ENDPOINTS,
];
