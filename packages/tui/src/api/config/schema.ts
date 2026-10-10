/**
 * @fileoverview `GET /api/config` 的**验证与类型** —— 全量配置（⚠️ 镜像根仓 `src/manager/routes/config.ts`，**只有读**）
 * @module api/config/schema
 * @description 类型全由 `z.infer` 推；端点函数在 `./client.js`。
 *
 * ⚠️ **打码是服务端的决定，本包不重打码、也不许再判一次「哪些键是秘密」**（那是服务端 `CONFIG_SECRET_KEYS`
 * 一份清单的读法，读一份拷贝就是清单漂移的起点，漂了的后果是一处打码一处明文）。
 */

import { z } from "zod";
import type { Response } from "@/lib/request/transport.js";

/** `GET /api/config` 的一个键（**值可能已被服务端打码**） */
export const configKeySchema = z.object({
  /** store 键名（`AppConfig` 字段名） */
  key: z.string(),
  /** 该键对应的 env 名（`FIELDS` 的 env 是唯一真相源） */
  env: z.string(),
  /** 生效时机 */
  phase: z.enum(["startup", "runtime"]),
  /** startup 相位 = 改完必须重启进程（服务端由 `phase` 派生，本包不重算） */
  restartRequired: z.boolean(),
  /** 这个键的值是否已打码（true 时看到的不是真值） */
  secret: z.boolean(),
  // 唯一一个刻意透传的字段：类型由服务端的配置 schema 决定，本包不猜（消费面 `configValue` 按值分派）
  // ⚠️ **`.optional()` 而非必填**：服务端 `config.ts:68` 写的是 `value: k.value`，而那个值可以是
  // `undefined` ⇒ `JSON.stringify` 会**整个键省掉**。必填的写法会在一个完全合法的响应上判成形状不对。
  value: z.unknown().optional(),
  /** 该键来自哪个 env 文件；宿主 env / CLI / 缺省来的没有这个键。⚠️ 可缺省而非可为 null —— JSON 里「键不存在」不是 `null` */
  fileOrigin: z.string().optional(),
  /** 该键是否由宿主环境变量显式给出 */
  fromEnv: z.boolean(),
  /** 该键是否由 CLI argv 显式给出 */
  fromArgv: z.boolean(),
});

export const configSchema = z.object({
  /** 配置目录锚点 */
  configDir: z.string(),
  /** 候选 env 文件（绝对路径，含不存在的——「不在列表里」才是「没读」的事实） */
  envFiles: z.array(z.string()),
  /** 逐键事实（服务端按 `FIELDS` 的声明顺序给） */
  keys: z.array(configKeySchema),
  summary: z.object({
    /** 键总数 */
    total: z.number(),
    /** startup 相位的键数（改完要重启） */
    startup: z.number(),
    /** runtime 相位的键数 */
    runtime: z.number(),
    /** 哪几个键的值被打码（点名，省得调用方猜） */
    secrets: z.array(z.string()),
  }),
});

/** ⚠️ **形状与判据同源**（`z.infer` 从上面那两个 schema 推） */
export type ConfigKeyBody = Response<z.infer<typeof configKeySchema>>;
export type ConfigBody = Response<z.infer<typeof configSchema>>;
