/**
 * @fileoverview `src/protocol/` 目录的唯一出口
 * @module protocol/index
 * @description 别的目录只引这一个文件，不引 `@/protocol/server.js` 之类深层实现路径。
 * `src/tools/` 要的就是 {@link ToolDefinition} 这个接缝 —— 工具作者不 import 协议层，
 * 反过来协议层也不 import 工具，两边只在这份类型上相遇。
 */

export { dispatch, handleLine, indexTools, serveStdio, runStdioServer, LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, type StdioStreams } from "./server.js";
export { asJsonRpcRequest, fail, ok, JSON_RPC_ERROR_CODE, type JsonRpcError, type JsonRpcErrorResponse, type JsonRpcId, type JsonRpcRequest, type JsonRpcResponse, type JsonRpcSuccess } from "./jsonrpc.js";
export type { JsonSchema, JsonSchemaProperty, TextContent, ToolDefinition, ToolResult } from "./types.js";