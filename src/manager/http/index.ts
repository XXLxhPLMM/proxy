/**
 * @fileoverview 管理面 HTTP 传输层的出口（barrel）
 * @module manager/http/index
 * @description
 * `src/manager/http/` 目录的**唯一**出口。`server.ts` 是唯一的编排点（起 server、鉴权、路由、
 * 错误翻译），其余三个文件是它的零件，各自也可单独测：
 *
 * - `auth.ts` — `Authorization: Bearer <token>` 的**唯一**判据（空 token ⇒ 恒 401）
 * - `router.ts` — 方法 + 路径段匹配，404 / 405 / 400 三态分开
 * - `respond.ts` — JSON 输出 + `OpsError.code` → 状态码 + 栈绝不出响应
 * - `server.ts` — `node:http` 装配（**零框架依赖**）
 *
 * ## 层不变量
 *
 * - **零 console / 零 `process.*`**：诊断走注入的 `LoggerImpl`（`server.ts` 是唯一持有它的地方）。
 * - **不 import `@/admin/*`**：那边是 `proxy-cli` 的终端呈现，与本层不是同一个传输面。
 * - **不认识数据**：账号 / 名单 / 账本 / 配置的读写全在 `../routes/`，而那些路由只经 `@/ops`。
 * - **不认识子进程**：`restart` 走 `../routes/restart.ts` → `@/manager/supervisor.js`；
 *   本目录零 `child_process`。
 *
 * 本目录内**相对路径互引、禁止自引 barrel**（根 `AGENTS.md` 的 import 路径规约：barrel 会把兄弟
 * 模块全拉进循环依赖图）。
 *
 * @module
 */

export { authorize } from "./auth.js";
export { createManagerServer, MAX_BODY_BYTES, type ManagerServerOptions } from "./server.js";
export {
  reply,
  sendError,
  sendFailure,
  sendResult,
  sendUnauthorized,
  statusForOpsError,
  INTERNAL_STATUS,
  type ErrorBody,
  type HttpResult,
} from "./respond.js";
export {
  matchRoute,
  type HandlerResult,
  type RequestContext,
  type Route,
  type RouteHandler,
  type RouteMatch,
} from "./router.js";
