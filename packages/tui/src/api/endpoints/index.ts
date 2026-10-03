/** @fileoverview 端点表的**平表装配**（⚠️ 手抄的弱耦合，见 `src/api/AGENTS.md`） */

import { ACL_ENDPOINTS } from "./acl.js";
import { CONFIG_ENDPOINTS } from "./config.js";
import { STATUS_ENDPOINTS } from "./status.js";
import { USAGE_ENDPOINTS } from "./usage.js";
import { USERS_ENDPOINTS } from "./users.js";

/** HTTP 动词（只用控制面用到的四种；表外的动词在服务端一律 405） */
export type Method = "GET" | "POST" | "PUT" | "DELETE";

/** 一条端点 */
export interface Endpoint {
  readonly method: Method;
  /** 路径；含 `:username` 段的是**模板**（代入在 `@/utils/http.js:endpointPath`） */
  readonly path: string;
}

/** 端点表（十二条，五个模块常量装配而来，顺序与服务端 `managerRoutes()` 一致）；⚠️ 消费面只认这一个 */
export const ENDPOINTS: readonly Endpoint[] = [
  ...STATUS_ENDPOINTS,
  ...CONFIG_ENDPOINTS,
  ...USERS_ENDPOINTS,
  ...ACL_ENDPOINTS,
  ...USAGE_ENDPOINTS,
];