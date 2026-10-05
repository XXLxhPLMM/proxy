/**
 * @fileoverview stdio 传输 + MCP 方法分发：一条 JSON 进去、一条 JSON 出来（或**不出**）
 * @module protocol/server
 * @description
 * 传输用 **换行分隔的 JSON**：一条 JSON-RPC 消息占一行。`JSON.stringify` 产出的字符串里
 * 换行只可能以 `\n` 转义出现，故按 `\n` 切行永远不会切在一条消息中间 ——
 * 这让「一行 = 一条消息」成立，而代价是本传输**不能**承载消息里的裸换行（协议本来也不许有）。
 *
 * ⚠️ **stdout 是协议流，不是日志**：这里写的每一个字节都得是 JSON-RPC 消息。
 * 任何诊断（警告、未处理的异常）只能去 stderr，否则客户端会把诊断行当成一条坏消息，
 * 而更糟的是我们无从知道哪一行是它发出的。
 *
 * ⚠️ **一条坏消息不许打断循环**：解析失败回 `-32700` 然后继续读下一行。
 * 客户端发来的一个坏帧不该让 server 死掉 —— 死了就没法回剩下的那些好请求，
 * 而死掉的 stdio 子进程对客户端来说只会表现为「工具都没了」。
 */

import type { Readable, Writable } from "node:stream";

import { asMcpError } from "../utils/errors.js";
import {
  JSON_RPC_ERROR_CODE,
  asJsonRpcRequest,
  fail,
  idOf,
  ok,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonrpc.js";
import type { JsonSchema, ToolDefinition, ToolResult } from "./types.js";

/**
 * 支持的 MCP 协议版本
 * @description ⚠️ 这张表是版本号的**唯一**真相：最新的在最前。
 *
 * **为什么回声而不是钉死一个**：钉死一个版本意味着跟它不同代的客户端
 * （比如还没升级的 Claude Desktop）要么连不上、要么在字段差异上静默错读。
 * 回声客户端报上来的那个版本，等于双方各说各话时**显式协商**了一个双方都认的基线；
 * 真的不在支持集里就退到最新那个，让差异出现在这一次握手的可见处而不是后面的工具结果里。
 * 代价是本包在协商之后**仍要**按那个版本的语义实现方法 —— 支持集里的版本之间，
 * 本包用到的字段（`initialize` / `tools/list` / `tools/call`）形状一致，故这个代价目前为零。
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** 支持集里最新的那个；⚠️ 取自表头，故改表即改它 */
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const SERVER_NAME = "@b-hole/proxy-mcp";
const SERVER_VERSION = "0.1.0";

/** 可注入的流；⚠️ 不做成模块级单例 —— 单例就没法在测试里喂数据、也没法让两个 server 同进程并存 */
export interface StdioStreams {
  readonly stdin: Readable;
  readonly stdout: Writable;
}

/** 唯一把工具装进查表的地方；⚠️ 重名当场抛 —— 那是不该存在的不变量被破坏，不能挑一个赢家继续跑 */
export function indexTools(tools: readonly ToolDefinition[]): ReadonlyMap<string, ToolDefinition> {
  const indexed = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    if (indexed.has(tool.name)) {
      throw new Error(`工具名重复：${tool.name}`);
    }
    indexed.set(tool.name, tool);
  }
  return indexed;
}

function textResult(text: string, isError: boolean): ToolResult {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

/** 只认「非数组的对象」；⚠️ `null` 与数组都不算 —— 它们的键取出来全是 `undefined` */
function asParamsObject(params: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return null;
  }
  return params as Readonly<Record<string, unknown>>;
}

function negotiate(protocolVersion: unknown): string {
  const found = SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === protocolVersion);
  return found ?? LATEST_PROTOCOL_VERSION;
}

/** `tools/list` 的一项；⚠️ 刻意不含 `handler` —— 它是本地的闭包，序列化出去只会变成 `[Function]` */
interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

function listTools(tools: ReadonlyMap<string, ToolDefinition>): { tools: ListedTool[] } {
  return {
    tools: [...tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

async function callTool(
  tools: ReadonlyMap<string, ToolDefinition>,
  id: JsonRpcId,
  params: unknown,
): Promise<JsonRpcResponse> {
  const argsHolder = asParamsObject(params);
  if (argsHolder === null) {
    return fail(id, JSON_RPC_ERROR_CODE.INVALID_PARAMS, "params 必须是对象");
  }
  const name = argsHolder["name"];
  if (typeof name !== "string" || name === "") {
    return fail(id, JSON_RPC_ERROR_CODE.INVALID_PARAMS, "缺少 params.name");
  }
  const rawArgs = argsHolder["arguments"];
  if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs))) {
    return fail(id, JSON_RPC_ERROR_CODE.INVALID_PARAMS, "params.arguments 必须是对象");
  }
  const tool = tools.get(name);
  if (tool === undefined) {
    return fail(id, JSON_RPC_ERROR_CODE.INVALID_PARAMS, `未知工具：${name}`);
  }
  const args = (rawArgs ?? {}) as Readonly<Record<string, unknown>>;
  try {
    return ok(id, textResult(await tool.handler(args), false));
  } catch (err) {
    return ok(id, textResult(asMcpError(err).toReport(), true));
  }
}

