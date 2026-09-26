/**
 * @fileoverview 管道事件类型叶模块（转发导出）
 * @module core/types/pipe
 * @description
 * 本文件为管道/路由事件域的「叶模块」，不定义任何新类型，仅从 `proxy.ts`
 * 总表转发 `PipeEvent / PipeEventSink`，供转发层与服务层按领域引入。
 *
 * 职责：
 * - 转发 `PipeEvent`（值传递的路由事件）与 `PipeEventSink`（事件汇回调）
 * - 隔离转发层与 `server/index.ts` 对总表的直接依赖，使导入语义按域收敛
 *
 * 设计要点：
 * - 零运行时：仅含 `export type`，构建后完全擦除
 * - 单向依赖：依赖 `proxy.ts`，禁止被 `proxy.ts` 反向依赖；禁止在此新增独立类型
 * - 值传递语义：`PipeEvent` 的 `req/target/mode` 等字段由转发层原样带出，
 *   格式由 server 层的 pipe handler 拼接，转发层不做日志拼装
 *
 * 使用示例：
 * ```ts
 * import type { PipeEvent, PipeEventSink } from "@/core/types/pipe.js";
 *
 * const onPipe: PipeEventSink = (e: PipeEvent) => {
 *   console.log(`[pipe] ${e.type} -> ${e.target} (${e.mode})`);
 * };
 * // forward 层产生事件后经 server 注入的事件槽（内部直接 publish `pipe`）透传至 server 层统一落盘
 * ```
 */

export type { PipeEvent, PipeEventSink } from "./proxy.js";
