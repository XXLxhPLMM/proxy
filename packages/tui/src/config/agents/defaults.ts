/**
 * @fileoverview agents 一节的默认值：步数上限 `maxSteps`（与 AI SDK 的 `stopWhen: isStepCount(n)` 同一个数）与要起哪些 MCP 服务器 `mcpServers`
 * @module config/agents/defaults
 */

/** 一台 MCP 服务器怎么起（stdio 传输 = 一个本地子进程） */
export interface McpServerConfig {
  /**
   * 可执行文件名或路径。
   * ⚠️ **只给程序名，参数一律写进 {@link McpServerConfig.args}**：`shell: false`，所以
   *   `"npx -y @foo/bar"` 这种整行会被当成一个字面文件名去 spawn，报的是「文件不存在」，
   *   跟「命令写错了」长得完全不像。正确写法是 `command: "npx"` + `args: ["-y", "@foo/bar"]`。
   */
  readonly command: string;
  /** 传给它的参数，逐个给（见 {@link McpServerConfig.command} 那条） */
  readonly args: readonly string[];
  /**
   * 额外给它的环境变量（键值都是字符串）。
   * ⚠️ **不给的话它只继承一份白名单**（PATH / HOME / USERPROFILE 之类），本进程的其余环境变量
   *   ——包括控制面的 token——**不会**流到子进程。白名单名单见 `@ai-sdk/mcp` 的 `getEnvironment`。
   */
  readonly env?: Readonly<Record<string, string>>;
  /** 工作目录；省略就是本进程当前目录 */
  readonly cwd?: string;
}

/** agents 一节的形状 */
export interface AgentsConfig {
  /**
   * 一次调用里最多走几步（一个 step = 一次模型请求 + 它触发的工具执行）。
   * ⚠️ 这是**上限**不是配额：模型不再调工具时循环自然收尾，只有它停不下来（反复调同一个工具）才靠这里兜住。
   */
  readonly maxSteps: number;
  /**
   * 装载期要起起来的 MCP 服务器，**键即服务器名**（它会进工具名，形状见 `@/agents/mcp/naming.js`）。
   * ⚠️ 缺省一台都不起：MCP 服务器是外部依赖，凭空起几个没配过的进程不是本包该做的默认。
   */
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
}

/** agents 一节的默认值：20 步（与 AI SDK `ToolLoopAgent` 的默认 `stopWhen` 取同一个数，别让人以为这里在改什么）+ 不起任何 MCP 服务器 */
export function defaultAgentsConfig(): AgentsConfig {
  return { maxSteps: 20, mcpServers: {} };
}