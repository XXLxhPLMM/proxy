/**
 * @fileoverview `mcps` 表的行，以及「一台 MCP 服务器怎么连」的那份形状
 * @module db/dto/mcp
 * @description
 * 两样东西住这一个文件，因为它们是同一句话的两半：
 * - **行**（`Mcp` / `NewMcp` / `McpPatch`）：由 drizzle 按表结构推断，不是手写契约；
 * - **连接配置**（{@link McpConnectionConfig} / {@link ResolvedMcp}）：`@/agents/mcp/connection.ts`
 *   拿去造 `createMCPClient({ transport })` 的那一份，与 `@ai-sdk/mcp` 的两个传输配置逐字段对得上。
 *
 * ⚠️ **这一圈的唯一真值是表**，不再有 `agents.mcpServers` 那份配置文件（两处都写就会出两份真值）。
 *   行 → 连接配置的那一步在 `@/db/read.ts` 的 `mcpConfigFromRow`（行映射与坏内容闸的住处）。
 *
 * ⚠️ **OAuth 不在这里**：`@ai-sdk/mcp` 的 `MCPTransportConfig.authProvider` 是**带方法的对象**
 *   （浏览器回调 + PKCE 校验器 + token 存取），一行文本装不下，而 TUI 也没有浏览器承接那个回调。
 *   远程服务器的凭据走 {@link McpConnectionConfig} 远程那一支的 `headers`
 *   （`Authorization: Bearer …` / 自定义 API key 都算它）。
 *
 * ⚠️ **下面那个 `import type` 只擦除不建边**：`schemas/mcps.ts` 从这里**值**引 `MCP_TRANSPORTS`，
 *   所以运行期模块图不成环（类型上的环是合法的，且与 `dto/session.ts` 不引 schemas 的做法同源，
 *   差别只在这份的行类型得跟着表结构走）。
 */

import type { McpRow } from "@/db/sqlite/schemas/mcps.js";

/**
 * 传输档位闭合集：本地子进程 / 远程 streamable HTTP / 远程 SSE。
 * @description 后两个就是 `@ai-sdk/mcp` 的 `MCPTransportConfig.type` 的全部取值（它那边没有 stdio，
 *   本地那档走 `@ai-sdk/mcp/mcp-stdio` 的 `Experimental_StdioMCPTransport`）⇒ 这里三档、那边两条路，
 *   造 transport 时按本列分叉，一处不多一处不少。
 */
export const MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;

/** 传输档位之一；与 {@link MCP_TRANSPORTS} 同源，故不可能漂 */
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/**
 * `mcps` 表的行：`id` / `transport` / `disabled` / `command` / `args` / `env` / `cwd` / `url` /
 * `headers` / `startupTimeoutMs` / `createdAt` / `updatedAt`。由 drizzle 按表结构推断。
 */
export type Mcp = McpRow;

/**
 * 建一台服务器的草稿：除 `updatedAt` 外全字段；`updatedAt` 由写入层从 `createdAt` 填充，
 * 不劳动调用方填两遍（与 `NewProvider` 同一手）。
 */
export type NewMcp = Omit<Mcp, "updatedAt">;

/** {@link McpDraft} 里那些「可缺省」的列：六个可空列 + `args` / `disabled` 两个带列缺省的 + `createdAt` */
type McpDraftOmitted = keyof Omit<Mcp, "id" | "transport" | "updatedAt">;

/**
 * 建一台的**草稿**：只有 `id` 与 `transport` 必填，其余都可缺省。
 * @description ⚠️ 缺省的那几格由 `McpsService.create` 化成「与驱动写下的那一行同形」（可空列补 `NULL`，
 *   `args` 补 `'[]'`、`disabled` 补 `false`）——不化成同形，形状闸跑的就不是库里那一行。
 * ⚠️ 那一格可缺省**是必须的**：形状按 `transport` 分支，远程那台本来就不该有 `command`，
 *   要调用方先手填一串 `null` 才建得出来，只会把它们逼去猜哪几格该填 `null`。
 * @description ⚠️ `createdAt` 在这份草稿里可缺省，但 `McpsService.create` **要求它给**：`dao/` 与
 *   `service/` 都不读时钟（见 `db/dao/models.js`「`createdAt` 由调用方给」），它由最靠近写入的那一层给
 *   （`ctx.mcp` 填 `Date.now()`）。
 */
