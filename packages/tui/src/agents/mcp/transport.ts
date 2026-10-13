/**
 * @fileoverview 传输那一层：把「一台怎么连」那份配置翻译成 `@ai-sdk/mcp` 认的 transport
 * @module agents/mcp/transport
 * @description
 * ⚠️ **配置三档、SDK 两条路**：那份 `MCPTransportConfig` 只有 `sse` / `http` 两档且**没有导出**，stdio 走
 *   另一个入口（`@ai-sdk/mcp/mcp-stdio`）。分叉点只有 {@link buildTransport} 一处，别在别处再写一遍。
 * ⚠️ **stdio 的 `stderr` 在这里写死成 `"pipe"`**：缺省 `inherit` 会把 Ink 画面冲花；而 `StdioConfig` 上那个
 *   `Stream` 分支在 `spawn` 那里根本用不了（Node 的 stdio 只认「字符串 / fd 数字 / 挂着数字 fd 的流」），
 *   所以只剩 `'pipe'` 一个能写的值。写死之后它就不再是配置能决定的事，表里也不给留这一列。
 */

import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { McpConnectionConfig } from "@/db/dto/mcp.js";

/** stdio 那一支的连接配置（`isStdio` 收窄后拿到的形状） */
export type StdioConnectionConfig = Extract<McpConnectionConfig, { transport: "stdio" }>;

/**
 * 远程那两档的传输配置（`http` / `sse`）；本地照 SDK 内部那份的形状声明（它没导出）。
 * @description 它是**结构类型**：SDK 那边改了形状（多一个必填字段之类）会在 `createMCPClient` 那一行
 *   编译期报出来，不会悄悄跑歪。
 */
export interface RemoteTransportConfig {
  type: "sse" | "http";
  /** MCP 端点 */
  url: string;
  /** 随请求发的 HTTP 头；不给 = 一个都不加 */
  headers?: Record<string, string>;
}

/** SDK 认的传输：stdio 那一档是一个类实例，另两档就是一份配置对象 */
export type McpTransport = Experimental_StdioMCPTransport | RemoteTransportConfig;

/** 这一份配置是不是本地子进程那一档（决定要不要探 stderr —— 远程没有子进程） */
export function isStdio(config: McpConnectionConfig): config is StdioConnectionConfig {
  return config.transport === "stdio";
}

/**
 * 一台怎么连（`mcps` 那一行解析出来的）→ SDK 认的 transport。
 * @description ⚠️ `args` / `env` / `headers` **各拷一份**：传进来的是从库里那一行解析出来的纯数据，
 *   别让 transport 拿到能改它的引用。⚠️ 远程那两档**原样交出去**（`type` + `url` + `headers` 本来就是 SDK
 *   自己吃的），SDK 会在 `initialize` 时自己造传输类 ⇒ 本层不 new 任何东西。
 */
export function buildTransport(config: McpConnectionConfig): McpTransport {
  if (!isStdio(config)) {
    // ⚠️ 键名要翻：库里存的是 `transport`，SDK 那份叫 `type`
    const remote: RemoteTransportConfig = { type: config.transport, url: config.url };
    return config.headers === undefined ? remote : { ...remote, headers: { ...config.headers } };
  }
  return new Experimental_StdioMCPTransport({
    command: config.command,
    args: [...config.args],
    ...(config.env === undefined ? {} : { env: { ...config.env } }),
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    stderr: "pipe",
  });
}