/**
 * 分发一条已判合法的请求
 * @returns 该回的响应；通知（无 `id`）⇒ `null`
 */
export async function dispatch(
  request: JsonRpcRequest,
  tools: ReadonlyMap<string, ToolDefinition>,
): Promise<JsonRpcResponse | null> {
  const id: JsonRpcId = request.id ?? null;

  let response: JsonRpcResponse | null;
  switch (request.method) {
    case "initialize": {
      const params = asParamsObject(request.params);
      response = ok(id, {
        protocolVersion: negotiate(params?.["protocolVersion"]),
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      break;
    }
    case "tools/list":
      response = ok(id, listTools(tools));
      break;
    case "tools/call":
      response = await callTool(tools, id, request.params);
      break;
    case "ping":
      response = ok(id, {});
      break;
    case "notifications/initialized":
      return null;
    default:
      response = fail(id, JSON_RPC_ERROR_CODE.METHOD_NOT_FOUND, `未知方法：${request.method}`);
  }

  // ⚠️ 闸门只设在这一处：**任何**无 `id` 的消息都不回响应，包括那几个「本来就有结果」的方法。
  // 把这条判据写进每个 case 会漏掉一个分支，而漏掉的形态是「客户端收到一条它没要过的应答」。
  return request.id === undefined ? null : response;
}

/** 一行文本 ⇒ 零或一条响应；⚠️ `null` 的两种来源分别是「通知」与「坏到连 id 都读不出」 */
export async function handleLine(line: string, tools: ReadonlyMap<string, ToolDefinition>): Promise<JsonRpcResponse | null> {
  const trimmed = line.trim();
  if (trimmed === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return fail(null, JSON_RPC_ERROR_CODE.PARSE_ERROR, "不是合法的 JSON");
  }
  const request = asJsonRpcRequest(parsed);
  if (request === null) {
    return fail(idOf(parsed), JSON_RPC_ERROR_CODE.INVALID_REQUEST, "不是合法的 JSON-RPC Request");
  }
  try {
    return await dispatch(request, tools);
  } catch (err) {
    const id = idOf(parsed);
    if (request.id === undefined) {
      return null;
    }
    return fail(id, JSON_RPC_ERROR_CODE.INTERNAL_ERROR, asMcpError(err).toReport());
  }
}

function writeLine(stdout: Writable, message: JsonRpcResponse): void {
  stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * 起一个 stdio server
 * @description ⚠️ **逐行**读：`data` 事件的边界与行的边界毫无关系 ——
 * 一个事件里可能塞着好几行，一行也可能被拆到好几个事件（TCP/管道分片、写入方分次 flush）。
 * 所以这里维护一份 leftover，只在见到 `\n` 时才切出去；stdin 结束时 leftover 仍非空就是最后一行没带换行。
 */
export function serveStdio(streams: StdioStreams, tools: readonly ToolDefinition[]): Promise<void> {
  return serveIndexed(streams, indexTools(tools));
}

/** 工具表已经建好的那档；⚠️ 重名在**同步**阶段就判掉，于是 `runStdioServer` 的重名失败不是一条 rejected promise 而是当场抛 */
function serveIndexed(streams: StdioStreams, indexed: ReadonlyMap<string, ToolDefinition>): Promise<void> {
  let leftover = "";
  let queue: Promise<void> = Promise.resolve();

  const submit = (line: string): void => {
    queue = queue.then(async () => {
      const response = await handleLine(line, indexed);
      if (response !== null) {
        writeLine(streams.stdout, response);
      }
    });
  };

  const onData = (chunk: string | Buffer): void => {
    leftover += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (;;) {
      const cut = leftover.indexOf("\n");
      if (cut === -1) {
        break;
      }
      const line = leftover.slice(0, cut);
      leftover = leftover.slice(cut + 1);
      submit(line);
    }
  };

  streams.stdin.setEncoding("utf8");
  streams.stdin.on("data", onData);
  return new Promise<void>((resolve, reject) => {
    streams.stdin.once("end", () => {
      const tail = leftover;
      leftover = "";
      submit(tail);
      void queue.then(resolve, reject);
    });
    streams.stdin.once("error", reject);
  });
}

/**
 * 跑 stdio server（绑定进程的标准流）
 * @description ⚠️ 唯一的进程级入口。重复的工具名会在挂监听**之前**抛 ——
 * 那时还没有往 stdout 写过任何东西，对外表现为「启动失败」而不是「半个可用的 server」。
 */
export function runStdioServer(tools: readonly ToolDefinition[]): Promise<void> {
  return serveIndexed({ stdin: process.stdin, stdout: process.stdout }, indexTools(tools));
}