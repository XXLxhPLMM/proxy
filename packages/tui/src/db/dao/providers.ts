/**
 * @fileoverview `providers` 表的**原子**行操作（CRUD）：每一句只做一件事，不含事务、跨表或校验。
 * @module db/dao/providers
 * @description 校验下沉到 `service/`（`requiredText` / `badContentError`），DAO 层只负责行 ↔ 表。
 */

import type { Db } from "@/db/dialect.js";
import type { NewProvider, Provider, ProviderPatch } from "@/db/dto/provider.js";
import { asc, eq } from "drizzle-orm";
import { providers } from "@/db/sqlite/schemas/index.js";

/** 建一行；`updatedAt` 由 DAO 从 `createdAt` 填充，不劳动调用方填两遍 */
export function createProviderRow(db: Db, draft: NewProvider): Provider {
  db.insert(providers).values({ ...draft, updatedAt: draft.createdAt }).run();
  return { ...draft, updatedAt: draft.createdAt };
}

/** 按 `id` 取一行；不在库里给 `undefined` */
export function getProviderRow(db: Db, id: string): Provider | undefined {
  return db.select().from(providers).where(eq(providers.id, id)).get();
}

/** 清单；按创建时间 / id 定序（顺序可复现） */
export function listProviderRows(db: Db): readonly Provider[] {
  return db.select().from(providers).orderBy(asc(providers.createdAt), asc(providers.id)).all();
}

/** 改 `name` / `baseUrl` / `key` / `updatedAt`；`id` 不在库里给 `false` */
export function updateProviderRow(
  db: Db,
  id: string,
  patch: ProviderPatch & { updatedAt: number },
): boolean {
  return Number(db.update(providers).set(patch).where(eq(providers.id, id)).run().changes) > 0;
}

/** 删一行；`id` 不在库里给 `false` */
export function deleteProviderRow(db: Db, id: string): boolean {
  return Number(db.delete(providers).where(eq(providers.id, id)).run().changes) > 0;
}
