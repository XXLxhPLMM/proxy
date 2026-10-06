/**
 * @fileoverview `usage` 资源的两个端点 —— 全量账本 / 单个用户（⚠️ 镜像根仓 `src/manager/routes/usage.ts`）
 * @module api/usage
 * @description
 * ⚠️ **两条不同形，且那个区别是本目录最容易长错的一处**：`:username` 那条把 `usage` 从**数组**换成
 * **一个对象**。当成同一个形状的后果不是报错，而是「查一个人的用量」渲染成一个长度为 1 的表 ——
 * 看起来能跑，而显示的是错的形态。故判据分两个（`usageSchema` / `usageOneSchema`），
 * 而**它们的类型也从各自那个 schema 推**（`UsageBody` / `UsageOneBody`），故「渲染成表」那一侧拿到的是
 * 对的类型而不是一个被强行合并的 `usage`。
 *
 * ⚠️ **三段限定（`lagMs` / `sideEffect` / `note`）都是必答项**：少一段就把「落盘的那一次读取」
 * 显示成「纯读」，而账本这件事上那两者的区别正是操作者要判断的东西。
 */

import { z } from "zod";
import { endpointPath } from "@/lib/http.js";
import { sendDecoded, type ManagerTarget, type Response } from "./send.js";

const usageRowSchema = z.object({ user: z.string(), windowKey: z.string(), total: z.number() });

/** 三段限定（⚠️ 两个 schema 里逐字重复 —— 它们是**同一个**线上形状，而分开写的那份是"共用一份"纪律的例外：
 *  两者的 `usage` 不同形，合并成一个 schema 就得给它一个联合类型，而那会让消费面拿到一个判不出来的值） */
const qualifiers = {
  errors: z.array(z.string()),
  lagMs: z.number(),
  sideEffect: z.string(),
  note: z.string(),
};

export const usageSchema = z.object({ usage: z.array(usageRowSchema), ...qualifiers });

export const usageOneSchema = z.object({ usage: usageRowSchema, ...qualifiers });

/** ⚠️ **形状与判据同源**（⚠️ 两个 `usage` 刻意不同形，见文件头） */
export type UsageRowBody = Response<z.infer<typeof usageRowSchema>>;
export type UsageBody = Response<z.infer<typeof usageSchema>>;
export type UsageOneBody = Response<z.infer<typeof usageOneSchema>>;

/** 读全量账本（`usage` 是数组） */
export async function usage(target: ManagerTarget): Promise<UsageBody> {
  return sendDecoded(target, { method: "GET", path: "/api/usage" }, usageSchema);
}

/** 读单个用户的当前窗口（⚠️ `usage` 是**一个对象**而不是数组，见文件头） */
export async function usageFor(
  target: ManagerTarget,
  username: string,
): Promise<UsageOneBody> {
  return sendDecoded(
    target,
    { method: "GET", path: endpointPath("/api/usage/:username", username) },
    usageOneSchema,
  );
}