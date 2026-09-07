/**
 * 转发管道类型 - core/types 叶子模块
 * 职责：forward 转发管道的事件与事件槽类型（纯类型，无运行时依赖）
 * 设计：事件值传递——req/target/mode 原样带出，格式由消费方（server 层）决定，
 *       未订阅时零解析成本（与 ProxyForwardEvent 的懒求值同哲学）
 */

import type http from "node:http";

/** 管道事件：纯函数只抛不记，由调用方（HttpProxy）转抛为 proxy "pipe" 事件 */
export type PipeEvent =
  /** 目标解析失败：原始 url 原样带出 */
  | { type: "target-unresolved"; url?: string }
  /** 自环拦截（值传递）：原始请求 + 拨号目标，格式由消费方拼 */
  | { type: "loop-detected"; req: http.IncomingMessage; target: string }
  /** 上游拒绝 CONNECT：statusLine 为上游原始响应行（本身就是值，非格式化产物） */
  | { type: "upstream-refused"; statusLine: string }
  /** 路由观测（值传递）：kind/req/target/mode 原样带出，消费方自定格式；note 为附加标注（如 transparent） */
  | { type: "route"; kind: string; req: http.IncomingMessage; target: string; mode: string; note?: string }
  /** 原文兜底：不透明长文本（如重建的 upgrade 报文），仅此类保留字符串形态；thunk 惰性求值 */
  | { type: "debug"; message: string | (() => string) };

/** 管道事件槽：调用方传入，不传则静默（单测友好） */
export type PipeEventSink = (e: PipeEvent) => void;
