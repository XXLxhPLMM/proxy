/**
 * @fileoverview JSON-RPC 2.0 的**信封**（零 IO）—— 请求判别 + 响应构造
 * @module protocol/jsonrpc
 * @description
 * 这一层只认信封：**「这条消息合不合法」**与**「方法怎么执行」**分居两个文件，
 * 于是执行侧的异常永远不会顺手改坏信封规则。
 *
 * ⚠️ 两条 JSON-RPC 2.0 的硬规矩都在这里落地：
 * ① 一条消息没有 `id` 就是**通知**（notification），任何情况下都不许回响应 ——
 *    回一条客户端没要过的应答，会让它在等待一个自己没发过的请求。
 * ② 响应里**不许带栈**。`error.data` 是 JSON-RPC 留给「调试载荷」的位置，
 * 而 stderr 与文件日志已经在收集诊断，把它再塞进协议流等于把内部结构透给对面。
 */

/** 请求 id；⚠️ `null` 只在「压根没能读出 id」时出现（解析失败 / 不是合法 Request），回 `null` 是规范要求的 */
export type JsonRpcId = string | number | null;

/** 一条请求（`id` 缺席即通知） */
export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly method: string;
  /** ⚠️ 刻意是 `unknown`：params 的形状由**方法**决定，而信封层对方法一无所知 */
  readonly params?: unknown;
  readonly id?: JsonRpcId;
}

/** 成功响应；⚠️ `result` 是协议的结果（MCP 里它又是 tool result / 能力表等），与 `error` 互斥 */
export interface JsonRpcSuccess<T = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: T;
}

/** 错误对象；⚠️ **只有 code 与 message 两个字段**，没有 `data` */
export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
}

/** 失败响应 */
export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: JsonRpcError;
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcErrorResponse;

/** JSON-RPC 2.0 保留的五个错误码 */
export const JSON_RPC_ERROR_CODE = {
  /** 收到的东西不是 JSON */
  PARSE_ERROR: -32700,
  /** 是 JSON，但不是一条合法 Request */
  INVALID_REQUEST: -32600,
  /** 合法 Request，可方法不存在 */
  METHOD_NOT_FOUND: -32601,
  /** 方法存在，可 params 不合法 */
  INVALID_PARAMS: -32602,
  /** 执行时炸了（⚠️ 只给**协议层自己**的意外留它，工具失败不走这里） */
  INTERNAL_ERROR: -32603,
} as const;

/** 成功信封；⚠️ 唯一构造 `result` 的地方 —— 任何分支想塞 `error` 都会在这被挡住 */
export function ok<T>(id: JsonRpcId, result: T): JsonRpcSuccess<T> {
  return { jsonrpc: "2.0", id, result };
}

/**
 * 失败信封
 * @description ⚠️ 签名里**没有 `data` 参数**，是刻意的：一旦有这个位置，
 * 「顺手把 `err.stack` 带上」就成了一次不需要理由的编码选择。
 */
export function fail(id: JsonRpcId, code: number, message: string): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** 是不是一个可以读出 `id` 的值（`null` 也算 —— 那是一条「没有 id 的请求」，回 null 才是对的） */
function isIdLike(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || typeof value === "number";
}

/**
 * 把一条解出来的 JSON 判成 Request
 * @description ⚠️ 判据是**信封自身**的四条（`jsonrpc` / `method` / `id` 的可读性），与方法存不存在无关 ——
 * 「不合法 Request」与「方法找不到」是两个不同的码，混起来会让客户端分不清是自己写错了还是它要找的东西没有。
 */
export function asJsonRpcRequest(value: unknown): JsonRpcRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record["jsonrpc"] !== "2.0") {
    return null;
  }
  const method = record["method"];
  if (typeof method !== "string" || method === "") {
    return null;
  }
  const hasId = Object.prototype.hasOwnProperty.call(record, "id");
  const id = record["id"];
  if (hasId && !isIdLike(id)) {
    return null;
  }
  return {
    jsonrpc: "2.0",
    method,
    ...(hasId ? { id: id as JsonRpcId } : {}),
    ...(record["params"] === undefined ? {} : { params: record["params"] }),
  };
}

/** 能读出 id 就用它（让客户端认得出自己那条），读不出就 null —— 绝不用 `undefined` 当 id 序列化出去 */
export function idOf(value: unknown): JsonRpcId {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const id = (value as Readonly<Record<string, unknown>>)["id"];
  return isIdLike(id) ? id : null;
}