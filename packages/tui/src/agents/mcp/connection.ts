/**
 * @fileoverview 连一台 MCP 服务器：把命令起成子进程，走 stdio 上的 JSON-RPC，拿回它给的工具
 * @module agents/mcp/connection
 * @description
 * ⚠️ **「子线程」在这里是子进程，不是 worker thread**：stdio 传输的 JSON-RPC 走的是子进程的
 *   stdin / stdout，那两根管道在进程边界上，`worker_threads` 接不了这一层。起进程这件事是
 *   `@ai-sdk/mcp` 的 `Experimental_StdioMCPTransport` 干的，本模块负责**把它的三个危险缺省值按住**，
 *   外加把「起没起来」这件事说清楚。
 *
 * ⚠️ **一、stderr 必须 `pipe`，缺省的 `inherit` 对 Ink 界面是灾难**：子进程往终端直接写会把画面
 *   冲花（且冲完不会自己重画）。但光 `pipe` 还不够——第三条才是真咬人的那条。
 *
 * ⚠️ **二、启动必须有时间闸**：`createMCPClient` 等的是第三方子进程的 `initialize` 应答，
 *   而本模块跑在启动路径上（插件的 effect）。第三方服务器不回（`npx` 卡在下载、写错了协议版本、
 *   服务器自己死锁）时没有闸就是**无限期挂着，整个 TUI 起不来**。
 *
 * ⚠️ **三、`@ai-sdk/mcp` 没有把子进程的 stderr 交出来的口**（判据见文件尾 {@link childStderr}）：
 *   `StdioConfig.stderr` 的类型写着 `IOType | Stream | number`，但那个 `Stream` 在
 *   `child_process.spawn` 那里**根本用不了**——Node 的 stdio 只认「字符串 / fd 数字 / 挂着数字 fd 的
 *   流」，光秃秃一个 `new Writable()`（没有 fd）会被 `spawn` 当场拒成 `ERR_INVALID_ARG_VALUE`。
 *   真正能用的只剩 `'inherit' | 'ignore' | 'pipe' | <fd>`，而 `'pipe'` 造出来的那条流这个 transport
 *   **既不返回也不暴露**。
 *   ⚠️ 所以**一条没人读的 `pipe` 比 `inherit` 更糟**：管道缓冲区写满后子进程会**卡在写 stderr 上**
 *   （`npx` 的装包日志足以撑爆它），整台服务器就此僵住。故 {@link childStderr} 够不到时，
 *   本模块**把这台关掉并记下原因**——宁可少一台服务器，也不要留一个会自己卡死的。
 */

import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { Context } from "cordis";
import type { McpServerConfig } from "@/config/agents/defaults.js";

/** 交给 MCP 服务器的客户端身份；版本取构建期注入的 `APP_VERSION` */
const CLIENT_NAME = "proxy-tui";

/** 起一台服务器的默认时限（毫秒）；够慢的 `npx` 首次下载也该在这之内，再慢就该由用户自己去修服务器 */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

/** 失败那条 `warn` 里带回的 stderr 行数上限；再多就是噪声，不是线索 */
const STDERR_TAIL_LINES = 20;

/** 单行 stderr 的保留上限：一个不换行的服务器不该把我们（和日志）的内存吃光 */
const STDERR_MAX_LINE = 4096;

/** 探子进程有没有出来的间隔（毫秒）；够密，才能抢在「秒退」的前面（见 `watchForStderr`） */
const STDERR_POLL_MS = 1;

/** 它给的工具集的形状：⚠️ `@ai-sdk/mcp` **没有导出** `McpToolSet` 这个名字，只能从 `tools()` 的返回处取 */
export type McpToolSet = Awaited<ReturnType<MCPClient["tools"]>>;

/** 连好的一台服务器：`tools` 是它给的工具集（键即**它那边**的工具名，还没加前缀） */
export interface McpConnection {
  /** 配置里的服务器名（`agents.mcpServers` 的键） */
  readonly server: string;
  /**
   * 它在 `initialize` 握手里自报的名字与版本（如 `filesystem 1.0.6`）。
   * @description ⚠️ 它**未必**等于配置里的 {@link McpConnection.server} —— 配置写的是「怎么起它」，
   *   自报的是「它自认为是谁」。两者对不上通常意味着 `command` / `args` 指向了另一台服务器
   *   （改过配置没重启、或包名换了），所以它得能被人看见。
   */
  readonly serverInfo: string;
  /** 它给的工具集；交给 `@/agents/mcp/loader.js` 拼名后登记 */
  readonly tools: McpToolSet;
  /** 关掉：断连接并**终止子进程**（见本模块文件头 ⚠️ 三） */
  close(): Promise<void>;
}

/** 连一台服务器时的选择 */
export interface ConnectMcpOptions {
  /** 起它要等多久（毫秒），默认 {@link DEFAULT_STARTUP_TIMEOUT_MS}；超了按「这台起不来」处理，不拖累别的服务器 */
  readonly startupTimeoutMs?: number;
}

