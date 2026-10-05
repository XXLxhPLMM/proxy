/**
 * @fileoverview `acl` 资源的三个端点 —— 读整份 / 加一条 / 删一条
 * @module api/acl
 * @description
 * 读走解包（`{acl: Y}` → `Y`），写操作的响应体本身就是 `ChangeBody`，不剥信封。
 *
 * ⚠️ 加与删是**同一个** `AclMutationInput`：它们定位同一条目的方式完全相同（组 + 方向 + 条目），
 * 差别只在动词上。合成一个入参类型不是为了少写一个函数，而是为了让「加」和「删」不可能
 * 定位到不同的条目上 —— 那是最容易发生又最难察觉的一类错。
 */

import type { ManagerHttp } from "../utils/request.js";
import { asRecord } from "./decode.js";
import type { AclBody, AclMutationInput, ChangeBody } from "./types.js";

const PATH = "/api/acl";
const WHAT = "GET /api/acl 的 acl";

/** 读整份名单（解包后的 `acl`） */
export async function getAcl(http: ManagerHttp): Promise<AclBody["acl"]> {
  const body = await http.request({ method: "GET", path: PATH });
  return asRecord(body["acl"], WHAT) as unknown as AclBody["acl"];
}

/** 加一条名单条目；⚠️ 加已存在的条目回 `changed: false`，那是成功的 no-op，不是失败 */
export async function addAclEntry(
  http: ManagerHttp,
  input: AclMutationInput,
): Promise<ChangeBody> {
  const body = await http.request({ method: "POST", path: PATH, body: { ...input } });
  return body as unknown as ChangeBody;
}

/** 删一条名单条目；⚠️ 删不存在的条目同样回 `changed: false` */
export async function removeAclEntry(
  http: ManagerHttp,
  input: AclMutationInput,
): Promise<ChangeBody> {
  const body = await http.request({ method: "DELETE", path: PATH, body: { ...input } });
  return body as unknown as ChangeBody;
}
