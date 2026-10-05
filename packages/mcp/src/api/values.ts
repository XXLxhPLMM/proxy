/**
 * @fileoverview 名单的取值闭集 —— 界面上「有哪些合法取值」的唯一一份
 * @module api/values
 */

import type { AclGroupName, AclListName } from "./types.js";

/** 名单组名（HTTP 面上 `clientIp` 写作 `clientip`） */
export const ACL_GROUPS: readonly AclGroupName[] = ["clientip", "target", "upstream"];

/** 名单方向 */
export const ACL_LISTS: readonly AclListName[] = ["whitelist", "blacklist"];

/** 配额窗口（⚠️ `clear` 是**清零**而不是「换窗口」，服务端 `users.ts` 有判据） */
export const QUOTA_WINDOWS = ["day", "month", "clear"] as const;

export type QuotaWindow = (typeof QUOTA_WINDOWS)[number];
