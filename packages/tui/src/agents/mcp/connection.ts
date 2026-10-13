/**
 * @fileoverview 连一台 MCP 服务器：按配置造传输、走 `initialize` 往返、拿回它给的工具
 * @module agents/mcp/connection
 * @description
 * ⚠️ **本地子进程那一档的「子线程」是子进程，不是 worker thread**：stdio 传输的 JSON-RPC 走子进程的
 *   stdin / stdout，那两根管道在进程边界上，`worker_threads` 接不了这一层。起进程是 SDK 的
 *   `Experimental_StdioMCPTransport` 干的，本模块负责按住它的危险缺省值（`transport.ts`）、把 stderr 抢过来
 *   （`stderr.ts`）、外加把「起没起来」说清楚。
 * ⚠️ **启动必须有时间闸**（两道，见下）：本模块跑在启动路径上（`manager.ts` 的对表），第三方服务器不回
 *   （`npx` 卡在下载、写错了协议版本、服务器自己死锁）时没有闸就是**无限期挂着，整个 TUI 起不来**。
 * ⚠️ **远程那两档没有子进程**：stderr 那一圈整个不参与（`transport.ts` 交出去的是一份配置对象，SDK 自己造
 *   传输），所以本模块的 stderr 分支全在 `isStdio` 后面。
 */

import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { Context } from "cordis";
import type { McpConnectionConfig } from "@/db/dto/mcp.js";
import { failStartup, stderrTail, watchForStderr, withStderr } from "./stderr.js";
import { buildTransport, isStdio } from "./transport.js";

/** 交给 MCP 服务器的客户端身份；版本取构建期注入的 `APP_VERSION` */
const CLIENT_NAME = "proxy-tui";

/** 起一台服务器的默认时限（毫秒）；够慢的 `npx` 首次下载也该在这之内，再慢就该由用户自己去修服务器 */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

/** 它给的工具集的形状：⚠️ `@ai-sdk/mcp` **没有导出** `McpToolSet` 这个名字，只能从 `tools()` 的返回处取 */
export type McpToolSet = Awaited<ReturnType<MCPClient["tools"]>>;

/** 连好的一台服务器：`tools` 是它给的工具集（键即**它那边**的工具名，还没加前缀） */
export interface McpConnection {
  /** 服务器名（`mcps.id`，进日志前缀与工具名） */
  readonly server: string;
  /**
   * 它在 `initialize` 握手里自报的名字与版本（如 `filesystem 1.0.6`）。
   * @description ⚠️ 它**未必**等于 {@link McpConnection.server} —— 我们配的是「怎么起它」，自报的是「它自认为
   *   是谁」。两者对不上通常意味着 `command` / `args` 指向了另一台服务器，所以它得能被人看见。
   */
  readonly serverInfo: string;
  /** 它给的工具集；交给 `./session-tools.js` 拼名后登记 */
  readonly tools: McpToolSet;
  /** 关掉：断连接并**终止子进程**（stdio 那一档） */
  close(): Promise<void>;
}

/** 连一台服务器时的选择 */
export interface ConnectMcpOptions {
  /** 起它要等多久（毫秒），默认 {@link DEFAULT_STARTUP_TIMEOUT_MS}；超了按「这台起不来」处理，不拖累别的服务器 */
  readonly startupTimeoutMs?: number;
}

/**
 * 起一台 MCP 服务器并取回它的工具（三档传输共用这一个入口）。
 * @throws 起不来 / 起超时 / 应答不对：抛出的错里带着 stderr 尾巴（远程那两档没有子进程 ⇒ 只是前缀），
 *   别让人对着一句 `spawn npx ENOENT` 猜到底是没装还是写错了。
 * @description ⚠️ 抛了就等于**这台没接上**，但它已经起的那个子进程会被收掉，不留孤儿（收不掉也不抛 ——
 *   已经在错误路径上，再叠一个错只会盖掉真正的错）。
 */
export async function connectMcpServer(
  ctx: Context,
  server: string,
  config: McpConnectionConfig,
  options: ConnectMcpOptions = {},
): Promise<McpConnection> {
  const timeout = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  // ⚠️ 远程那两档没有子进程 ⇒ 压根不造 stderr 收集口（`stderr.ts` 那一整圈都是子进程的）
  const stderr = isStdio(config) ? stderrTail(ctx, server) : undefined;
  const tail = (): string => stderr?.tail() ?? "";
  let client: MCPClient | undefined;
  try {
    const transport = buildTransport(config);
    // ⚠️ **必须在 `createMCPClient` 之前就开始探 stderr**：Windows 上 cross-spawn 把「命令不存在」包成
    //   `cmd.exe /c <那串>`，而 cmd.exe 是**存在**的 ⇒ spawn 成功、子进程秒退。真正有用的那句「不是内部或外部
    //   命令」就在它的 stderr 里，等 `createMCPClient` 抛错再接就晚了：写端一关，管道里那点数据**已经被丢掉**，
    //   剩下的只有一句毫无信息量的 `Attempted to send a request from a closed client`。
    const stopWatching = stderr === undefined ? undefined : watchForStderr(transport, stderr);
    try {
      client = await createMCPClient({
        transport,
        clientName: CLIENT_NAME,
        version: process.env.APP_VERSION ?? "0.0.0",
        initializationOptions: { timeout, maxTotalTimeout: timeout },
      });
    } finally {
      stopWatching?.();
    }
    // ⚠️ 够不到 stderr 就**把这台关掉**，别留一条没人读的管道（缓冲区一满，子进程会卡死在写 stderr 上）
    if (stderr !== undefined && !stderr.attached) {
      await client.close().catch(() => undefined);
      throw withStderr(
        server,
        new Error(
          "拿不到子进程的 stderr（@ai-sdk/mcp 的 transport 没给出这条路），已关掉这台服务器——" +
            "留着一条没人读的管道，它写满缓冲区后会自己卡死",
        ),
        "",
      );
    }
    // ⚠️ `tools()`（内部是 `tools/list`）**不接受** `RequestOptions`，SDK 没给这条路上闸 ⇒ 自己赛一个。
    //   服务器 initialize 应答正常却在 tools/list 上装死，是真实存在的一种坏法。
    const tools = await withTimeout(client.tools(), timeout, () =>
      failStartup(server, `列工具超过 ${timeout}ms 没应答`, tail()),
    );
    const { name, version } = client.serverInfo;
    return { server, serverInfo: `${name} ${version}`.trim(), tools, close: () => client?.close() ?? Promise.resolve() };
  } catch (error) {
    // ⚠️ 失败路径上先把子进程收了：抛出去之后没人再管它，不收就是一个跑到退出为止的孤儿进程
    await client?.close().catch(() => undefined);
    throw withStderr(server, error, tail());
  }
}

/**
 * 给一个没有自行了断的 promise 补时限。
 * @description 只**让我们这一侧**不再等它；那个 promise 仍会在它自己的时间里收场（成功或抛），这里不再去管它。
 */
async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}