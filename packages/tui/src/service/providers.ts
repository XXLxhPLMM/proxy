/**
 * @fileoverview 提供商资源**服务**：提供商的**业务操作原语**，对 `@/db/dao/providers` 作校验后调用；
 * 跨表关联删除在事务中编排，事务内的原子行操作交给 DAO；出入参走 DTO（`@/db/dto/`）。
 * @module service/providers
 * @description 写侧非空校验由 `requiredText` 兜底，读侧再由 `badContentError` 拒一条「读出来会坏」的行：
 *   provider id 为空即抛（坏数据不会穿过门面 API）。
 * ⚠️ 跨目录取本地库走 `ctx.resource.providers`（由 `starter/plugins/resource` 提供），别直接 import 本文件。
 */

import type { Db } from "@/db/dialect.js";
import type { NewProvider, Provider, ProviderPatch } from "@/db/dto/index.js";
import { badContentError, requiredText } from "@/db/read.js";
import { dao } from "@/db/index.js";

/** 提供商清单；按创建时间 / id 定序（顺序可复现，不靠驱动给的偶然次序） */
function listProviders(db: Db): readonly Provider[] {
  return dao.providers.listProviderRows(db).map((row) => {
    if (row.id === "") throw badContentError("提供商列表", "id");
    return row;
  });
}

/** 按 `id` 取一个提供商；不在库里给 `undefined`；id 为空即抛（读侧闸） */
function getProvider(db: Db, id: string): Provider | undefined {
  const row = dao.providers.getProviderRow(db, id);
  if (row !== undefined && row.id === "") {
    throw badContentError(`提供商 ${id}`, "id");
  }
  return row;
}

/** 建一个提供商；先校验，`id` 撞了让驱动抛（主键约束的文案自己点名那一列） */
function createProvider(db: Db, draft: NewProvider): Provider {
  const where = `新提供商 ${draft.id}`;
  requiredText(draft.id, where, "id");
  requiredText(draft.name, where, "name");
  requiredText(draft.baseUrl, where, "baseUrl");
  requiredText(draft.key, where, "key");
  return dao.providers.createProviderRow(db, draft);
}

/** 改名称 / base url / key；`id` 不在库里给 `false`（不抛），在库里给 `true` */
function updateProvider(db: Db, id: string, patch: ProviderPatch): boolean {
  const where = `提供商 ${id}`;
  const set: { name?: string; baseUrl?: string; key?: string; updatedAt: number } = {
    updatedAt: patch.updatedAt,
  };
  if (patch.name !== undefined) set.name = requiredText(patch.name, where, "name");
  if (patch.baseUrl !== undefined) set.baseUrl = requiredText(patch.baseUrl, where, "baseUrl");
  if (patch.key !== undefined) set.key = requiredText(patch.key, where, "key");
  return dao.providers.updateProviderRow(db, id, set);
}

/** 删一个提供商及其关联的模型：同一事务里先级联删模型，再删提供商本身，防止留下孤儿模型 */
function deleteProvider(db: Db, id: string): boolean {
  return db.transaction((tx) => {
    dao.models.deleteModelRowsByProvider(tx, id);
    return dao.providers.deleteProviderRow(tx, id);
  });
}

/** 提供商资源服务 */
export class ProvidersService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** 提供商清单；按创建时间 / id 定序（顺序可复现，不靠驱动给的偶然次序） */
  list(): readonly Provider[] {
    return listProviders(this.db);
  }

  /** 按 `id` 取一个提供商；不在库里给 `undefined`；id 为空即抛（读侧闸） */
  get(id: string): Provider | undefined {
    return getProvider(this.db, id);
  }

  /** 建一个提供商；先校验，`id` 撞了让驱动抛（主键约束的文案自己点名那一列） */
  create(draft: NewProvider): Provider {
    return createProvider(this.db, draft);
  }

  /** 改名称 / base url / key；`id` 不在库里给 `false`（不抛），在库里给 `true` */
  update(id: string, patch: ProviderPatch): boolean {
    return updateProvider(this.db, id, patch);
  }

  /** 删一个提供商及其关联的模型：同一事务里先级联删模型，再删提供商本身，防止留下孤儿模型 */
  delete(id: string): boolean {
    return deleteProvider(this.db, id);
  }
}
