/**
 * @fileoverview `/api/acl` —— 全局访问控制名单的读与写（**全部经 `@/ops` 的名单面**）
 * @module manager/routes/acl
 * @description
 * 端点表（每条都只调 `@/ops` 的一个函数）：
 *
 * | 方法 | 路径 | 入参 | ops 调用 | 成功 |
 * |---|---|---|---|---|
 * | `GET` | `/api/acl` | — | `readAcl` | 200 `{acl}` |
 * | `POST` | `/api/acl` | body 或 query：`group` / `list` / `entry` | `addAclEntry` | 200 `{change}` |
 * | `DELETE` | `/api/acl` | 同上 | `removeAclEntry` | 200 `{change}` |
 *
 * ## `changed: false` 是**成功**，不是失败
 * @description
 * 名单的写是**幂等**的：加一条它已经有了的 / 移一条它本来就没有的，ops 返回
 * `{ changed: false }` 而**不抛错**（`@/ops/acl.ts` 与 `@/ops/change.ts` 的文件头都
 * 解释了为什么：那不是失败，是目标状态本来就是这样）。本层**如实透传** `changed`，
 * **不**把它报成 4xx（那会让调用方以为坏了并重试），也**不**报成「已加入」（那是一个
 * 字节都没动的事实）。
 *
 * 只读驱动（`ACL_DRIVER` 指向一个没有实现 `write` 的第三方驱动）由 ops 抛
 * `OpsError("read-only-driver")` → **501**：请求合法、参数合法，是**部署侧永久缺这个
 * 能力**，重试多少次都一样。
 *
 * 本模块**零 console、零 process**。
 *
 * @module
 */

import {
  OpsError,
  addAclEntry,
  readAcl,
  removeAclEntry,
  type AclGroupName,
  type AclListName,
  type OpsChange,
  type OpsSources,
} from "@/ops/index.js";
import { reply, type Route } from "../http/index.js";
import { aclMutationInput } from "./input.js";

/** 装配这组端点所需的依赖 */
export interface AclRouteDeps {
  readonly sources: OpsSources;
}

/**
 * 组名 / 方向的**收窄**（从 HTTP 文本到 ops 的闭合集合）
 * @description
 * 本层只做**类型收窄**，不做语义判据：组名 → `AclConfig` 键的映射、以及「这个组收哪种
 * 条目语法」都在 `@/ops/acl.ts`（数据的词汇，见其文件头）。这里判的只是「这三个值
 * 是不是该联合类型的合法成员」——那是 `string → AclGroupName` 必须有一次的显式收窄。
 *
 * 非法值抛 `OpsError("invalid")`（→ 400）而不是让它流到 `aclGroupKey`：后者对未知键返回
 * `undefined`，于是 `acl[undefined][list]` 是一个 `TypeError`，运维看到的是 500 +
 * 「Cannot read properties of undefined」——离真因（组名拼错）十万八千里。
 */
function asGroup(value: string): AclGroupName {
  if (value === "clientip" || value === "target" || value === "upstream") {
    return value;
  }
  throw new OpsError("invalid", `group 只能是 clientip / target / upstream，收到 ${JSON.stringify(value)}`);
}

function asList(value: string): AclListName {
  if (value === "whitelist" || value === "blacklist") {
    return value;
  }
  throw new OpsError(
    "invalid",
    `list 只能是 whitelist / blacklist，收到 ${JSON.stringify(value)}`,
  );
}

/** 写操作的响应体：`changed` **原样**来自 ops（见文件头） */
function changeView(change: OpsChange): Record<string, unknown> {
  return {
    changed: change.changed,
    message: change.message,
    // 「多久生效」只在**真变了**时说（与 `@/admin/acl.ts` 同纪律）：幂等 no-op 一个字节
    // 都没落盘，承诺一件没发生的事是本仓最恨的形状。
    effective: change.changed
      ? "运行中的代理最迟 1 秒后读到（判定期走 mtime 节流），无需重启"
      : null,
  };
}

/** `/api/acl` 的三条路由 */
export function aclRoutes(deps: AclRouteDeps): Route[] {
  const { sources } = deps;
  return [
    {
      method: "GET",
      path: "/api/acl",
      handler: () => reply(200, { acl: readAcl(sources) }),
    },
    {
      method: "POST",
      path: "/api/acl",
      handler: (ctx) => {
        const { group, list, entry } = aclMutationInput(ctx);
        return reply(
          200,
          changeView(addAclEntry(sources, asGroup(group), asList(list), entry)),
        );
      },
    },
    {
      method: "DELETE",
      path: "/api/acl",
      handler: (ctx) => {
        const { group, list, entry } = aclMutationInput(ctx);
        return reply(
          200,
          changeView(removeAclEntry(sources, asGroup(group), asList(list), entry)),
        );
      },
    },
  ];
}
