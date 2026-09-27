/**
 * @fileoverview 管道事件类型叶模块（转发导出）
 * @module core/types/pipe
 * @description
 * 管道/路由事件域的「叶模块」，不定义任何新类型，仅从 `proxy.ts` 总表转发
 * `PipeEvent` / `PipeEventSink`，供转发层与服务层按领域引入（隔离它们对总表的直接依赖）。
 *
 * 设计要点：
 * - 零运行时：仅含 `export type`，构建后完全擦除
 * - 单向依赖：依赖 `proxy.ts`，禁止被 `proxy.ts` 反向依赖；**禁止在此新增独立类型**
 */

export type { PipeEvent, PipeEventSink } from "./proxy.js";
