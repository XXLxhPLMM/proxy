/**
 * @fileoverview `acl` 资源的**接口** —— 读整份 / 加一条 / 删一条（⚠️ 镜像根仓 `src/manager/routes/acl.ts`）
 * @module api/acl/client
 * @description 判据与类型在 `./schema.js`。
 * ⚠️ `(method, path)` 字面量内联且 method 在前：根契约护栏按此排版现取（细则见 `../transport/send.js`）。
 *
 * ⚠️ **两条写面都幂等**：「加一条它已经有了的」与「删一条本来就没有的」都回 200 + `changed: false`，
 * 而那**不是**一个错误（`../change/schema.js` 的注释与 `ChangeBody.changed` 的注释是同一条纪律的两面）。
 * ⚠️ **两条写面共用一份入参**（`AclMutationInput` 三个字段全必填），而服务端会拿它与查询串对照 ——
 * 故本包**一次都不许**改用查询串送（那要在客户端多一条分支，而那正是「删了 A 实际删了 B」最容易长出来的地方）。
 */

import { changeSchema, type ChangeBody } from "../change/schema.js";
import { sendDecoded, type ManagerTarget } from "../transport/send.js";
import { aclSchema, type AclBody, type AclMutationInput } from "./schema.js";

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
