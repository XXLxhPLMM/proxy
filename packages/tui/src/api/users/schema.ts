/**
 * @fileoverview `users` 资源的**验证与类型**（类型全由 `z.infer` 推；端点函数在 `./client.js`）
 * @module api/users/schema
 */

import { z } from "zod";
import type { Response } from "@/lib/request/transport.js";

/** 一条账号；⚠️ `password` 只写不读（服务端一律给 `{set}`，明文永不上线） */
export const accountSchema = z.object({
  username: z.string(),
  password: z.object({ set: z.boolean() }),
  disabled: z.boolean(),
  // ⚠️ 可缺省而非可为 null：用错会把「没配配额」判成「配了个坏配额」
  quota: z.object({
    /** 配额上限（字节；0 = 不限流） */
    bytes: z.number(),
    /** 配额窗口（`day` / `month`；缺省 = `month`） */
    window: z.string().optional(),
  }).optional(),
  /** 过期时刻（epoch 毫秒；磁盘上是 ISO 串，服务端换算好两种都给） */
  expiresAt: z.number().optional(),
  /** 人读形态（服务端同时给两种，理由见 `routes/users.ts:accountView`） */
  expiresAtIso: z.string().nullable(),
  /** 按用户的个人名单（判定在代理的 personal 层，与全局名单是两类语义） */
  acl: z.object({ target: z.object({ whitelist: z.array(z.string()), blacklist: z.array(z.string()) }) }).optional(),
});

export const accountsSchema = z.object({ accounts: z.array(accountSchema) });

/** 单条那一档的信封（`{ account }`）—— ⚠️ 只给同模块 `client.ts` 的 `user()` 用（剥信封是那个函数的责任），不进 barrel */
export const accountEnvelopeSchema = z.object({ account: accountSchema });

/** ⚠️ **形状与判据同源** */
export type AccountBody = Response<z.infer<typeof accountSchema>>;
export type UsersBody = Response<z.infer<typeof accountsSchema>>;

/** `POST /api/users` 的入参；⚠️ 服务端对未知键直接 400（不是静默忽略），故只拼白名单里的键 */
export interface AccountCreateInput {
  readonly username: string;
  /** 明文密码（只在写面出现；读面只回 `{ set }`） */
  readonly password: string;
  /** 配额上限（字节；0 = 不限流） */
  readonly quotaBytes?: number;
  /** 配额窗口；`"clear"` = 清掉窗口设置（回到缺省） */
  readonly quotaWindow?: "day" | "month" | "clear";
  /** 带时区偏移的 ISO 8601 串（如 `2030-01-01T00:00:00+08:00`）；`"clear"` = 删掉过期时间 */
  readonly expiresAt?: string | "clear";
  readonly disabled?: boolean;
  /** 个人目标白名单（判定在代理的 personal 层；空数组 = 清空这份名单） */
  readonly targetWhitelist?: string[];
  /** 个人目标黑名单（同上） */
  readonly targetBlacklist?: string[];
}

/** `PUT /api/users/:username` 的入参；⚠️ **空 patch 会被服务端 400**；⚠️ `password` 不在排除项里（重设已有账号的密码是这条端点唯一的通路） */
export interface AccountUpdateInput {
  /** 新密码（重设已有账号密码的唯一通路） */
  readonly password?: string;
  /** 配额上限（字节；0 = 不限流） */
  readonly quotaBytes?: number;
  /** 配额窗口；`"clear"` = 清掉窗口设置（回到缺省） */
  readonly quotaWindow?: "day" | "month" | "clear";
  /** 带时区偏移的 ISO 8601 串；`"clear"` = 删掉过期时间 */
  readonly expiresAt?: string | "clear";
  readonly disabled?: boolean;
  /** 个人目标白名单（空数组 = 清空这份名单） */
  readonly targetWhitelist?: string[];
  /** 个人目标黑名单（同上） */
  readonly targetBlacklist?: string[];
}
