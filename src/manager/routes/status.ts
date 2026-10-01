/**
 * @fileoverview `GET /api/status` —— 本进程事实 + 数据面活状态 + 数据源事实
 * @module manager/routes/status
 * @description
 * 这个端点答一个问题：**「这个进程现在在服务什么」**。三块，全部现读、本模块零重算零缓存：
 *
 * - `process` — 本进程身份与运行时长（pid / node / platform / cwd）。
 *   ⚠️ **`cwd` 是必答项**：`AUTH_USERS_FILE` 等相对路径按配置目录解析，不给出 cwd 就无法把
 *   「这份账号表在哪」和「我连的这个服务跑在哪」对上。
 * - `proxy` — 数据面的**活**状态（协议 / 监听地址 / `running` / 生命周期态 / 已运行时长）。
 *   控制面与数据面同进程，所以这些是**真值**而不是推断：本进程能答「端口在不在监听」，
 *   而跨进程时代只能答「那个进程还在不在」——后者证明不了任何服务状态。
 * - `data` — 此刻操作的是哪三份数据（经 `reportConfig`）。
 *
 * ## `mode` 为什么是必答字段（而不是靠 `proxy` 为 null 表达）
 * @description
 * cluster master 进程**不持有**数据面：它 fork workers 并共享监听句柄，端口由 workers 持有。
 * 那种进程里 `proxy` 恒为 null，而 null 同时也是「尚未启动」的意思——两者混在一个值里，
 * 调用方只能靠猜。故此处显式三态：
 * - `master`：本进程是 cluster master，数据面在 worker 进程里。
 * - `starting` / `running` / `stopping` / `stopped` / `error`：本进程自己持有数据面，值即
 *   `ProxyCore.state`。
 * - `inactive`：本进程不持有数据面且也不是 master（组合根尚未装配完成）。
 *
 * 本模块**零 console、零 process**，不 import `@/admin/*`。
 *
 * @module
 */

import { reportConfig, type OpsSources } from "@/ops/index.js";
import { reply, type Route } from "../http/index.js";

/** 本进程（数据面 + 控制面同一个进程）的事实 */
export interface ProcessFacts {
  readonly pid: number;
  /** 本进程启动时刻（epoch ms） */
  readonly startedAt: number;
  readonly node: string;
  readonly platform: string;
  /** 跑在哪个目录（`AUTH_USERS_FILE` 等相对路径按它解析） */
  readonly cwd: string;
}

/**
 * 数据面活状态：**由组合根从 `ProxyCore` 现取**，本层不 import 代理侧任何类型
 * @description
 * 刻意**不是** `ProxyCore`：那是代理层的类型，而本层是传输面。让组合根适配成这份最小形状，
 * 本层就与「数据面由谁实现」彻底无关——换一种代理实现只需改组合根那一处适配。
 */
export interface DataPlaneStatus {
  /** 本进程的进程模式；见文件头「`mode` 为什么是必答字段」 */
  readonly mode: string;
  readonly protocol: string | null;
  readonly host: string | null;
  readonly port: number | null;
  /** 数据面是否正在接受连接。`mode === "master"` 时恒为 false（端口由 workers 持有） */
  readonly running: boolean;
  /** 当前这一轮开始监听的时刻（epoch ms），从未监听过为 null */
  readonly startedAt: number | null;
  /** 已运行时长（ms），从未监听过为 null */
  readonly uptimeMs: number | null;
}

/** 装配这个端点所需的依赖 */
export interface StatusRouteDeps {
  readonly sources: OpsSources;
  /** 注入而不是读 `process.*`：组合根是宿主采集的**唯一**边界（与 `src/cli.ts` 同纪律） */
  readonly processFacts: ProcessFacts;
  /** 现读的数据面活状态（组合根持有 `ProxyCore`，本层只负责渲染） */
  readonly dataPlane: () => DataPlaneStatus;
}

/**
 * 构造 `GET /api/status` 的路由
 * @description
 * `running` 与 `mode` 一起给，且**响应里逐字带 `runningMeans`**：master 模式下端口由
 * worker 持有，`running: false` 完全正常；不解释这一句，调用方会把正常的 cluster 部署读成
 * 「代理没起来」。
 *
 * @param deps - 见 {@link StatusRouteDeps}
 * @returns 路由
 */
export function statusRoute(deps: StatusRouteDeps): Route {
  const { sources, processFacts, dataPlane } = deps;
  return {
    method: "GET",
    path: "/api/status",
    handler: () =>
      reply(200, {
        process: {
          ...processFacts,
          uptimeMs: Date.now() - processFacts.startedAt,
        },
        proxy: dataPlane(),
        runningMeans:
          "数据面是否正在接受连接。本进程就是代理进程，故 running=true 即端口已在监听；" +
          "cluster master 模式下端口由 worker 进程持有，本进程 running 恒为 false。",
        data: reportConfig(sources),
      }),
  };
}
