/**
 * @fileoverview `GET /api/status` —— 本进程事实 + 数据面活状态 + 数据源事实（⚠️ 镜像根仓 `src/manager/routes/status.ts`）
 * @module api/status
 * @description
 * **端点函数的形状**：`(method, path)` 字面量、那一段的逐字段判据、以及剥不剥信封，全在这一个文件里 ——
 * 故「加一条端点」在物理上不可能只加一半（对比更早那形态：路径在一张平表里、判据在另一个文件里、
 * 而两者的配对靠一个客户端对象串起来 —— 它们之间没有任何编译期约束）。
 *
 * ⚠️ `(method, path)` 是**手抄的弱耦合**（对面可能跑着旧版本服务端），由仓库根
 * `tests/unit/manager/tui-contract.test.ts` 从两侧源码文本现取后比集合；⚠️ **字面量必须内联在
 * {@link sendDecoded} 那一行**（`method` 写在 `path` 之前、不经 `const` 中转），否则那道护栏取不到这条端点。
 */

import { z } from "zod";
import { sendDecoded, type ManagerTarget, type Response } from "./send.js";

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

/** 读本进程与数据面状态；⚠️ 返回体**不解包**：服务端的 `reply()` 直接把它摆在顶层 */
export async function status(target: ManagerTarget): Promise<StatusBody> {
  return sendDecoded(target, { method: "GET", path: "/api/status" }, statusSchema);
}