/**
 * @fileoverview `GET /api/config` —— 全量配置（⚠️ 镜像根仓 `src/manager/routes/config.ts`，**只有读**）
 * @module api/config
 * @description
 * ⚠️ **打码是服务端的决定，本包不重打码、也不许再判一次「哪些键是秘密」**（那是服务端 `CONFIG_SECRET_KEYS`
 * 一份清单的读法，读一份拷贝就是清单漂移的起点，漂了的后果是一处打码一处明文）。
 */

import { z } from "zod";
import { sendDecoded, type ManagerTarget, type Response } from "./send.js";

/** `GET /api/config` 的一个键（**值可能已被服务端打码**） */
export const configKeySchema = z.object({
  key: z.string(),
  env: z.string(),
  phase: z.enum(["startup", "runtime"]),
  /** startup 相位 = 改完必须重启进程（服务端由 `phase` 派生，本包不重算） */
  restartRequired: z.boolean(),
  secret: z.boolean(),
  // 唯一一个刻意透传的字段：类型由服务端的配置 schema 决定，本包不猜（消费面 `configValue` 按值分派）
  // ⚠️ **`.optional()` 而非必填**：服务端 `config.ts:68` 写的是 `value: k.value`，而那个值可以是
  // `undefined` ⇒ `JSON.stringify` 会**整个键省掉**。必填的写法会在一个完全合法的响应上判成形状不对。
  value: z.unknown().optional(),
  // ⚠️ 可缺省而非可为 null —— JSON 里「键不存在」不是 `null`
  fileOrigin: z.string().optional(),
  fromEnv: z.boolean(),
  fromArgv: z.boolean(),
});

export const configSchema = z.object({
  configDir: z.string(),
  envFiles: z.array(z.string()),
  keys: z.array(configKeySchema),
  summary: z.object({
    total: z.number(),
    startup: z.number(),
    runtime: z.number(),
    secrets: z.array(z.string()),
  }),
});

/** ⚠️ **形状与判据同源**（`z.infer` 从上面那两个 schema 推） */
export type ConfigKeyBody = Response<z.infer<typeof configKeySchema>>;
export type ConfigBody = Response<z.infer<typeof configSchema>>;

/** 读全量配置（逐键 phase / restartRequired / 打码值 / 来源） */
export async function config(target: ManagerTarget): Promise<ConfigBody> {
  return sendDecoded(target, { method: "GET", path: "/api/config" }, configSchema);
}