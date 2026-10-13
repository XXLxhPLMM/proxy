/**
 * @fileoverview MCP 插件：装配 `ctx.mcp`（那张表 + 列表 / 注册 / 重启 / 重载），工具经 `ctx.tools` 登记
 * @module starter/plugins/mcp
 * @description
 * 本文件是这一圈能力的**组合根**：类型、服务面、装载与卸载。
 * 真干活的都在旁边——`table.ts` 是那张表与五个动作（`agents/mcp/reload.ts` 是其中重载那步的**纯判定**），
 * `@/agents/mcp/` 是「一台」的机制（连上 + 登记 + 收）。⚠️ **状态只住在 `table.ts` 一处**，
 * 这几层共享状态就会出两份真值。
 *
 * ## 事件（动手前后各一条，形状见 `@/starter/index.js`）
 * - `mcp.reload.start` / `.finish`：重载的前后。⚠️ **没有 `failed`**——重载里某台起不来不抛
 *   （那是降级，见 `table.ts` 文件头），没有「会抛的」就不补 `failed`。
 * - 服务器起落的细节**不另发事件**：谁起来了、哪条工具到了，UI 从已有的
 *   `tools.register.*` / `tools.unregister.*` 与 `ctx.mcp.list()` 就拿得到，别再发一套平行的。
 *
 * ⚠️ **服务器名是同一个命名空间**：配置文件里写的与运行期 `register` 进的共用一把尺子
 *   （`agents/mcp/naming.ts` 的 `isValidServerName`），因为两者最后都变成同一批
 *   `mcp__<服务器名>__<工具>` 工具键。撞名即冲突 ⇒ `register` **当场拒绝**，不覆盖配置。
 *
 * ⚠️ **起不来是降级、不是失败**（与 `dbPlugin` 那道闸门不同类）：闸门挡的是「状态坏了」，
 *   而这里坏掉的只是一份外部能力 ⇒ 记一条 `warn`、进 `list()` 的 `failed`、**其余照常**。
 *   会让**启动**失败的只有「配置本身坏了」，而那在 `config/agents/parse.ts` 就抛了，压根到不了这里。
 *
 * ⚠️ **`reload()` 不重读配置文件**：它按**当前生效**的配置表重建 MCP 那一圈
 *   （规则逐条见 `reload.ts` 文件头）。要连文件一起重读，用户自己先 `ctx.cfg.reload()` 再 `ctx.mcp.reload()`。
 *
 * ⚠️ **注入的是 `cfg` + `tools` 两样**：配置给启动参数，`tools` 给登记口。
 *   不注入 `db`——MCP 服务器与本地库无关，多挂一道闸门只是让这条路径多一个能卡住的地方。
 */

import type { Context } from "cordis";
import type { McpServerConfig } from "@/config/agents/defaults.js";
import { McpTable } from "./table.js";

declare module "cordis" {
  interface Context {
    /** MCP 服务器表与对它的四个动作（由 `mcpPlugin` 提供） */
    mcp: McpService;
  }
  interface Events {
    /** 重载之前：此刻各表还是旧的 */
    "mcp.reload.start"(): void;
    /** 重载完了；⚠️ **没有 `failed`**：重载里某台起不来是降级（记 warn），不是这次重载失败 */
    "mcp.reload.finish"(): void;
  }
}

/** 一台服务器此刻的状态 */
export type McpServerState = "starting" | "connected" | "failed";

/** `ctx.mcp.list()` 交出的一行 */
export interface McpServerStatus {
  /** 服务器名（工具名 `mcp__<它>__<工具>` 里那一段） */
  readonly name: string;
  /** 这台的配置是哪来的 */
  readonly source: "config" | "runtime";
  /** 现在什么状态 */
  readonly state: McpServerState;
  /** 它自报的名字与版本；`failed` 时为空 */
  readonly serverInfo: string;
  /** 已登记的工具键（含 `mcp__` 前缀）；`failed` 时为空 */
  readonly tools: readonly string[];
  /** 登记不上的工具**它自己的名字**；空 = 全上来了 */
  readonly skipped: readonly string[];
  /** 为什么没接上（`failed` 才有，消息里带子进程 stderr 尾巴） */
  readonly error?: string;
}

/**
 * MCP 服务面：那张表，以及围绕它的五个动作。
 * ⚠️ **没有「启动」这一项**——按配置起一遍是**装载期**的事，装载完就归 `list()` 管，
 *   不再是调用方要发起的动作。
 * ⚠️ 全部动作**一律排队**（见 `table.ts` 的 {@link McpTable}）：并发调用不会交错，
 *   代价是第二个调用要等第一个起落完（可能几十秒）——这是对的，因为交错的后果是泄漏。
 */
export interface McpService {
  /** 现在表里有哪些（按名字排；每次都一样，见 `table.ts` 里为什么不是插入序） */
  list(): readonly McpServerStatus[];
  /** 取一行的状态；没有这台给 `undefined` */
  get(name: string): McpServerStatus | undefined;
  /**
   * 运行期加一台并起它。
   * @returns 退订函数：调它关掉并移除这台（⚠️ **认名字不认人**：同名已被别人重新注册过时它什么也不做）
   * @throws（**拒绝**，不是同步抛）名字不合法 / **同名已经在了**——⚠️ 后者是**当场拒**，不是「覆盖」：
   *   配置里那台是用户写的，默默被顶掉比报个错难查得多。要顶就 `unregister` 完再 `register`。
   */
  register(name: string, config: McpServerConfig): Promise<() => void>;
  /** 关掉并移除一台；没有这台就什么也不做（幂等，不抛）。⚠️ 移除的是**配置里的**那台时要记住：下次 `reload()` 它会回来 */
  unregister(name: string): Promise<void>;
  /**
   * 重启一台：关掉旧会话、按**当前这份配置**重新起。
   * @returns `false` = 表里没这台（什么也没做）；`true` = 已经重新起过一遍（**起没起来看 `list()`**，
   *   起不来不抛，见文件头「起不来是降级」）
   */
  restart(name: string): Promise<boolean>;
  /** 全量重载：按**当前生效**的配置表重建（规则见 `reload.ts` 文件头） */
  reload(): Promise<void>;
}

/** 装配 MCP：提供 `ctx.mcp`，装载即按配置起一遍，卸载即全部收掉 */
export function mcpPlugin(ctx: Context): void {
  const table = new McpTable(ctx);
  // ⚠️ **装载期就 provide**：MCP 是非阻塞接进来的（见下面的 effect），别的插件 `inject: ["mcp"]`
  //   等的是这个服务，不是「工具都登记完了」——后者不可能有信号，工具是逐台陆续到的。
  ctx.provide("mcp", table);

  // ⚠️ **不 `await` 这个 effect**：Cordis 的装载不等 async effect，所以 MCP 是**非阻塞**接进来的，
  //   启动不等第三方 `npx`（实测 `await ctx.plugin()` 刚返回时工具数 = 0）。
  //   工具到了由 `tools.register.*` 事件通知 UI。
  ctx.effect(async () => {
    await table.loadConfigured();
    return () => table.dispose();
  });
}

// ⚠️ 两样都是硬前置：`cfg` 决定起什么，`tools` 是登记口。少注一样就装不上，而不是「装上了但登记不了」
mcpPlugin.inject = ["cfg", "tools"];

// ⚠️ 本目录**对外只留这一个出口**。`table.ts` / `reload.ts` 的类型不转出：它们是实现细节，
//   外面要问状态就问 `McpService`，要动手就问 `ctx.mcp`。
export type { McpReloadPlan, McpReloadTarget } from "./reload.js";