/**
 * 起一台 MCP 服务器并取回它的工具。
 * @param ctx - 取 `ctx.logger` 记子进程的 stderr 与失败原因
 * @param server - 配置里的服务器名（进日志前缀与工具名）
 * @param config - 怎么起它（见 `McpServerConfig`）
 * @throws 起不来 / 起超时 / 应答不对：抛出的错里带着 stderr 尾巴，别让人对着一句
 *   `spawn npx ENOENT` 猜到底是没装还是写错了。
 * @description ⚠️ 抛了就等于**这台没接上**，但它已经起的那个子进程会被收掉，不留孤儿
 *   （收不掉也不抛 —— 已经在错误路径上，再叠一个错只会盖掉真正的错）。
 */
export async function connectMcpServer(
  ctx: Context,
  server: string,
  config: McpServerConfig,
  options: ConnectMcpOptions = {},
): Promise<McpConnection> {
  const timeout = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const stderr = stderrTail(ctx, server);
  let client: MCPClient | undefined;
  try {
    const transport = new Experimental_StdioMCPTransport({
      command: config.command,
      // ⚠️ 拷贝成新数组：`config` 是冻结的配置快照，别让 transport 拿到能改它的引用。
      args: [...config.args],
      cwd: config.cwd,
      ...(config.env === undefined ? {} : { env: { ...config.env } }),
      // ⚠️ 这个传输的缺省值是 `inherit`，对 Ink 界面是灾难（见文件头第一条）。
      //   只能写 `pipe`：`StdioConfig` 类型上那个 `Stream` 分支在 `spawn` 那里会被拒（见文件头第三条）。
      stderr: "pipe",
    });
    // ⚠️ **必须在 `createMCPClient` 之前就开始探 stderr**，不能等它返回再接：Windows 上
    //   cross-spawn 会把「命令不存在」包成 `cmd.exe /c <那串>`，而 cmd.exe 是**存在**的 ⇒
    //   spawn 成功、子进程秒退。真正有用的那句「'xxx' 不是内部或外部命令」就在它的 stderr 里，
    //   等 `createMCPClient` 抛错再接就晚了：写端一关，管道里那点数据**已经被丢掉**，
    //   剩下的只有一句毫无信息量的 `Attempted to send a request from a closed client`。
    const stopWatching = watchForStderr(transport, stderr);
    try {
      client = await createMCPClient({
        transport,
        clientName: CLIENT_NAME,
        version: process.env.APP_VERSION ?? "0.0.0",
        // ⚠️ 初始化那条请求的时间闸。
        initializationOptions: { timeout, maxTotalTimeout: timeout },
      });
    } finally {
      stopWatching();
    }
    // ⚠️ 够不到 stderr 就**把这台关掉**，别留一条没人读的管道（见文件头第三条）：缓冲区一满，
    //   子进程会卡死在写 stderr 上，整台服务器僵住。
    if (!stderr.attached) {
      await client.close().catch(() => undefined);
      throw new Error(
        "拿不到子进程的 stderr（@ai-sdk/mcp 的 transport 没给出这条路），已关掉这台服务器——" +
          "留着一条没人读的管道，它写满缓冲区后会自己卡死",
      );
    }
    // ⚠️ `tools()`（内部是 `tools/list`）**不接受** `RequestOptions`，SDK 没给这条路上闸 ⇒
    //   自己赛一个。服务器 initialize 应答正常却在 tools/list 上装死，是真实存在的一种坏法。
    const tools = await withTimeout(client.tools(), timeout, () =>
      failStartup(server, `列工具超过 ${timeout}ms 没应答`, stderr.tail()),
    );
    const { name, version } = client.serverInfo;
    return { server, serverInfo: `${name} ${version}`.trim(), tools, close: () => client?.close() ?? Promise.resolve() };
  } catch (error) {
    // ⚠️ 失败路径上先把子进程收了：抛出去之后没人再管它，不收就是一个跑到退出为止的孤儿进程。
    await client?.close().catch(() => undefined);
    throw withStderr(server, error, stderr.tail());
  }
}

/**
 * 子进程一被 spawn 出来就立刻把 stderr 接上；交回「停下来」。
 * @description ⚠️ 用 `setInterval` 探而不是等 `createMCPClient` 返回：没有「子进程 spawn 了」这个
 *   事件可以挂——`StdioMCPTransport` 把它吞在自己的 `start()` 里了，而我们要抢在它退出之前读到 stderr。
 *   探到就停，所以正常情况下只跑一两个 tick；最坏（服务器不回、`initialize` 挂满时限）会探到时限为止，
 *   每个 tick 只是一次属性读，代价可以忽略。
 */
function watchForStderr(transport: unknown, stderr: StderrTail): () => void {
  const timer = setInterval(() => {
    if (stderr.attached) {
      clearInterval(timer);
      return;
    }
    const stream = childStderr(transport);
    if (stream === undefined) return;
    stderr.attach(stream);
    clearInterval(timer);
  }, STDERR_POLL_MS);
  return () => clearInterval(timer);
}

