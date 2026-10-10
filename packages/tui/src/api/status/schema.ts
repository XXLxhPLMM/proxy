/**
 * @fileoverview `GET /api/status` 的**验证与类型**（类型全由 `z.infer` 推；端点函数在 `./client.js`）
 * @module api/status/schema
 */

import { z } from "zod";
import type { Response } from "@/lib/request/transport.js";

/** 一条数据的「哪个驱动、落在哪」（`根仓 src/ops/report.ts:OpsDataRef` 的线上同形） */
const dataRef = z.object({
  /** 驱动名（服务端的注册表判据） */
  driver: z.string(),
  /** 解析后的绝对路径 */
  path: z.string(),
});

/** 账本位置 —— ⚠️ **只有目录**（服务端刻意不给文件名，给了就要造一个数据源，见 `ops/report.ts`） */
const usageRef = z.object({
  driver: z.string(),
  /** 账本所在目录 */
  dir: z.string(),
});

/** `GET /api/status` 的 `data` 段（`根仓 src/ops/report.ts:OpsConfigReport` 的线上同形） */
const statusData = z.object({
  /** 配置目录锚点 */
  configDir: z.string(),
  /** 实际读到的 env 文件（可能为空） */
  envFiles: z.array(z.string()),
  accounts: dataRef,
  acl: dataRef,
  // ⚠️ 只有 dir、没有 path —— 那是服务端的刻意取舍（给文件名就要造一个数据源，见 ops/report.ts）
  usage: usageRef,
  /** 鉴权开关与类型 */
  auth: z.object({ enabled: z.boolean(), type: z.string() }),
  /** 配额重置小时（本地时区，0–23） */
  quotaResetHour: z.number(),
  /** 账号没配窗口时生效的缺省窗口（`day` / `month`） */
  defaultQuotaWindow: z.string(),
  /** 账本落盘周期（ms）；镜像误差上界是它的两倍 */
  flushIntervalMs: z.number(),
});

/** `GET /api/status` 的响应体；⚠️ `runningMeans` 逐字上屏（本进程尚无数据面时它报 `running: false`，那是如实，不是异常） */
export const statusSchema = z.object({
  process: z.object({
    pid: z.number(),
    /** 启动时刻（epoch 毫秒） */
    startedAt: z.number(),
    /** 已运行时长（毫秒） */
    uptimeMs: z.number(),
    node: z.string(),
    platform: z.string(),
    /** 进程工作目录（相对路径的配置按它解析） */
    cwd: z.string(),
  }),
  proxy: z.object({
    /** 本进程模式：`starting` / `running` / `stopping` / `stopped` / `error` / `inactive` */
    mode: z.string(),
    /** 监听地址（协议 / 主机 / 端口）；未监听时都是 null */
    protocol: z.string().nullable(),
    host: z.string().nullable(),
    port: z.number().nullable(),
    /** 数据面是否正在接受连接（`mode=inactive` 时恒 false，那是如实） */
    running: z.boolean(),
    /** 本轮开始监听的时刻（epoch 毫秒）；从未监听为 null */
    startedAt: z.number().nullable(),
    /** 已运行时长（毫秒）；从未监听为 null */
    uptimeMs: z.number().nullable(),
  }),
  /** `running` 该怎么读的成句说明（界面上逐字上屏） */
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
