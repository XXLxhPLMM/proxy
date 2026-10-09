/**
 * @fileoverview `usage` 资源的**接口** —— 读全量账本 / 读单个用户（⚠️ 镜像根仓 `src/manager/routes/usage.ts`）
 * @module api/usage/client
 * @description 判据与类型在 `./schema.js`。
 * ⚠️ `(method, path)` 字面量内联且 method 在前：根契约护栏按此排版现取（细则见 `../transport/send.js`）。
 * ⚠️ `usageFor` 的 `usage` 是**一个对象**而不是数组（当成数组会渲染错表）。
 */

import { endpointPath } from "@/lib/request/http.js";
import { sendDecoded, type ManagerTarget } from "../transport/send.js";
import { usageOneSchema, usageSchema, type UsageBody, type UsageOneBody } from "./schema.js";

/** 读全量账本（`usage` 是数组） */
export async function usage(target: ManagerTarget): Promise<UsageBody> {
  return sendDecoded(target, { method: "GET", path: "/api/usage" }, usageSchema);
}

/** 读单个用户的当前窗口（⚠️ `usage` 是**一个对象**而不是数组，见 `./schema.js`） */
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
