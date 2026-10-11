/**
 * @fileoverview 提供商资源的操作**原语**：`providers` 表的增删改查
 * @module services/resource/ops/providers
 * @description 库句柄走函数参数；时刻由调用方给，本层不读时钟。
 * ⚠️ 写侧非空校验由 `requiredText` 兜底，读侧再由 `badContentError` 拒一条「读出来会坏」的行：
 *   provider id 为空即抛（坏数据不会穿过门面 API）。
 * ⚠️ 出入参走 DTO（`@/services/db/dto/provider.js`：`Provider` / `NewProvider` / `ProviderPatch`，
 * drizzle 按表结构推断），门面 API 直接暴露这些类型。
 * ⚠️ 只给 `../store/providers.js`（门面）用：跨目录取本地库走 `ctx.resource.providers`，别直接 import 本文件。
 */

import { asc, eq } from "drizzle-orm";
import type { Db } from "@/services/db/dialect.js";
import type { NewProvider, Provider, ProviderPatch } from "@/services/db/dto/index.js";
import { badContentError, requiredText } from "@/services/db/read.js";
import { models, providers } from "@/services/db/sqlite/schemas/index.js";

/** 提供商清单；按创建时间 / id 定序（顺序可复现，不靠驱动给的偶然次序） */
export function listProviders(db: Db): readonly Provider[] {
  return db
    .select()
    .from(providers)
    .orderBy(asc(providers.createdAt), asc(providers.id))
    .all()
    .map((row) => {
      if (row.id === "") throw badContentError("提供商列表", "id");
      return row;
    });
}

/** 按 `id` 取一个提供商；不在库里给 `undefined`；id 为空即抛（读侧闸） */
export function getProvider(db: Db, id: string): Provider | undefined {
  const row = db.select().from(providers).where(eq(providers.id, id)).get();
  if (row !== undefined && row.id === "") {
    throw badContentError(`提供商 ${id}`, "id");
  }
  return row;
}

/** 建一个提供商；`id` 撞了让驱动抛（主键约束的文案自己点名那一列） */
export function createProvider(db: Db, draft: NewProvider): Provider {
  const where = `新提供商 ${draft.id}`;
  requiredText(draft.id, where, "id");
  requiredText(draft.name, where, "name");
  requiredText(draft.baseUrl, where, "baseUrl");
  requiredText(draft.key, where, "key");
  db.insert(providers)
    .values({
      id: draft.id,
      name: draft.name,
      baseUrl: draft.baseUrl,
      key: draft.key,
      createdAt: draft.createdAt,
      updatedAt: draft.createdAt,
    })
    .run();
  return {
    id: draft.id,
    name: draft.name,
    baseUrl: draft.baseUrl,
    key: draft.key,
    createdAt: draft.createdAt,
    updatedAt: draft.createdAt,
  };
}

/** 改名称 / base url / key；`id` 不在库里给 `false`（不抛），在库里给 `true` */
export function updateProvider(db: Db, id: string, patch: ProviderPatch): boolean {
  const where = `提供商 ${id}`;
  const set: { name?: string; baseUrl?: string; key?: string; updatedAt: number } = {
    updatedAt: patch.updatedAt,
  };
  if (patch.name !== undefined) set.name = requiredText(patch.name, where, "name");
  if (patch.baseUrl !== undefined) set.baseUrl = requiredText(patch.baseUrl, where, "baseUrl");
  if (patch.key !== undefined) set.key = requiredText(patch.key, where, "key");
  return Number(db.update(providers).set(set).where(eq(providers.id, id)).run().changes) > 0;
}

/** 删一个提供商及其关联的模型：同一事务里一起删，防止留下孤儿模型 */
export function deleteProvider(db: Db, id: string): boolean {
  return db.transaction(tx => {
    tx.delete(models).where(eq(models.providerId, id)).run();
    return Number(tx.delete(providers).where(eq(providers.id, id)).run().changes) > 0;
  });
}
