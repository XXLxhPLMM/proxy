/**
 * @fileoverview 模型**服务**：模型的业务操作原语。行操作走 `ctx.dao.models`，库句柄走 `ctx.db`；
 * 单表操作无事务，出入参走 DTO（`@/db/dto/model.js`）。
 * @module service/models
 * @description
 * 写侧非空校验由 `requiredText` 兜底，读侧再由 `badContentError` 拒一条「读出来会坏」的行：
 *   模型 id 为空即抛（坏数据不会穿过门面 API）。
 * ⚠️ **不 import DAO**：行操作目录挂在 `ctx.dao`（由 `starter/plugins/dao` 提供），库挂在 `ctx.db`。
 *   库的传法只有两种 —— 普通路径 `ctx.db`，事务回调里的 `tx` —— DAO 的第一个参数收得住这两种，
 *   所以永远显式传、不闭包持有。
 * ⚠️ 跨目录取模型服务走 `ctx.services.models`（由 `starter/plugins/services` 提供），别直接 import 本文件。
 */

import type { Context } from "cordis";
import type { Model, NewModel } from "@/db/dto/index.js";
import { badContentError, requiredText } from "@/db/read.js";

/** 模型清单；按提供商 / 创建时间 / id 定序（顺序可复现） */
function listModels(ctx: Context): readonly Model[] {
  return ctx.dao.models.listModelRows(ctx.db).map((row) => {
    if (row.id === "") throw badContentError("模型列表", "id");
    return row;
  });
}

/** 按提供商取该提供商下的模型清单；顺序可复现 */
function getModelsByProvider(ctx: Context, providerId: string): readonly Model[] {
  return ctx.dao.models.listModelRowsByProvider(ctx.db, providerId).map((row) => {
    if (row.id === "") throw badContentError(`提供商 ${providerId} 的模型列表`, "id");
    return row;
  });
}

/** 按（提供商 id / 模型 id）取一个模型；不在库里给 `undefined`；id 为空即抛（读侧闸） */
function getModel(ctx: Context, providerId: string, id: string): Model | undefined {
  const row = ctx.dao.models.getModelRow(ctx.db, providerId, id);
  if (row !== undefined && row.id === "") {
    throw badContentError(`模型 ${id}（提供商 ${providerId}）`, "id");
  }
  return row;
}

/** 建一个模型；先校验，`providerId + id` 撞了让驱动抛（复合主键约束的文案自己点名两列） */
function createModel(ctx: Context, draft: NewModel & { createdAt: number }): Model {
  const where = `新模型 ${draft.providerId}/${draft.id}`;
  requiredText(draft.providerId, where, "providerId");
  requiredText(draft.id, where, "id");
  requiredText(draft.displayName, where, "displayName");
  requiredText(draft.sdk, where, "sdk");
  return ctx.dao.models.createModelRow(ctx.db, draft);
}

/** 删一个模型；`providerId` 与模型 id 须同时匹配，不匹配给 `false` */
function deleteModel(ctx: Context, providerId: string, id: string): boolean {
  return ctx.dao.models.deleteModelRow(ctx.db, providerId, id);
}

/** 模型服务 */
export class ModelsService {
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** 模型清单；按提供商 / 创建时间 / id 定序（顺序可复现） */
  list(): readonly Model[] {
    return listModels(this.ctx);
  }

  /** 按提供商取该提供商下的模型清单；顺序可复现 */
  listByProvider(providerId: string): readonly Model[] {
    return getModelsByProvider(this.ctx, providerId);
  }

  /** 按（提供商 id / 模型 id）取一个模型；不在库里给 `undefined`；id 为空即抛（读侧闸） */
  get(providerId: string, id: string): Model | undefined {
    return getModel(this.ctx, providerId, id);
  }

  /** 建一个模型（`NewModel` 加 `createdAt`：调用方给时刻） */
  create(draft: NewModel & { createdAt: number }): Model {
    return createModel(this.ctx, draft);
  }

  /** 删一个模型；`providerId` 与模型 id 须同时匹配，不匹配给 `false` */
  delete(providerId: string, id: string): boolean {
    return deleteModel(this.ctx, providerId, id);
  }
}