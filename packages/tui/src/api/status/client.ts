/**
 * @fileoverview `GET /api/status` 的**接口** —— 本进程事实 + 数据面活状态 + 数据源事实（⚠️ 镜像根仓 `src/manager/routes/status.ts`）
 * @module api/status/client
 * @description 判据与类型在 `./schema.js`；⚠️ `(method, path)` 字面量内联且 method 在前：根契约护栏按此排版现取（细则见 `../transport/send.js`）。
 */

import { sendDecoded, type ManagerTarget } from "../transport/send.js";
import { statusSchema, type StatusBody } from "./schema.js";

/** 读本进程与数据面状态；⚠️ 返回体**不解包**：服务端的 `reply()` 直接把它摆在顶层 */
export async function status(target: ManagerTarget): Promise<StatusBody> {
  return sendDecoded(target, { method: "GET", path: "/api/status" }, statusSchema);
}
