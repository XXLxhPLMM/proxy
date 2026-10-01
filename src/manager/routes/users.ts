/**
 * @fileoverview `/api/users` —— 账号表的读与写（**全部经 `@/ops` 的账号面**）
 * @module manager/routes/users
 * @description
 * 端点表（每条都只调 `@/ops` 的一个函数，本层不重写任何账号语义）：
 *
 * | 方法 | 路径 | ops 调用 | 成功 |
 * |---|---|---|---|
 * | `GET` | `/api/users` | `listAccounts` | 200 `{accounts}` |
 * | `GET` | `/api/users/:username` | `getAccount` | 200 `{account}` / 404 |
 * | `POST` | `/api/users` | `addAccount` | 201 `{change}` / 400 / 409 |
 * | `PUT` | `/api/users/:username` | `setAccount` | 200 `{change}` / 400 / 404 |
 * | `DELETE` | `/api/users/:username` | `removeAccount` | 200 `{change}` / 400 / 404 |
 *
 * ## 密码是**只写**的（读面一律打码）
 * @description
 * 账号表里存的是**明文**密码（数据事实），而打码是**呈现决定**（与 `@/admin/users.ts`
 * 的 `maskPassword` 同一判据、同一档）。本端点把 `password` 一律渲染成
 * `{"set": true|false}`：调用方能回答「这个账号有没有密码」，但**拿不回明文**。
 *
 * 为什么 HTTP 面比终端面更严：终端输出落在人的滚动缓冲里，HTTP 响应会进浏览器历史、
 * 代理缓存、`curl -v` 的终端历史、以及**别人写的运维脚本的日志**。一个能读回全部明文密码
 * 的端点等价于一把万能钥匙，而它的用途（建号、改密码、禁用）**完全不需要读回明文**。
 * 代价是「忘了密码只能重设」——那本来就是唯一正确的处置方式。
 *
 * ## `add` 撞名是 409（不是「静默成功」也不是「覆盖」）
 * @description
 * 判据在 `@/ops/accounts.ts:addAccount`（`put` 是整条替换，让「新建」静默成功等于
 * 「我以为在新建」变成「我顺手清掉了他的配额与有效期」）。本层只把 `already-exists`
 * 映射成 409 并**原样**透传 ops 的 message（传输层不改写 ops 的文案）。
 *
 * 本模块**零 console、零 process**。
 *
 * @module
 */

import type { AuthAccount } from "@/datasource/users/index.js";
import {
  addAccount,
  getAccount,
  inertNoticeFor,
  listAccounts,
  removeAccount,
  setAccount,
  type OpsChange,
  type OpsSources,
} from "@/ops/index.js";
import { reply, type Route } from "../http/index.js";
import { accountCreateInput, accountUpdateInput, usernameFromPath } from "./input.js";
import { accountPatchFrom } from "./patch.js";

/** 装配这组端点所需的依赖 */
export interface UsersRouteDeps {
  readonly sources: OpsSources;
}

/** 一条账号的**可呈现**形态（密码已打码、字段名是 HTTP 面的词汇） */
function accountView(account: AuthAccount): Record<string, unknown> {
  return {
    username: account.username,
    // 只写不读：见文件头
    password: { set: account.password.length > 0 },
    disabled: account.disabled === true,
    quota: account.quota,
    // ops 交出的是 epoch 毫秒（归一化形态），磁盘上是 ISO 串；这里**两种都给**：
    // epoch 供程序比较，ISO 供人读（与终端面的呈现同一条纪律：形态由传输层决定）
    expiresAt: account.expiresAt,
    expiresAtIso: account.expiresAt === undefined ? null : new Date(account.expiresAt).toISOString(),
    acl: account.acl,
  };
}

/**
 * 写操作的统一响应体
 * @description
 * `changed` **原样**来自 ops 的 `OpsChange.changed`。它恒为 `true`（账号写面每条都有实际
 * 变更），但本层仍然把它带出去：`changed: false` 在名单写面是一次**成功**的 no-op，
 * 而调用方判断「这次调用到底改没改东西」的判据**只有这一个字段**——各端点自己发明一个
 * 「本端点没有 no-op 所以不用给」的形状，就等于让调用方为每个端点各写一次判断。
 *
 * 另附 `notice`：`inertNoticeFor` 在 `AUTH_TYPE=jwt` 下会说「你刚写的 expiresAt / disabled
 * 不生效」。终端面有这条（`@/admin/index.ts` 在每个写命令后调它），HTTP 面**同样必须有**
 * ——「以为把这个账号封住了」会一直活到下一次重启。
 */
function changeView(change: OpsChange, sources: OpsSources): Record<string, unknown> {
  return { changed: change.changed, message: change.message, notice: inertNoticeFor(sources) };
}

/** `/api/users` 的五条路由 */
export function usersRoutes(deps: UsersRouteDeps): Route[] {
  const { sources } = deps;
  return [
    {
      method: "GET",
      path: "/api/users",
      handler: () => reply(200, { accounts: listAccounts(sources).map(accountView) }),
    },
    {
      method: "GET",
      path: "/api/users/:username",
      handler: (ctx) =>
        reply(200, { account: accountView(getAccount(sources, usernameFromPath(ctx))) }),
    },
    {
      method: "POST",
      path: "/api/users",
      handler: (ctx) => {
        const { username, password, patch } = accountCreateInput(ctx);
        const change = addAccount(sources, username, password, accountPatchFrom(patch));
        // 201：资源被创建了（`addAccount` 遇同名抛 409，不会走到这里 —— 见文件头）
        return reply(201, changeView(change, sources));
      },
    },
    {
      method: "PUT",
      path: "/api/users/:username",
      handler: (ctx) => {
        const { username, patch } = accountUpdateInput(ctx);
        return reply(200, changeView(setAccount(sources, username, accountPatchFrom(patch)), sources));
      },
    },
    {
      method: "DELETE",
      path: "/api/users/:username",
      handler: (ctx) => reply(200, changeView(removeAccount(sources, usernameFromPath(ctx)), sources)),
    },
  ];
}