/**
 * 从 transport 上够出子进程的 stderr 流；够不到给 `undefined`。
 * @description ⚠️ **这是一个未公开的实现细节**：`StdioMCPTransport` 把 spawn 出来的子进程存在
 *   `this.process` 上，而它的 `.d.ts` 里既没有这个字段、也没有官方给的取法（官方 SDK 的
 *   `StdioClientTransport` 是**公开** `.stderr` 的，这里没有）。所以：
 *   - 它**必须**在 `transport.start()` 之后才有东西可够 ⇒ 由 {@link watchForStderr} 反复探；
 *   - 它**够不到时不能装作没事**——调用方据此把这台服务器关掉（理由见文件头第三条）；
 *   - `@ai-sdk/mcp` 一旦改名或挪走这个字段，表现是「少了那些 stderr 日志 + 一台服务器被关掉
 *     并给出上面那句话」，**不是静默的坏行为**。这条退化路径是故意的，升级依赖时要重跑探针。
 */
function childStderr(transport: unknown): NodeJS.ReadableStream | undefined {
  const child = (transport as { process?: { stderr?: NodeJS.ReadableStream | null } } | undefined)?.process;
  return child?.stderr ?? undefined;
}

/** 「这台起不来」的错：统一形状，让 loader 那边的 `failed` 列表里每一条都读得懂 */
function failStartup(server: string, reason: string, tail: string): Error {
  return withStderr(server, new Error(reason), tail);
}

/**
 * 把 stderr 尾巴缀到错上。
 * ⚠️ **只在尾巴非空时**才改 message：本来错就说得清（`ENOENT` 之类）时再缀一段子进程的
 *   啰嗦输出只会让人多读一遍。原来的 message 留在最前面，不丢。
 */
function withStderr(server: string, error: unknown, tail: string): Error {
  const base = error instanceof Error ? error : new Error(String(error));
  const message = base.message;
  if (tail === "") return new Error(`MCP 服务器「${server}」：${message}`, { cause: base });
  return new Error(`MCP 服务器「${server}」：${message}\n—— 它的 stderr（末 ${STDERR_TAIL_LINES} 行）：\n${tail}`, {
    cause: base,
  });
}

/** 子进程的 stderr：一边逐行记日志，一边留尾巴给失败时用 */
/** 子进程的 stderr 收集口：接上一条流，之后随时能问「接上了没」「最后说了什么」 */
interface StderrTail {
  /** 挂上读它的监听（读，不关——关会让子进程下一次写直接 EPIPE） */
  attach(stream: NodeJS.ReadableStream): void;
  /** 接上了没有；`false` 表示 {@link childStderr} 够不到，调用方据此把这台服务器关掉 */
  readonly attached: boolean;
  /** 攒下的尾巴（空串 = 它还没说过话） */
  tail(): string;
}

/** 子进程的 stderr：一边逐行记日志，一边留尾巴给失败时用 */
function stderrTail(ctx: Context, server: string): StderrTail {
  const lines: string[] = [];
  let pending = "";
  const take = (line: string): void => {
    const text = line.trimEnd();
    if (text === "") return;
    lines.push(text);
    if (lines.length > STDERR_TAIL_LINES) lines.shift();
    // ⚠️ 记 `debug` 而不是 `warn`：这条通道上最常见的流量是 `npx` 的装包进度，
    //   按 warn 记会在启动时刷屏（而 `debug` 缺省不导出，平时一点不吵）。
    //   真要出事时看的是失败那条 `warn` 里带的尾巴，不是这里。
    ctx.logger.debug("[mcp:%s] %s", server, text);
  };
  let attached = false;
  return {
    attach: (stream) => {
      attached = true;
      // ⚠️ 挂了 `data` 监听就等于**持续读这条管道**，这正是我们要的：管道必须有人读，
      //   否则写满之后子进程会卡死（见文件头第三条）。想停只能靠 `close` 掐掉子进程。
      stream.on("data", (chunk: Buffer | string) => {
        pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        // ⚠️ 按行切后才谈得上「留最后 20 行」；半行拼不成一句能看的话。
        for (let at = pending.indexOf("\n"); at !== -1; at = pending.indexOf("\n")) {
          take(pending.slice(0, at));
          pending = pending.slice(at + 1);
        }
        // ⚠️ 迟迟不换行也要收口，否则 pending 会一路长下去。
        if (pending.length > STDERR_MAX_LINE) {
          take(pending.slice(-STDERR_MAX_LINE));
          pending = "";
        }
      });
      // ⚠️ 这条管道不是我们建的，关它会让子进程下一次写 stderr 直接 EPIPE ⇒ 只读不关，
      //   它的去留由「关子进程」决定（`McpConnection.close`）。
      stream.on("error", (error: Error) => ctx.logger.debug("[mcp:%s] stderr 流报错：%s", server, error.message));
    },
    get attached() {
      return attached;
    },
    tail: () => lines.join("\n"),
  };
}

/**
 * 给一个没有自行了断的 promise 补时限。
 * @description 只**让我们这一侧**不再等它；那个 promise 仍会在它自己的时间里收场（成功或抛）。
 *   这里不再去管它 —— 已经在这儿了，继续等就等于没加这道闸。
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