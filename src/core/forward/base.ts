/**
 * @fileoverview 转发器公共基类
 * @module core/forward/base
 * @description
 * 四个转发器（http/tunnel/websocket/socks）共享的拨号器与事件槽收敛到一处：
 * - `dialer`：共享 `Dialer` 实例（无状态，按请求拨号/桥接）
 * - `emit`：同时承载本层 `PipeEvent`（route/upstream-*）与拨号守卫的 `HelperEvent`（onEvent 透传），
 *   server 层按 `type` 统一分派
 * - `emitWithUser`：附带已鉴权用户名发事件（socks 的每会话身份经参数逐次传入）
 *
 * 设计要点：
 * - 泛型 `E` 是事件联合类型：默认 `PipeEvent`，同时透传守卫事件的转发器传 `PipeEvent | HelperEvent`
 * - 依赖方向：`base → guard/dial/types` 单向，四个转发器只 `extends` 本类、不再各写一份字段与构造器
 */

import { createEventEmitter } from "@/core/guard.js";
import type { PipeEvent, PipeEventSink } from "@/core/types/proxy.js";
import { Dialer } from "./dial.js";

/**
 * 转发器公共基类
 * @typeParam E - 事件联合类型（默认 `PipeEvent`）
 */
export abstract class ForwarderBase<E = PipeEvent> {
  /** 共享拨号器（稳态无状态，可跨连接复用） */
  protected readonly dialer = new Dialer();

  /** 事件槽（容错包装：回调异常被吞，不反噬主流程） */
  protected readonly emit: (e: E) => void;

  /**
   * @param sink - 事件汇（server 层注入；守卫事件与管道事件结构兼容，同一槽透传）
   */
  constructor(sink?: PipeEventSink) {
    // 守卫事件与管道事件结构兼容（type/message/err），server 层按 type 统一分派
    this.emit = createEventEmitter<E>(sink as unknown as ((e: E) => void) | undefined);
  }

  /**
   * 发事件并附带已鉴权用户名
   * @description 身份是**每会话状态**：只能经参数逐次传入，绝不存进本类字段
   * （四个 SOCKS server 共享同一个转发器实例，存字段会让并发会话互相串号）
   * @param e - 待发事件
   * @param user - 已鉴权用户名，无则原样发出
   */
  protected emitWithUser(e: PipeEvent, user?: string): void {
    this.emit((user ? { ...e, user } : e) as E);
  }
}
