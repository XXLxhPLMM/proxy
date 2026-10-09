/**
 * @fileoverview `GET /api/status` 的**验证与类型**（类型全由 `z.infer` 推；端点函数在 `./client.js`）
 * @module api/status/schema
 */

import { z } from "zod";
import type { Response } from "@/lib/request/transport.js";

/** 一条数据的「哪个驱动、落在哪」（`根仓 src/ops/report.ts:OpsDataRef` 的线上同形） */
const dataRef = z.object({ driver: z.string(), path: z.string() });

/** 账本位置 —— ⚠️ **只有目录**（服务端刻意不给文件名，给了就要造一个数据源，见 `ops/report.ts`） */
const usageRef = z.object({ driver: z.string(), dir: z.string() });

/** `GET /api/status` 的 `data` 段（`根仓 src/ops/report.ts:OpsConfigReport` 的线上同形） */
const statusData = z.object({
  configDir: z.string(),
  envFiles: z.array(z.string()),
  accounts: dataRef,
  acl: dataRef,
  // ⚠️ 只有 dir、没有 path —— 那是服务端的刻意取舍（给文件名就要造一个数据源，见 ops/report.ts）
  usage: usageRef,
  auth: z.object({ enabled: z.boolean(), type: z.string() }),
  quotaResetHour: z.number(),
  defaultQuotaWindow: z.string(),
  flushIntervalMs: z.number(),
});

/** `GET /api/status` 的响应体；⚠️ `runningMeans` 逐字上屏（本进程尚无数据面时它报 `running: false`，那是如实，不是异常） */
export const statusSchema = z.object({
  process: z.object({
    pid: z.number(),
    startedAt: z.number(),
    uptimeMs: z.number(),
    node: z.string(),
    platform: z.string(),
    cwd: z.string(),
  }),
  proxy: z.object({
    mode: z.string(),
    protocol: z.string().nullable(),
    host: z.string().nullable(),
    port: z.number().nullable(),
    running: z.boolean(),
    startedAt: z.number().nullable(),
    uptimeMs: z.number().nullable(),
  }),
  runningMeans: z.string(),
  data: statusData,
});

/** ⚠️ **形状与判据同源**（`z.infer` 从上面那个 schema 推）—— 本类型不可能与它的判据漂 */
export type StatusBody = Response<z.infer<typeof statusSchema>>;
/** `GET /api/status` 的 `data` 段（单独取出来给上层用） */
export type StatusData = Response<z.infer<typeof statusData>>;
/** 一条数据的「哪个驱动、落在哪」 */
export type DataRef = Response<z.infer<typeof dataRef>>;
/** 账本位置（⚠️ 只有目录） */
export type UsageRef = Response<z.infer<typeof usageRef>>;
