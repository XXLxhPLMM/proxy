/**
 * @fileoverview `models` 表的**原子**行操作（CRUD）：每一句只做一件事，不含事务、跨表或校验。
 * @module db/dao/models
 * @description 校验下沉到 `service/`（`requiredText` / `badContentError`），DAO 层只负责行 ↔ 表。
 */

import type { Db } from "@/db/dialect.js";
import type { Model, NewModel } from "@/db/dto/model.js";
import { and, asc, eq } from "drizzle-orm";
import { models } from "@/db/sqlite/schemas/index.js";

/** 建一行；`createdAt` 由调用方给（本层不读时钟） */
export function createModelRow(db: Db, draft: NewModel & { createdAt: number }): Model {
  db.insert(models).values(draft).run();
  return draft;
}

/** 按（提供商 id / 模型 id）取一行；不在库里给 `undefined` */
export function getModelRow(db: Db, providerId: string, id: string): Model | undefined {
  return db
    .select()
    .from(models)
    .where(and(eq(models.providerId, providerId), eq(models.id, id)))
    .get();
}

/** 全量清单；按提供商 / 创建时间 / id 定序（顺序可复现） */
export function listModelRows(db: Db): readonly Model[] {
  return db
    .select()
    .from(models)
    .orderBy(asc(models.providerId), asc(models.createdAt), asc(models.id))
    .all();
}

/** 按提供商取该提供商下的模型；顺序可复现 */
export function listModelRowsByProvider(db: Db, providerId: string): readonly Model[] {
  return db
    .select()
    .from(models)
    .where(eq(models.providerId, providerId))
    .orderBy(asc(models.createdAt), asc(models.id))
    .all();
}

/** 删一行；`providerId` 与模型 id 须同时匹配，不匹配给 `false` */
export function deleteModelRow(db: Db, providerId: string, id: string): boolean {
  return Number(
    db
      .delete(models)
      .where(and(eq(models.providerId, providerId), eq(models.id, id)))
      .run().changes,
  ) > 0;
}

/** 删某个提供商的全部模型（供事务中的级联删除使用；`id` 为空串不例外） */
export function deleteModelRowsByProvider(db: Db, providerId: string): void {
  db.delete(models).where(eq(models.providerId, providerId)).run();
}