export type McpDraft = Omit<NewMcp, McpDraftOmitted> & Partial<Pick<NewMcp, McpDraftOmitted>>;

/**
 * 改一台服务器的入参：除 `id` / `createdAt` 外都可缺省（不动那一格），`updatedAt` 由调用方给。
 * ⚠️ `disabled` 也在其中：它是**持久化的意图**（启动时按它跳过），不是运行期的实况——
 *   实况是 `starter/plugins/mcp/table.ts` 里那个 `state`，两者不互相覆盖。
 */
export type McpPatch = Pick<
  Partial<Mcp>,
  "transport" | "disabled" | "command" | "args" | "env" | "cwd" | "url" | "headers" | "startupTimeoutMs"
> & {
  updatedAt: number;
};

/** 一堆「名字 → 字符串」的附加项（子进程的 `env`、远程的 `headers`） */
export type McpStringMap = Readonly<Record<string, string>>;

/**
 * 一台 MCP 服务器怎么连：stdio 那一支对应 `@ai-sdk/mcp/mcp-stdio` 的 `StdioConfig`，
 * 远程那一支对应 `@ai-sdk/mcp` 的 `MCPTransportConfig`。
 * @description ⚠️ **两支都少了东西，那是有意的**：
 * - stdio 少了 `stderr` —— 它必须写死 `'pipe'`（`@ai-sdk/mcp` 那个 `Stream` 分支在 `spawn` 处会被拒，
 *   而缺省的 `'inherit'` 会把 Ink 画面冲花），由 `connection.ts` 自己按，不该由数据决定；
 * - 远程少了 `authProvider`（见文件头 OAuth 那条）、`initialSessionId` / `onSessionIdChange` /
 *   `terminateSessionOnClose` 这些**会话续接**的旋钮 —— 那是「重连上一次会话」的能力，
 *   与「这台怎么配」无关，且要跨行保存会话状态。
 */
export type McpConnectionConfig =
  | {
      readonly transport: "stdio";
      /** 可执行文件名或路径；⚠️ **只给程序名**，参数一律进 {@link McpConnectionConfig.args} */
      readonly command: string;
      readonly args: readonly string[];
      /**
       * 额外给子进程的环境变量；**不给（`undefined`）= 继承 `@ai-sdk/mcp` 那份白名单**，
       * 给 `{}` 则是「一样都不额外给」—— 两种行为不同，所以这一格必须能缺席。
       */
      readonly env?: McpStringMap;
      /** 工作目录；不给 = 本进程当前目录 */
      readonly cwd?: string;
    }
  | {
      readonly transport: "http" | "sse";
      /** MCP 端点（streamable HTTP 走 `http`，SSE 走 `sse`） */
      readonly url: string;
      /** 随请求发的 HTTP 头（凭据也在这一格，见文件头 OAuth 那条）；不给 = 一个都不加 */
      readonly headers?: McpStringMap;
    };

/**
 * 一行解析出来的「怎么起这台」：连接配置本体 + **这台自己**的启动时限。
 * @description 时限单独一只是因为它在两边都是个**选项**：`undefined` 就是让
 *   `connection.ts` 用它自己的缺省（30s），写进配置里等于把缺省抄了一遍。
 */
export interface ResolvedMcp {
  readonly config: McpConnectionConfig;
  /** 起它要等多久（毫秒）；`undefined` = 用 `connection.ts` 的缺省 */
  readonly startupTimeoutMs?: number;
}