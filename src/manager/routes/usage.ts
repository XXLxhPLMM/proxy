/**
 * @fileoverview `/api/usage` —— 配额账本的**只读**读面（经 `@/ops`）
 * @module manager/routes/usage
 * @description
 * 端点表：
 *
 * | 方法 | 路径 | 入参 | ops 调用 | 成功 | 失败 |
 * |---|---|---|---|---|---|
 * | `GET` | `/api/usage` | — | `readUsage` | 200 | 500 |
 * | `GET` | `/api/usage/:username` | 路径 `:username` | `readUsage` + `usageFor` | 200 | 404 / 500 |
 *
 * ## 响应里**必须**带的两句限定（不是可选项）
 * @description
 * 1. `lagMs`：这个账本读数最多比运行中代理的判定新这么多毫秒（`2 ×` 落盘周期，见
 *    `@/ops/usage.ts` 文件头）。不带它，运维会把「账本此刻记着多少」读成
 *    「这个账号现在还能用多少」——后者是代理进程内存里的数，不是这份文件。
 * 2. `note`：本工具**不能清账**。`usage` 没有任何写端点，且这不是「还没做」：
 *    判定读的是进程内镜像、合并用 `max(本进程值, 账本值)`，从第二个进程删账本里的行
 *    对运行中的代理**永不生效**（完整推导见 `@/ops/usage.ts`）。
 *
 * ## ⚠️ 本端点**有副作用**：`readUsage` 会物化账本文件
 * @description
 * `readUsage` 走 `UsageSource.open()`（建存储 → 回读一次），而数据源层的纪律是
 * 「目标不存在就物化」。故在空部署上查一次用例会留下一个空账本文件。这不是本层的选择，
 * 但**必须说出来**（`ops/usage.ts` 的 `snapshotOnce` 文件头有完整论证）：悄悄留下一个
 * 文件、而调用方以为是纯读，是本仓最恨的那类静默副作用。
 *
 * ## 排序：按用户名升序，**不**按用量
 * @description
 * 终端面按用量降序排（那是给人看的编排，`@/admin/usage.ts`）；JSON 面按用户名升序，
 * 因为调用方要的是**确定性**（同一份账本两次读出同一个数组，才能 diff）。排序是呈现
 * 决定，两侧各选各的，都不进 ops。
 *
 * 本模块**零 console、零 process**。
 *
 * @module
 */

import { readUsage, usageFor, type OpsSources } from "@/ops/index.js";
import { reply, type Route } from "../http/index.js";
import { usernameFromPath } from "./input.js";

/** 装配这组端点所需的依赖 */
export interface UsageRouteDeps {
  readonly sources: OpsSources;
}

/** 响应里那段**必须**带出去的限定（一处定义、两处复用，避免两句话说两种话） */
const LEDGER_NOTICE =
  "这是账本此刻记着的数；运行中的代理判定读它自己的进程内镜像，最多落后 lagMs 毫秒。" +
  "本端点不能清账——从第二个进程删账本里的行对运行中的代理无效（它的镜像按 max 合并）。";

/** `Map` → 排序后的数组（排序口径见文件头） */
function usageRows(reading: Awaited<ReturnType<typeof readUsage>>): Array<Record<string, unknown>> {
  return [...reading.usage.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([user, usage]) => ({ user, windowKey: usage.windowKey, total: usage.total }));
}

/** `/api/usage` 的两条路由 */
export function usageRoutes(deps: UsageRouteDeps): Route[] {
  const { sources } = deps;
  return [
    {
      method: "GET",
      path: "/api/usage",
      handler: async () => {
        const reading = await readUsage(sources);
        return reply(200, {
          usage: usageRows(reading),
          errors: reading.errors,
          lagMs: reading.lagMs,
          // 「查一下用量会物化账本文件」必须随响应一起出去（见文件头）
          sideEffect: "本次读取会物化账本文件（数据源的目标缺失即物化纪律）",
          note: LEDGER_NOTICE,
        });
      },
    },
    {
      method: "GET",
      path: "/api/usage/:username",
      handler: async (ctx) => {
        const username = usernameFromPath(ctx);
        const reading = await readUsage(sources);
        // `usageFor` 抛 `not-found`（账本只收「有身份且真被计量过」的用户）→ 404
        const usage = usageFor(reading, username);
        return reply(200, {
          usage: { user: username, windowKey: usage.windowKey, total: usage.total },
          errors: reading.errors,
          lagMs: reading.lagMs,
          sideEffect: "本次读取会物化账本文件（数据源的目标缺失即物化纪律）",
          note: LEDGER_NOTICE,
        });
      },
    },
  ];
}
