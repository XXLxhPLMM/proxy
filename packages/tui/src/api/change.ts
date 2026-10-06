/**
 * @fileoverview 写操作的响应体 —— **账号写与名单写共用**这一个判据（⚠️ 镜像根仓 `src/manager/routes/{users,acl}.ts`）
 * @module api/change
 * @description
 * ⚠️ **单开一个文件而不是塞进 `users.ts`**：它有五个调用点（账号建/改/删 + 名单加/删）而调用点分属两个资源模块，
 * 放进其中任一个就是「另一个模块从兄弟文件 import 判据」—— 那正是 `AGENTS.md` 点名的「重打一遍就多一份真相源」。
 */

import { z } from "zod";
import type { Response } from "./send.js";

/** 写操作的响应体；⚠️ `notice`（账号写）与 `effective`（名单写）两个可选键分属两端，故都 `.optional()` */
export const changeSchema = z.object({
  changed: z.boolean(),
  message: z.string(),
  notice: z.string().nullable().optional(),
  effective: z.string().nullable().optional(),
});

/** ⚠️ **形状与判据同源**；⚠️ `changed: false` 是**一次成功的 no-op**，不许当错误 */
export type ChangeBody = Response<z.infer<typeof changeSchema>>;