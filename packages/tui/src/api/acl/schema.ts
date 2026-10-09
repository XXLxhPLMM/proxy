/**
 * @fileoverview `acl` 资源的**验证与类型**（类型全由 `z.infer` 推；端点函数在 `./client.js`）
 * @module api/acl/schema
 */

import { z } from "zod";
import type { Response } from "@/lib/request/transport.js";

const aclListSchema = z.object({ whitelist: z.array(z.string()), blacklist: z.array(z.string()) });

export const aclSchema = z.object({
  // ⚠️ `clientIp` 在 HTTP 面上是这个拼法，而磁盘上 `acl.json` 的键是 `clientip`（见 `@/services/config`）
  acl: z.object({ clientIp: aclListSchema, target: aclListSchema, upstream: aclListSchema }),
});

/** ⚠️ **形状与判据同源** */
export type AclListBody = Response<z.infer<typeof aclListSchema>>;
export type AclBody = Response<z.infer<typeof aclSchema>>;

/** 名单的三个组（与 `acl.json` 的键同名，`clientIp` 在 HTTP 面上是 `clientip`） */
export type AclGroupName = "clientip" | "target" | "upstream";

/** 名单的两个方向 */
export type AclListName = "whitelist" | "blacklist";

/** `POST /api/acl` / `DELETE /api/acl` 的入参（**三个字段全必填**） */
export interface AclMutationInput {
  readonly group: AclGroupName;
  readonly list: AclListName;
  readonly entry: string;
}

/** 名单方向（**唯一**这一份：界面按它遍历、入参按它取值，故它归契约而不归拨号那一侧） */
export const ACL_LISTS: readonly AclListName[] = ["whitelist", "blacklist"];

/** 名单组名 → HTTP 面用的组名（**唯一**这一份） */
export const ACL_GROUPS: readonly AclGroupName[] = ["clientip", "target", "upstream"];
