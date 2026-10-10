/**
 * @fileoverview 写操作的响应体 —— **账号写与名单写共用**这一个判据（⚠️ 镜像根仓 `src/manager/routes/{users,acl}.ts`）
 * @module api/change/schema
 * @description
 * ⚠️ **单开一个模块而不是塞进 `users/`**：它有五个调用点（账号建/改/删 + 名单加/删）而调用点分属两个资源模块，
 * 放进其中任一个就是「另一个模块从兄弟文件 import 判据」—— 那正是「重打一遍就多一份真相源」。
 */

import { z } from "zod";
import type { Response } from "@/lib/request/transport.js";

/** 写操作的响应体；⚠️ `notice`（账号写）与 `effective`（名单写）两个可选键分属两端，故都 `.optional()` */
export const changeSchema = z.object({
  /** 这次调用有没有真改到东西（`false` = 一次成功的 no-op，不是错误） */
  changed: z.boolean(),
  /** 结果说明（服务端原样给） */
  message: z.string(),
  /** 账号写面的旁注（如 jwt 下 expiresAt / disabled 不生效）；名单写面没这个键 */
  notice: z.string().nullable().optional(),
  /** 名单写面的「多久生效」说明（只在真变了时给）；账号写面没这个键 */
  effective: z.string().nullable().optional(),
});

/** ⚠️ **形状与判据同源**；⚠️ `changed: false` 是**一次成功的 no-op**，不许当错误 */
export type ChangeBody = Response<z.infer<typeof changeSchema>>;
