/**
 * @fileoverview 控制面**端点表**（⚠️ 手抄的弱耦合，不 import 服务端那份，见包级 AGENTS.md）
 * @module api/endpoints/index
 * @description
 * 表**按服务端模块分段**：`./status` · `./config` · `./users` · `./acl` · `./usage` 五个子文件各镜像根仓
 * `src/manager/routes/` 下的同名文件，本文件把它们装配成**一条**平表。分段的收益是「服务端加路由时先认出它落在
 * 哪个模块」；而消费面（`@/api/index.js` 与 `@/utils/client.js` 的 `knownEndpoints`）**只认这一个 `ENDPOINTS`**，
 * 平表与分段是同一份真相，不许任何一处另起一张。
 *
 * 装配顺序与服务端 `managerRoutes()` 一致，让 diff 可读；⚠️ 判据是**集合相等**（顺序对 diff 可读有贡献、
 * 对判据没有），牙齿在根仓 `tests/unit/manager-tui-contract.test.ts` —— 那份护栏**现列** `src/manager/routes/`
 * 与本目录两侧的文件，**不 import 任何一侧**，故 `{ method: "…", path: "…" }` 字面量的**位置**对它无所谓，
 * 但表里必须**一条不少、一条不多**。
 *
 * ⚠️ **含 `:username` 段的那几条是模板**，不是可发的路径：表里存的是带占位符的那一条，真发请求时由
 * `@/utils/http.js:endpointPath` 代入并编码（判据与已知缺口在那个文件头）。
 *
 * @module
 */

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

/** 端点表（十二条，按服务端模块装配；各子文件的 `as const` 让拼错的动词在 `tsc` 就红） */
export const ENDPOINTS: readonly Endpoint[] = [
  ...STATUS_ENDPOINTS,
  ...CONFIG_ENDPOINTS,
  ...USERS_ENDPOINTS,
  ...ACL_ENDPOINTS,
  ...USAGE_ENDPOINTS,
];