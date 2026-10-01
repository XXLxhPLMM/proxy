/**
 * @fileoverview `GET /api/status` —— 代理子进程状态 + 本进程事实
 * @module manager/routes/status
 * @description
 * 这个端点答一个问题：**「那个进程现在怎么样」**。数据全部来自
 * `../supervisor.ts:status()` 的那份快照，**本模块不重算、不缓存、不补任何字段**。
 *
 * ## `ok` 字段的措辞是本端点最重要的部分
 *
 * `supervisor.restart()` 返回的 `ok: true` **不等于「服务已恢复」**：子进程只有 cluster
 * worker 才发 IPC `ready`，单进程模式没有任何 ready 信号，而监管者用 `stdio: "inherit"`
 * 拿不到它的 stdout（见 `../supervisor.ts` 文件头）。故本模块在响应里**逐字带上那句限定**：
 * `ok` 的含义是「旧进程确认退出 + 新进程被 OS 接受 + 过了 settle 窗口它还活着」。
 * 让调用方自己去推断这句话，是本仓最恨的「把限定藏在别处」那类形状。
 *
 * 本模块**零 console、零 process**，不 import `@/admin/*`。
 *
 * @module
 */

import { reportConfig, type OpsSources } from "@/ops/index.js";
import type { Supervisor } from "../supervisor.js";
import { reply, type Route } from "../http/index.js";

/** 本进程（manager 自身）的事实 */
export interface ManagerProcessFacts {
  readonly pid: number;
  /** 本进程已运行毫秒数 */
  readonly uptimeMs: number;
  /** 本进程启动时刻（epoch ms） */
  readonly startedAt: number;
  readonly node: string;
  readonly platform: string;
  /** 跑的是哪一个被监管的入口（绝对路径）。**不含 token、不含环境变量值**。 */
  readonly appJsPath: string;
  /** 跑在哪个目录（`AUTH_USERS_FILE` 等相对路径按它解析） */
  readonly cwd: string;
}

/** 装配这个端点所需的依赖 */
export interface StatusRouteDeps {
  readonly supervisor: Supervisor;
  readonly sources: OpsSources;
  /** 注入而不是读 `process.*`：组合根是宿主采集的**唯一**边界（与 `src/cli.ts` 同纪律） */
  readonly managerFacts: ManagerProcessFacts;
}

/** 走 supervisor 的 `status()` 拿子进程快照（**零加工**） */
function childSnapshot(supervisor: Supervisor): Record<string, unknown> {
  const status = supervisor.status();
  return {
    running: status.running,
    pid: status.pid,
    startedAt: status.startedAt,
    uptimeMs: status.uptimeMs,
    restarts: status.restarts,
    unexpectedExits: status.unexpectedExits,
    lastExit: status.lastExit,
    lastExitAt: status.lastExitAt,
  };
}

/**
 * 构造 `GET /api/status` 的路由
 * @description
 * 响应体分三块：`child`（被监管的进程）/ `manager`（本进程）/ `data`（此刻操作的是哪三份
 * 数据，经 `reportConfig` —— 那是 ops 的配置事实，不在本层重算）。
 *
 * @param deps - 见 {@link StatusRouteDeps}
 * @returns 路由
 */
export function statusRoute(deps: StatusRouteDeps): Route {
  const { supervisor, sources, managerFacts } = deps;
  return {
    method: "GET",
    path: "/api/status",
    handler: () =>
      reply(200, {
        child: childSnapshot(supervisor),
        manager: {
          ...managerFacts,
          uptimeMs: Date.now() - managerFacts.startedAt,
          // 这句限定是本端点**必须**给出的东西（见文件头）：`child.running` 为真只说明
          // 「进程还在」，不说明「端口已在监听、配置已加载成功」。
          childRunningMeans: "子进程还活着（exitCode 与 signalCode 均为 null）；不表示服务已就绪或端口已在监听",
        },
        data: reportConfig(sources),
      }),
  };
}
