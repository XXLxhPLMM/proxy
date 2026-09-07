/**
 * 转发管道类型 - core/types 叶子模块
 * 职责：forward 转发管道的事件与事件槽类型（纯类型，无运行时依赖）
 */

/** 管道事件：纯函数只抛不记，由调用方（HttpProxy）转抛为 proxy "pipe" 事件 */
export type PipeEvent =
  | { type: "target-unresolved"; url?: string }
  | { type: "loop-detected"; detail: string }
  | { type: "upstream-refused"; statusLine: string }
  /** debug 消息支持 thunk：贵字符串包成函数，消费方 logger.debug 首参函数自动惰性求值 */
  | { type: "debug"; message: string | (() => string) };

/** 管道事件槽：调用方传入，不传则静默（单测友好） */
export type PipeEventSink = (e: PipeEvent) => void;
