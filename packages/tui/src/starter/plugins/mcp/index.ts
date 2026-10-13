/**
 * @fileoverview MCP 插件：把 `McpManager`（`@/agents/mcp/`）装成服务 `ctx.mcp`，装载即对 `mcps` 表起一遍
 * @module starter/plugins/mcp
 * @description
 * ⚠️ **本目录只剩装配**：声明服务与事件、`new McpManager`、provide、挂 effect。「一台」的机制与「一批」的
 *   管理（那张表、串行队列、对表、起落）都在 `@/agents/mcp/`，那里是这一圈状态的**唯一住处**——本目录再长出
 *   「实现」就意味着状态有了第二个住处。
 *
 * ## 事件（形状的规则见 `@/starter/index.js`）
 * - `mcp.server.start`（**动手之前**）：要动这一台了（起与关共用——UI 在这两种情况下都要先把那个名字标成忙）。
 * - `mcp.server.finish`：这一台落到某个状态了，载荷带那个状态。
 * - `mcp.reload.start` / `.finish`：全量对表的前后。
 * ⚠️ 这三条**都没有 `failed`**：起不来是**降级**（落 `failed` 状态 + 一条 `warn`），不是这次动作失败。
 * ⚠️ **不另发「某条工具到了」**：那已经在 `tools.register.*` / `tools.unregister.*` 上了，再发一套平行的就变成两处真值。
 * ⚠️ **数据那一半的事件由 `McpsService` 发**（`mcp.data.changed`，声明随它的发出者走，在
 *   `starter/plugins/services/`），本插件监听它，好让**绕过 `ctx.mcp` 直接写库**的那条路（UI 表单、日后的
 *   导入）也照样落到运行期上。⚠️ 装载时那次对表**不发**它：那不是谁请求的动作，是启动。
 *
 * ⚠️ **注入 `db` + `services` + `tools` 三样**：`db` 是闸门（表读不到就没什么可对），`services` 是表的唯一
 *   读写门面，`tools` 是登记口。⚠️ **不再注入 `cfg`**：这一圈的真值是本地库而不是配置文件。
 */

import type { Context } from "cordis";
import { McpManager, type McpChanges, type McpDraft, type McpServerState, type McpServerStatus } from "@/agents/mcp/index.js";

declare module "cordis" {
  interface Context {
    /** MCP 服务器的运行期那一圈 + 对 `mcps` 表的管理（由 `mcpPlugin` 提供） */
    mcp: McpService;
  }
  interface Events {
    /** 要动这一台了（**起或关**，动手之前）：载荷是服务器名 */
    "mcp.server.start"(name: string): void;
    /** 这一台落到某个状态了；⚠️ **没有 `failed`**：起不来是降级（落 `failed` 状态），不是这次动作失败 */
    "mcp.server.finish"(name: string, state: McpServerState): void;
    /** 全量对表之前：此刻运行期还是旧的样子 */
    "mcp.reload.start"(): void;
    /** 全量对表完了（顺带重试上一轮没起来的那几台）；⚠️ 同样**没有 `failed`**，理由见上面 */
    "mcp.reload.finish"(): void;
  }
}

/**
 * MCP 服务面：那一圈的管理功能（`McpManager` 是它的实现，形状在 `@/agents/mcp/manager.ts`）。
 * @description ⚠️ **改数据与改运行期是同一个动作**：写方法都经 `ctx.services.mcps` 落库，紧接着按新样子把这一台
 *   起停，所以它们返回时运行期已经是新的了——不需要再手动 `reload()`。⚠️ **全部动作一律排队**（见
 *   `@/agents/mcp/manager.js`）：并发调用不会交错，代价是第二个调用要等第一个起落完（可能几十秒）。
 */
export interface McpService {
  /** 清单：**集合来自 `mcps` 表**（含被标了 `disabled` 的那些），运行期只补状态；按 `id` 定序 */
  list(): readonly McpServerStatus[];
  /** 取一台的近况；库里没这一台给 `undefined` */
  get(name: string): McpServerStatus | undefined;
  /**
   * 建一台：写进 `mcps` 表并（没被 `disabled` 的话）起它。
   * @returns 它此刻的近况；⚠️ **成功不代表起来了**——起不来是降级，那一行会是 `failed` 并带 `error`
   * @throws 名字不合法 / 已经有这一台（当场拒，不覆盖）
   */
  create(draft: McpDraft): Promise<McpServerStatus>;
  /** 改一台：落库后立刻按新样子重开（只动这一台）；`false` = 表里没这一台 */
  update(name: string, changes: McpChanges): Promise<boolean>;
  /** 改 `disabled` 这一格并按它起停：`true` = 关掉且本进程不再起它（配置留着），`false` = 立刻起 */
  setDisabled(name: string, disabled: boolean): Promise<boolean>;
  /** 删一台：落库 + 关掉 + 摘掉它的工具；`false` = 表里没这一台 */
  delete(name: string): Promise<boolean>;
  /** 重启一台（**不改数据**）：`false` = 没有可重启的（没这一台，或它被标了 `disabled`） */
  restart(name: string): Promise<boolean>;
  /** 全量对表，并**重试**上一轮落成 `failed` 的那几台；逐条规则见 `@/agents/mcp/plan.js` 文件头 */
  reload(): Promise<void>;
}

/**
 * 装配 MCP：提供 `ctx.mcp`，装载即按 `mcps` 表起一遍，卸载即全部收掉。
 * @description ⚠️ **装载期就 provide**：别的插件 `inject: ["mcp"]` 等的是这个服务，不是「工具都登记完了」
 *   ——后者不可能有信号，工具是逐台陆续到的。
 */
export function mcpPlugin(ctx: Context): void {
  const manager = new McpManager(ctx);
  ctx.provide("mcp", manager);

  // ⚠️ **不 `await` 这个 effect**：Cordis 的装载不等 async effect，所以 MCP 是**非阻塞**接进来的，启动不等
  //   第三方 `npx`（实测 `await ctx.plugin()` 刚返回时工具数 = 0）。工具到了由 `tools.register.*` 通知 UI。
  // ⚠️ **订阅与装载收在同一个 effect**：卸载时多个 effect 是**并发**执行的（无顺序保证，见
  //   `@/starter/index.js`），分成两个就可能「监听器还活着、表已经收了」。
  ctx.effect(async () => {
    const offChanged = ctx.on("mcp.data.changed", (change) => {
      // ⚠️ 事件是**同步**发的，而对表要 await 起落（可达几十秒）⇒ 这里只能排队后放着走；这个 promise 自己
      //   的失败必须在这里接住（`ctx.emit` 不隔离，否则是 unhandled rejection）
      void manager.sync(change.name).catch((error: unknown) => {
        const reason = error instanceof Error ? error : new Error(String(error));
        ctx.logger.warn("MCP 服务器「%s」跟着数据变化对表时出了错：%s", change.name, reason.message);
      });
    });
    await manager.reload();
    return () => {
      offChanged();
      manager.dispose();
    };
  });
}

// ⚠️ 三样都是硬前置：少注一样就装不上，而不是「装上了但登记不了」
mcpPlugin.inject = ["db", "services", "tools"];

// ⚠️ 本目录**对外只留这一个出口**：外面要问状态就问 `ctx.mcp`，要动手就问 `ctx.mcp`；`McpManager` 那些类型
//   从 `@/agents/mcp/index.js` 直接引
export type { McpChanges, McpDraft, McpServerState, McpServerStatus };