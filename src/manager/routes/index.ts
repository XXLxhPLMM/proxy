/**
 * @fileoverview manager 控制面**各资源端点**的出口（barrel）与路由表装配
 * @module manager/routes/index
 * @description
 * `src/manager/routes/` 目录的**唯一**出口。这一层是「HTTP 的方法 / 路径 / JSON 形状」与
 * `@/ops`（数据操作）之间的那一段。
 *
 * ## 端点表
 *
 * | 方法 | 路径 | 入参 | 成功 | 失败 |
 * |---|---|---|---|---|
 * | `GET` | `/api/status` | — | 200 本进程 + 数据面活状态 + 数据源事实 | 401 / 500 |
 * | `GET` | `/api/config` | — | 200 全量配置（逐键 phase / restartRequired / 打码值 / 来源） | 401 / 500 |
 * | `GET` | `/api/users` | — | 200 账号列表 | 401 / 500 |
 * | `GET` | `/api/users/:username` | 路径 | 200 单条 | 401 / 404 / 400 / 500 |
 * | `POST` | `/api/users` | body `{username, password, …patch}` | **201** | 401 / 400 / 409 / 500 |
 * | `PUT` | `/api/users/:username` | body `{…patch}` | 200 | 401 / 400 / 404 / 500 |
 * | `DELETE` | `/api/users/:username` | — | 200 | 401 / 400 / 404 / 500 |
 * | `GET` | `/api/acl` | — | 200 整份名单 | 401 / 500 |
 * | `POST` | `/api/acl` | body 或 query `group`/`list`/`entry` | 200 | 401 / 400 / 501 / 500 |
 * | `DELETE` | `/api/acl` | 同上 | 200（含 `changed:false` 的幂等 no-op） | 401 / 400 / 501 / 500 |
 * | `GET` | `/api/usage` | — | 200 账本 + `lagMs` | 401 / 500 |
 * | `GET` | `/api/usage/:username` | 路径 | 200 | 401 / 404 / 500 |
 *
 * 401 出现在**每一行**上，且它先于路由判定（`../http/server.ts` 的第 ① 步）——不是
 * 「只保护写端点」，而是保护**每一个**方法。
 *
 * ## 为什么**没有**「重启进程」这一类端点
 * @description
 * 控制面与数据面在**同一个进程**里，而进程由宿主（systemd / pm2 / docker / 人按的 Ctrl+C）
 * 拥有。自己重启自己只有两种实现：退出（那是宿主的事，本层无权替宿主决定退出码与拉起时机）
 * 或原地重载（那要求 `ProxyServer.stop()` 之后还能 `start()`，而它把 `shuttingDown` 置位后
 * 永不复位，同一对象的第二次 `stop()` 会静默 no-op——「停不掉」是比「没有这个功能」更坏的形状）。
 *
 * 故 startup 相位配置的生效路径只有一条：**改 env / env 文件 → 重启进程**。
 * 「哪些键属于这一类」由 `GET /api/config` 的 `restartRequired` 逐键给出。
 *
 * ## 层不变量
 *
 * - **零 console / 零 `process.*`**：诊断走 `../http/` 注入的 `LoggerImpl`。
 * - **不 import `@/admin/*`**：那边是 `proxy-cli` 的终端呈现，与本层不是同一个传输面。
 * - **一切数据操作经 `@/ops/index.js`**：本层不重写任何账号 / 名单 / 账本 / 配置语义。
 *   入参的**形状**判据（JSON 类型、未知键、路径穿越）是本层的职责——那是传输面的知识，
 *   ops 不该知道「HTTP 请求体长什么样」。
 * - **零 `node:child_process`**：本目录管的是**数据与只读事实**，
 *   一个字节的进程编排都不做。数据面活状态经 `ManagerRouteDeps.dataPlane` 这个**注入的现读口**
 *   拿进来，故本层与「数据面由谁实现」完全无关。
 *
 * 本目录内**相对路径互引、禁止自引 barrel**（根 `AGENTS.md` 的 import 路径规约）。
 *
 * @module
 */

import type { OpsSources } from "@/ops/index.js";
import type { Route } from "../http/index.js";
import { aclRoutes } from "./acl.js";
import { configRoute } from "./config.js";
import { statusRoute, type DataPlaneStatus, type ProcessFacts } from "./status.js";
import { usageRoutes } from "./usage.js";
import { usersRoutes } from "./users.js";

export { type DataPlaneStatus, type ProcessFacts } from "./status.js";

/** 装配整张路由表所需的依赖（**全部由组合根注入**，本层不读 `process.*`） */
export interface ManagerRouteDeps {
  readonly sources: OpsSources;
  /** 本进程事实（pid / node / platform / cwd），由组合根从宿主取 */
  readonly processFacts: ProcessFacts;
  /** 数据面活状态的现读口，由组合根持有 `ProxyCore` 并适配成本层的最小形状 */
  readonly dataPlane: () => DataPlaneStatus;
}

/**
 * 装配整张路由表
 * @description
 * 顺序即文档里的端点表顺序。⚠️ **同一 (method, path) 不许出现两次**：路由匹配取**第一**
 * 条命中，而重复只会让「哪一条生效」取决于数组顺序——那是一种没有任何东西会红的重复。
 *
 * @param deps - 见 {@link ManagerRouteDeps}
 * @returns 全部路由
 */
export function managerRoutes(deps: ManagerRouteDeps): Route[] {
  return [
    statusRoute({
      sources: deps.sources,
      processFacts: deps.processFacts,
      dataPlane: deps.dataPlane,
    }),
    configRoute({ sources: deps.sources }),
    ...usersRoutes({ sources: deps.sources }),
    ...aclRoutes({ sources: deps.sources }),
    ...usageRoutes({ sources: deps.sources }),
  ];
}
