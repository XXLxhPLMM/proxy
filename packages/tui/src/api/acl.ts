/**
 * @fileoverview `acl` 资源的三个端点 —— 读整份 / 加一条 / 删一条（⚠️ 镜像根仓 `src/manager/routes/acl.ts`）
 * @module api/acl
 * @description
 * ⚠️ **两条写面都幂等**：「加一条它已经有了的」与「删一条本来就没有的」都回 200 + `changed: false`，
 * 而那**不是**一个错误（`./change.ts` 的注释与 `ChangeBody.changed` 的注释是同一条纪律的两面）。
 * ⚠️ **两条写面共用一份入参**（`AclMutationInput` 三个字段全必填），而服务端会拿它与查询串对照 ——
 * 故本包**一次都不许**改用查询串送（那要在客户端多一条分支，而那正是「删了 A 实际删了 B」最容易长出来的地方）。
 */

import { z } from "zod";
import { changeSchema, type ChangeBody } from "./change.js";
import { sendDecoded, type ManagerTarget, type Response } from "./send.js";

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

/** 读整份名单（服务端 `readAcl` 的归一化形态：三组两个方向都补齐） */
export async function acl(target: ManagerTarget): Promise<AclBody> {
  return sendDecoded(target, { method: "GET", path: "/api/acl" }, aclSchema);
}

/** 加一条（幂等：已经有了回 `changed: false`，那**不是**错误） */
export async function addAclEntry(
  target: ManagerTarget,
  input: AclMutationInput,
): Promise<ChangeBody> {
  return sendDecoded(target, { method: "POST", path: "/api/acl", body: input }, changeSchema);
}

/** 删一条（幂等：本来就没有回 `changed: false`，那**不是**错误） */
export async function removeAclEntry(
  target: ManagerTarget,
  input: AclMutationInput,
): Promise<ChangeBody> {
  return sendDecoded(target, { method: "DELETE", path: "/api/acl", body: input }, changeSchema);
}