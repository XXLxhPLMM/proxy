/**
 * @fileoverview `mcps` 表的**原子**行操作（CRUD）：每一句只做一件事，不含事务、跨表或校验。
 * @module db/dao/mcps
 * @description ⚠️ **MCP 的规矩一条都不在这里**（服务器名的尺子在 `@/agents/mcp/naming.js`，形状闸在
 *   `@/db/read.js` 的 `mcpConfigFromRow`）：本层只负责行 ↔ 表，连「这一行能不能起」都不看。
 * ⚠️ **「没给 = 吃列缺省」是本层的事**（`mcpNewRowFromDraft` / `mcpDefinedPatch`）：drizzle 插一行时跳过值为
 *   `undefined` 的键、更新时更会跳过整格，所以交进来半截的草稿 / patch 就是「那些格吃缺省」，本层替调用方
 *   把它化成与写下去的那一行**同形**——于是本层交回去的行不是一份会骗人的半截对象。
 *
 * ⚠️ **没有事务**：MCP 服务器配置与别的表没有外键关系（它是自成一圈的能力清单），
 *   跨表编排没有可做的地方。需要「改配置 + 换掉旧会话」时那是 `@/agents/mcp/manager.js` 的事。
 */

import type { Db } from "@/db/dialect.js";
import type { Mcp, McpDraft, McpPatch } from "@/db/dto/mcp.js";
import { asc, eq } from "drizzle-orm";
import { mcpDefinedPatch, mcpNewRowFromDraft } from "@/db/read.js";
import { mcps } from "@/db/sqlite/schemas/index.js";

/**
 * 建一行；`updatedAt` 由 DAO 从 `createdAt` 填充，不劳动调用方填两遍。
 * @description 缺省的那几格先化成与写下去同形（可空列 `NULL`、`args` `'[]'`、`disabled` `false`），
 *   所以交回的 `Mcp` 就是库里那一行，不是一份带 `undefined` 的半截对象。
 */
export function createMcpRow(db: Db, draft: McpDraft & { createdAt: number }): Mcp {
  const row = mcpNewRowFromDraft(draft);
  db.insert(mcps).values({ ...row, updatedAt: row.createdAt }).run();
  return { ...row, updatedAt: row.createdAt };
}

/** 按 `id` 取一行；不在库里给 `undefined` */
export function getMcpRow(db: Db, id: string): Mcp | undefined {
  return db.select().from(mcps).where(eq(mcps.id, id)).get();
}

/** 全量清单；按 `id` 定序（顺序可复现，不靠驱动给的偶然次序） */
export function listMcpRows(db: Db): readonly Mcp[] {
  return db.select().from(mcps).orderBy(asc(mcps.id)).all();
}

/**
 * 没被 `disabled` 的那批（装载期要起的正是它们）；按 `id` 定序。
 * @description ⚠️ **走 `mcps_disabled_id_idx`**：等值列在前、排序列在后，正反扫都命中（见 `schemas/mcps.ts`）。
 */
export function listEnabledMcpRows(db: Db): readonly Mcp[] {
  return db.select().from(mcps).where(eq(mcps.disabled, false)).orderBy(asc(mcps.id)).all();
}

/** 改一行的若干列（含 `updatedAt`）；`id` 不在库里给 `false`。⚠️ patch 里显式的 `undefined` 当「没给」剔掉 */
export function updateMcpRow(db: Db, id: string, patch: McpPatch): boolean {
  return Number(db.update(mcps).set(mcpDefinedPatch(patch)).where(eq(mcps.id, id)).run().changes) > 0;
}

/** 删一行；`id` 不在库里给 `false` */
export function deleteMcpRow(db: Db, id: string): boolean {
  return Number(db.delete(mcps).where(eq(mcps.id, id)).run().changes) > 0;
}