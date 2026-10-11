/**
 * @fileoverview 模型资源的操作**原语**：`models` 表的增删改查
 * @module operations/models
 * @description 库句柄走函数参数；时刻由调用方给，本层不读时钟。
 * ⚠️ 写侧非空校验由 `requiredText` 兜底，读侧再由 `badContentError` 拒一条「读出来会坏」的行：
 *   模型 id 为空即抛（坏数据不会穿过门面 API）。
 * ⚠️ 出入参走 DTO（`@/db/dto/model.js`：`Model` / `NewModel`，drizzle 按表结构推断），
 * `createdAt` 由调用方给（本层不读时钟）；门面 API 直接暴露这些类型。
 * ⚠️ 只给 `business/store/models.js`（门面）用：跨目录取本地库走 `ctx.business.models`，别直接 import 本文件。
 */

import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/db/dialect.js";
import type { Model, NewModel } from "@/db/dto/index.js";
import { badContentError, requiredText } from "@/db/read.js";
import { models } from "@/db/sqlite/schemas/index.js";

/** 模型清单；按提供商 / 创建时间 / id 定序（顺序可复现） */
export function listModels(db: Db): readonly Model[] {
  return db
    .select()
    .from(models)
    .orderBy(asc(models.providerId), asc(models.createdAt), asc(models.id))
    .all()
    .map((row) => {
      if (row.id === "") throw badContentError("模型列表", "id");
      return row;
    });
}

/** 按提供商取该提供商下的模型清单 */
export function getModelsByProvider(db: Db, providerId: string): readonly Model[] {
  return db
    .select()
    .from(models)
    .where(eq(models.providerId, providerId))
    .orderBy(asc(models.createdAt), asc(models.id))
    .all()
    .map((row) => {
      if (row.id === "") throw badContentError(`提供商 ${providerId} 的模型列表`, "id");
      return row;
    });
}

/** 按（提供商 id / 模型 id）取一个模型；不在库里给 `undefined`；id 为空即抛（读侧闸） */
export function getModel(db: Db, providerId: string, id: string): Model | undefined {
  const row = db
    .select()
    .from(models)
    .where(and(eq(models.providerId, providerId), eq(models.id, id)))
    .get();
  if (row !== undefined && row.id === "") {
    throw badContentError(`模型 ${id}（提供商 ${providerId}）`, "id");
  }
  return row;
}

/** 建一个模型；`providerId + id` 撞了让驱动抛（复合主键约束的文案自己点名两列） */
export function createModel(db: Db, draft: NewModel & { createdAt: number }): Model {
  const where = `新模型 ${draft.providerId}/${draft.id}`;
  requiredText(draft.providerId, where, "providerId");
  requiredText(draft.id, where, "id");
  requiredText(draft.displayName, where, "displayName");
  requiredText(draft.sdk, where, "sdk");
  db.insert(models)
    .values({
      providerId: draft.providerId,
      id: draft.id,
      displayName: draft.displayName,
      sdk: draft.sdk,
      createdAt: draft.createdAt,
    })
    .run();
  return {
    id: draft.id,
    displayName: draft.displayName,
    providerId: draft.providerId,
    sdk: draft.sdk,
    createdAt: draft.createdAt,
  };
}

/** 删一个模型；`providerId` 与模型 id 须同时匹配，不匹配给 `false` */
export function deleteModel(db: Db, providerId: string, id: string): boolean {
  return Number(
    db
      .delete(models)
      .where(and(eq(models.providerId, providerId), eq(models.id, id)))
      .run()
      .changes,
  ) > 0;
}
