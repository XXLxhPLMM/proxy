/**
 * @fileoverview MCP 服务器**服务**：`mcps` 表的搬运 + 数据一改就喊一声
 * @module service/mcps
 * @description
 * ⚠️ **本层只管数据**：`list` / `listEnabled` / `get` / `create` / `update` / `setDisabled` / `delete` 逐条
 *   转发给 `ctx.dao.mcps`，写成功就发一条 `mcp.data.changed`。**这里没有一条 MCP 的规矩**：服务器名的尺子
 *   （`@/agents/mcp/naming.js`）、形状闸（`@/db/read.js` 的 `mcpConfigFromRow`）、「这一行能不能起起来」全在
 *   `@/agents/mcp/` 那一圈 —— 业务服务层在它**下层**，反过来去 import 上层的规则就是分层反了。
 *   ⚠️ 由此**不 import `@/agents/`**，`db/read.js` 也不引（`db/dao/mcps.js` 自己把草稿化成与表同形，理由见那里）。
 * ⚠️ 「写不进一条跑不起来的行」那条性质**没丢，只是挪了位**：由 `ctx.mcp` 在落库**之前**拿候选行过形状闸
 *   （`manager.ts`），所以从 `ctx.mcp` 走那条路仍当场拒；直接绕过 `ctx.mcp` 写进来的半截行，会在对表时落成
 *   `ctx.mcp.list()` 里的 `failed` 并点名到列（那条降级路径本来就在，见 `@/agents/mcp/plan.js`）。
 * ⚠️ **本服务是 `mcps` 表唯一的写者**，所以「数据一改」也由它喊：载荷只给「哪一行、怎么改的」，**不发行
 *   本身**（行会变，监听者自己重读），声明随它的发出者走，在 `starter/plugins/services/`。
 *   读方法一条都不发——读不改数据。
 * ⚠️ **不 import DAO**：`ctx.dao` 只带「有哪些行操作」、不带库，所以每个 DAO 调用的第一个参数永远是
 *   `this.ctx.db`（本服务无事务，不走 `tx`）。
 * ⚠️ **不读时钟**（与 `dao/` 同一条）：`createdAt` / `updatedAt` 由调用方给（`ctx.mcp` 填 `Date.now()`）。
 * ⚠️ 跨目录取 MCP 服务走 `ctx.services.mcps`（由 `starter/plugins/services` 提供），别直接 import 本文件。
 */

import type { Context } from "cordis";
import type { Mcp, McpDraft, McpPatch } from "@/db/dto/index.js";

/** `mcps` 表改了一行的通知（`mcp.data.changed` 的载荷）。⚠️ 不带行本身：行会变，监听者自己重读 */
export interface McpDataChange {
  readonly kind: "created" | "updated" | "deleted";
  /** 服务器名（`mcps.id`） */
  readonly name: string;
}

/**
 * 落库成功后喊一声「这一行变了」（四个写方法共用，所以住模块层）。
 * @description ⚠️ **兜住监听器抛的错**：数据已经落库了，把错原样冒出去会让调用方以为「写失败了」而重试一次
 *   （那才是真损坏）。事件是通知，通知失败不改已经发生的事实。
 */
function announce(ctx: Context, change: McpDataChange): void {
  try {
    ctx.emit("mcp.data.changed", change);
  } catch {
    // 监听器自己坏了，它已经在自己的栈里炸过一次，这里不再叠一个
  }
}

/** MCP 服务器服务：`mcps` 表的搬运 + 落库成功后喊一声，没有别的 */
export class McpsService {
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** 清单（**含**被 `disabled` 的那些）；按 `id` 定序（顺序可复现，不靠驱动给的偶然次序） */
  list(): readonly Mcp[] {
    return this.ctx.dao.mcps.listMcpRows(this.ctx.db);
  }

  /** 没被 `disabled` 的那批；装载期要起的正是它们；定序同 {@link McpsService.list} */
  listEnabled(): readonly Mcp[] {
    return this.ctx.dao.mcps.listEnabledMcpRows(this.ctx.db);
  }

  /** 按 `id` 取一台；不在库里给 `undefined` */
  get(id: string): Mcp | undefined {
    return this.ctx.dao.mcps.getMcpRow(this.ctx.db, id);
  }

  /**
   * 建一台（`createdAt` 要调用方给，本层不读时钟）；落库成功后发 `mcp.data.changed`。
   * @description ⚠️ `id` 撞了让驱动抛（主键约束的文案自己点名那一列）。⚠️ 草稿里省略的那几格吃列缺省，
   *   由 `db/dao/mcps.js` 化成与写下去同形。
   */
  create(draft: McpDraft & { createdAt: number }): Mcp {
    const created = this.ctx.dao.mcps.createMcpRow(this.ctx.db, draft);
    announce(this.ctx, { kind: "created", name: created.id });
    return created;
  }

  /** 改一台；不在库里给 `false`（不抛也不发事件），在库里给 `true` 并发 `mcp.data.changed` */
  update(id: string, patch: McpPatch): boolean {
    const ok = this.ctx.dao.mcps.updateMcpRow(this.ctx.db, id, patch);
    // ⚠️ 只在**真改了**的时候喊（驱动报 `changes === 0` = 值与原来一样，那不是一次改动）
    if (ok) announce(this.ctx, { kind: "updated", name: id });
    return ok;
  }

  /** 改 `disabled` 这一格（`update` 的窄口：调用方不必自己拼 `updatedAt`），改了就喊一声 */
  setDisabled(id: string, disabled: boolean, updatedAt: number): boolean {
    const ok = this.ctx.dao.mcps.updateMcpRow(this.ctx.db, id, { disabled, updatedAt });
    if (ok) announce(this.ctx, { kind: "updated", name: id });
    return ok;
  }

  /** 删一台；不在库里给 `false`（不发事件），删掉了发 `mcp.data.changed` */
  delete(id: string): boolean {
    const ok = this.ctx.dao.mcps.deleteMcpRow(this.ctx.db, id);
    if (ok) announce(this.ctx, { kind: "deleted", name: id });
    return ok;
  }
}