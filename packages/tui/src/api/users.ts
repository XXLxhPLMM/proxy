/**
 * @fileoverview `users` 资源的五个端点 —— 列表 / 单条 / 新建 / 改 / 删（⚠️ 镜像根仓 `src/manager/routes/users.ts`）
 * @module api/users
 * @description
 * ⚠️ **出参在两个函数之间刻意不同形**：`users()` 交出 `{ accounts: [...] }` 那个信封（消费面
 * `@/lib/exec/rows.js:userRows` 与 `/users` 弹窗画的就是它），而 `user()` **剥掉 `{ account }`** 交出账号本身。
 * 这不是笔误 —— 两条路各有各的消费面，而「信封在哪剥」写在端点自己这一行比写在调用点更不容易漂。
 *
 * ⚠️ **写面逐字转发入参**（`JSON.stringify` 顺手丢掉 `undefined` 的键，故可选键不传就是没有）：
 * 服务端对未知键直接 400，而本包的入参接口**逐字段列全了**合法键 —— 挑白名单的那层知识在弹窗那一侧
 * （它把表单字段映射成入参），端点这一层只负责原样送出去。
 */

import { z } from "zod";
import { TuiError } from "@/lib/errors.js";
import { endpointPath } from "@/lib/http.js";
import { changeSchema, type ChangeBody } from "./change.js";
import { sendDecoded, type ManagerTarget, type Response } from "./send.js";

/** 一条账号；⚠️ `password` 只写不读（服务端一律给 `{set}`，明文永不上线） */
export const accountSchema = z.object({
  username: z.string(),
  password: z.object({ set: z.boolean() }),
  disabled: z.boolean(),
  // ⚠️ 可缺省而非可为 null：用错会把「没配配额」判成「配了个坏配额」
  quota: z.object({ bytes: z.number(), window: z.string().optional() }).optional(),
  expiresAt: z.number().optional(),
  /** 人读形态（服务端同时给两种，理由见 `routes/users.ts:accountView`） */
  expiresAtIso: z.string().nullable(),
  /** 按用户的个人名单（判定在代理的 personal 层，与全局名单是两类语义） */
  acl: z.object({ target: z.object({ whitelist: z.array(z.string()), blacklist: z.array(z.string()) }) }).optional(),
});

export const accountsSchema = z.object({ accounts: z.array(accountSchema) });

/** 单条那一档的信封（`{ account }`）—— ⚠️ 只在 `user()` 内部用，不导出：剥信封是那个函数的责任 */
const accountEnvelopeSchema = z.object({ account: accountSchema });

/** ⚠️ **形状与判据同源** */
export type AccountBody = Response<z.infer<typeof accountSchema>>;
export type UsersBody = Response<z.infer<typeof accountsSchema>>;

/** `POST /api/users` 的入参；⚠️ 服务端对未知键直接 400（不是静默忽略），故只拼白名单里的键 */
export interface AccountCreateInput {
  readonly username: string;
  readonly password: string;
  readonly quotaBytes?: number;
  readonly quotaWindow?: "day" | "month" | "clear";
  readonly expiresAt?: string | "clear";
  readonly disabled?: boolean;
  readonly targetWhitelist?: string[];
  readonly targetBlacklist?: string[];
}

/** `PUT /api/users/:username` 的入参；⚠️ **空 patch 会被服务端 400**；⚠️ `password` 不在排除项里（重设已有账号的密码是这条端点唯一的通路） */
export interface AccountUpdateInput {
  readonly password?: string;
  readonly quotaBytes?: number;
  readonly quotaWindow?: "day" | "month" | "clear";
  readonly expiresAt?: string | "clear";
  readonly disabled?: boolean;
  readonly targetWhitelist?: string[];
  readonly targetBlacklist?: string[];
}

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