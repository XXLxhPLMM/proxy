/**
 * @fileoverview `users` 资源的**接口** —— 列表 / 单条 / 新建 / 改 / 删（⚠️ 镜像根仓 `src/manager/routes/users.ts`）
 * @module api/users/client
 * @description 判据与类型在 `./schema.js`。
 * ⚠️ `(method, path)` 字面量内联且 method 在前：根契约护栏按此排版现取（细则见 `../transport/send.js`）。
 *
 * ⚠️ **出参在两个函数之间刻意不同形**：`users()` 交出 `{ accounts: [...] }` 那个信封（消费面
 * `@/lib/exec/rows.js:userRows` 与 `/users` 弹窗画的就是它），而 `user()` **剥掉 `{ account }`** 交出账号本身。
 * 这不是笔误 —— 两条路各有各的消费面，而「信封在哪剥」写在端点自己这一行比写在调用点更不容易漂。
 *
 * ⚠️ **写面逐字转发入参**（`JSON.stringify` 顺手丢掉 `undefined` 的键，故可选键不传就是没有）：
 * 服务端对未知键直接 400，而本包的入参接口**逐字段列全了**合法键 —— 挑白名单的那层知识在弹窗那一侧
 * （它把表单字段映射成入参），端点这一层只负责原样送出去。
 *
 * ⚠️ `(method, path)` 字面量内联且 method 在前：根契约护栏按此排版现取（细则见 `../transport/send.js`）。
 */

import { TuiError } from "@/lib/request/errors.js";
import { endpointPath } from "@/lib/request/http.js";
import { changeSchema, type ChangeBody } from "../change/schema.js";
import { sendDecoded, type ManagerTarget } from "../transport/send.js";
import {
  accountEnvelopeSchema,
  accountsSchema,
  type AccountBody,
  type AccountCreateInput,
  type AccountUpdateInput,
  type UsersBody,
} from "./schema.js";

/** 读账号清单（**带信封**：消费面要的就是 `{ accounts }` 那一段） */
export async function users(target: ManagerTarget): Promise<UsersBody> {
  return sendDecoded(target, { method: "GET", path: "/api/users" }, accountsSchema);
}

/** 读单个账号（**剥掉 `{ account }`**，交出账号本身） */
export async function user(
  target: ManagerTarget,
  username: string,
): Promise<AccountBody> {
  const decoded = await sendDecoded(
    target,
    { method: "GET", path: endpointPath("/api/users/:username", username) },
    accountEnvelopeSchema,
  );
  return decoded.account;
}

/**
 * 新建账号（成功 **201**）
 * @description 撞名回 409 `already-exists` —— `PUT` 是整条替换，故撞名必须报错（服务端那一侧的行为）
 */
export async function createAccount(
  target: ManagerTarget,
  input: AccountCreateInput,
): Promise<ChangeBody> {
  return sendDecoded(target, { method: "POST", path: "/api/users", body: input }, changeSchema);
}

/** 改单个账号（PATCH 语义但走 `PUT` —— 服务端按「出现的键就是要改的」处理） */
export async function updateAccount(
  target: ManagerTarget,
  username: string,
  patch: AccountUpdateInput,
): Promise<ChangeBody> {
  assertNonEmptyPatch(patch);
  return sendDecoded(
    target,
    { method: "PUT", path: endpointPath("/api/users/:username", username), body: patch },
    changeSchema,
  );
}

/** 删单个账号（成功 201 那一族之外的那种 `changed`） */
export async function deleteAccount(
  target: ManagerTarget,
  username: string,
): Promise<ChangeBody> {
  return sendDecoded(
    target,
    { method: "DELETE", path: endpointPath("/api/users/:username", username) },
    changeSchema,
  );
}

/**
 * `AccountUpdateInput` 至少要给一个键（与服务端那道 400 对齐，本地判只为了**快**）
 * @description ⚠️ 抛 {@link TuiError.local} 而不是 `TuiError.wire`：这次**根本没有请求**，
 * 而「哪些端点接受哪种入参」是**契约**的知识，故它住 `@/api` 而不留在拨号那一侧。
 */
export function assertNonEmptyPatch(patch: AccountUpdateInput): void {
  if (Object.keys(patch).length === 0) {
    throw TuiError.local({ message: "至少要给一个要改的字段（空 patch 不会改任何东西）" });
  }
}
