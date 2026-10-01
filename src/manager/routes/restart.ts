/**
 * @fileoverview `POST /api/restart` —— 经 `../supervisor.ts` 重启被监管的进程
 * @module manager/routes/restart
 * @description
 * 这是唯一一个**改进程状态**的端点，也是唯一一个不经 `@/ops` 的端点（`@/ops` 管的是
 * 三份**数据**，进程不是数据）。它只调 `Supervisor.restart()`，**不**自己 spawn / kill。
 *
 * ## `ok: true` 的措辞：本端点**必须**给出的限定
 * @description
 * 监管者文件头逐字写着：`ok: true` = 旧进程**真的退出了**（`exit` 事件已到）+ 新进程
 * **被 OS 接受**（`spawn` 事件已到）+ 过了 settle 窗口它**还没自己退出**。
 *
 * 它**不等于服务健康**：`dist/app.js` 只有 cluster worker 才发 IPC `ready`，单进程模式
 * 没有任何 ready 信号，而监管者用 `stdio: "inherit"` 拿不到子进程的 stdout。于是
 * 「端口已在监听 / 配置已加载成功」在本层**无法证明**。故本模块在 `ok: true` 的响应里
 * **逐字带上 `settledMeans`**，而**不**写「服务已恢复」——那是一个本层证明不了的事实，
 * 写出去就是一次假绿。
 *
 * ## 失败回 500 而不是 200 + `ok: false`
 * @description
 * `supervisor.restart()` 的失败形态有三种（并发被拒 / 停旧失败 / 拉起新失败），
 * **本层无法在不猜文案的前提下区分它们**（`RestartResult` 只有一个 `error` 字符串）。
 * 于是一律 500：请求本身合法，是**这次操作没做成**。把 `ok: false` 塞进 200 会让
 * 「HTTP 成功」与「重启失败」并存，而监控只看得见前者。
 *
 * `error` 字符串**原样**透传（它是监管者给人读的事实陈述，含 pid / 等待时长 / 退出码，
 * 不含栈、不含 token）。
 *
 * 本模块**零 console、零 process**。
 *
 * @module
 */

import { reply, type Route } from "../http/index.js";
import type { Supervisor } from "../supervisor.js";

/** 装配这个端点所需的依赖 */
export interface RestartRouteDeps {
  readonly supervisor: Supervisor;
}

/** `ok: true` 时必须随响应出去的限定（与 `../supervisor.ts` 文件头逐字对应） */
const SETTLED_MEANS =
  "旧进程已确认退出、新进程已被操作系统接受、且过了 settle 观察窗它还没自己退出。" +
  "这**不**表示服务已恢复：单进程模式没有任何 ready 信号，端口是否已在监听、配置是否加载成功，本层无法证明。";

/** `POST /api/restart` 的路由 */
export function restartRoute(deps: RestartRouteDeps): Route {
  const { supervisor } = deps;
  return {
    method: "POST",
    path: "/api/restart",
    handler: async () => {
      const result = await supervisor.restart();
      if (!result.ok) {
        // 见文件头：三种失败无法在不猜文案的前提下区分，故一律 500（操作没做成）
        return reply(500, {
          ok: false,
          error: result.error,
          previousPid: result.previousPid,
          restarts: result.restarts,
          durationMs: result.durationMs,
          settled: false,
        });
      }
      return reply(200, {
        ok: true,
        pid: result.pid,
        previousPid: result.previousPid,
        restarts: result.restarts,
        durationMs: result.durationMs,
        settled: result.settled,
        settledMeans: SETTLED_MEANS,
      });
    },
  };
}
