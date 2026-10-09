/**
 * @fileoverview `GET /api/config` 的**接口** —— 读全量配置（⚠️ 镜像根仓 `src/manager/routes/config.ts`，**只有读**）
 * @module api/config/client
 * @description 判据与类型在 `./schema.js`；⚠️ `(method, path)` 字面量内联且 method 在前：根契约护栏按此排版现取（细则见 `../transport/send.js`）。
 */

import { sendDecoded, type ManagerTarget } from "../transport/send.js";
import { configSchema, type ConfigBody } from "./schema.js";

/** 读全量配置（逐键 phase / restartRequired / 打码值 / 来源） */
export async function config(target: ManagerTarget): Promise<ConfigBody> {
  return sendDecoded(target, { method: "GET", path: "/api/config" }, configSchema);
}
