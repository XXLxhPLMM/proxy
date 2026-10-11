/**
 * @fileoverview 模型资源**服务**：模型的**业务操作原语**，对 `@/db/dao/models` 作校验后调用；
 * 单表操作无事务，出入参走 DTO（`@/db/dto/model.js`）。
 * @module service/models
 * @description 写侧非空校验由 `requiredText` 兜底，读侧再由 `badContentError` 拒一条「读出来会坏」的行：
 *   模型 id 为空即抛（坏数据不会穿过门面 API）。
 * ⚠️ 跨目录取本地库走 `ctx.resource.models`（由 `starter/plugins/resource` 提供），别直接 import 本文件。
 */

import type { Db } from "@/db/dialect.js";
import type { Model, NewModel } from "@/db/dto/index.js";
import { badContentError, requiredText } from "@/db/read.js";
import { dao } from "@/db/index.js";

/** 模型清单；按提供商 / 创建时间 / id 定序（顺序可复现） */
function listModels(db: Db): readonly Model[] {
  return dao.models.listModelRows(db).map((row) => {
    if (row.id === "") throw badContentError("模型列表", "id");
    return row;
  });
}

/** 按提供商取该提供商下的模型清单；顺序可复现 */
function getModelsByProvider(db: Db, providerId: string): readonly Model[] {
  return dao.models.listModelRowsByProvider(db, providerId).map((row) => {
    if (row.id === "") throw badContentError(`提供商 ${providerId} 的模型列表`, "id");
    return row;
  });
}

/** 按（提供商 id / 模型 id）取一个模型；不在库里给 `undefined`；id 为空即抛（读侧闸） */
function getModel(db: Db, providerId: string, id: string): Model | undefined {
  const row = dao.models.getModelRow(db, providerId, id);
  if (row !== undefined && row.id === "") {
    throw badContentError(`模型 ${id}（提供商 ${providerId}）`, "id");
  }
  return row;
}

/** 建一个模型；先校验，`providerId + id` 撞了让驱动抛（复合主键约束的文案自己点名两列） */
function createModel(db: Db, draft: NewModel & { createdAt: number }): Model {
  const where = `新模型 ${draft.providerId}/${draft.id}`;
  requiredText(draft.providerId, where, "providerId");
  requiredText(draft.id, where, "id");
  requiredText(draft.displayName, where, "displayName");
  requiredText(draft.sdk, where, "sdk");
  return dao.models.createModelRow(db, draft);
}

/** 删一个模型；`providerId` 与模型 id 须同时匹配，不匹配给 `false` */
function deleteModel(db: Db, providerId: string, id: string): boolean {
  return dao.models.deleteModelRow(db, providerId, id);
}

/** 模型资源服务 */
export class ModelsService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** 模型清单；按提供商 / 创建时间 / id 定序（顺序可复现） */
  list(): readonly Model[] {
    return listModels(this.db);
  }

  /** 按提供商取该提供商下的模型清单；顺序可复现 */
  listByProvider(providerId: string): readonly Model[] {
    return getModelsByProvider(this.db, providerId);
  }

  /** 按（提供商 id / 模型 id）取一个模型；不在库里给 `undefined`；id 为空即抛（读侧闸） */
  get(providerId: string, id: string): Model | undefined {
    return getModel(this.db, providerId, id);
  }

  /** 建一个模型（`NewModel` 加 `createdAt`：调用方给时刻） */
  create(draft: NewModel & { createdAt: number }): Model {
    return createModel(this.db, draft);
  }

  /** 删一个模型；`providerId` 与模型 id 须同时匹配，不匹配给 `false` */
  delete(providerId: string, id: string): boolean {
    return deleteModel(this.db, providerId, id);
  }
}
