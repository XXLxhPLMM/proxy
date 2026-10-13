/**
 * @fileoverview 提供商**服务**：提供商的业务操作原语。行操作走 `ctx.dao.providers`，库句柄走 `ctx.db`，
 * 跨表关联删除在事务中编排，事务内的原子行操作交给 DAO；出入参走 DTO（`@/db/dto/`）。
 * @module service/providers
 * @description
 * 写侧非空校验由 `requiredText` 兜底，读侧再由 `badContentError` 拒一条「读出来会坏」的行：
 *   provider id 为空即抛（坏数据不会穿过门面 API）。
 * ⚠️ **不 import DAO**：行操作目录挂在 `ctx.dao`（由 `starter/plugins/dao` 提供），库挂在 `ctx.db`。
 *   库的传法只有两种 —— 普通路径 `ctx.db`，事务回调里的 `tx` —— DAO 的第一个参数收得住这两种，
 *   所以永远显式传、不闭包持有。
 * ⚠️ 跨目录取提供商服务走 `ctx.services.providers`（由 `starter/plugins/services` 提供），别直接 import 本文件。
 */

import type { Context } from "cordis";
import type { NewProvider, Provider, ProviderPatch } from "@/db/dto/index.js";
import { badContentError, requiredText } from "@/db/read.js";

/** 提供商清单；按创建时间 / id 定序（顺序可复现，不靠驱动给的偶然次序） */
function listProviders(ctx: Context): readonly Provider[] {
  return ctx.dao.providers.listProviderRows(ctx.db).map((row) => {
    if (row.id === "") throw badContentError("提供商列表", "id");
    return row;
  });
}

/** 按 `id` 取一个提供商；不在库里给 `undefined`；id 为空即抛（读侧闸） */
function getProvider(ctx: Context, id: string): Provider | undefined {
  const row = ctx.dao.providers.getProviderRow(ctx.db, id);
  if (row !== undefined && row.id === "") {
    throw badContentError(`提供商 ${id}`, "id");
  }
  return row;
}

/** 建一个提供商；先校验，`id` 撞了让驱动抛（主键约束的文案自己点名那一列） */
function createProvider(ctx: Context, draft: NewProvider): Provider {
  const where = `新提供商 ${draft.id}`;
  requiredText(draft.id, where, "id");
  requiredText(draft.name, where, "name");
  requiredText(draft.baseUrl, where, "baseUrl");
  requiredText(draft.key, where, "key");
  return ctx.dao.providers.createProviderRow(ctx.db, draft);
}

/** 改名称 / base url / key；`id` 不在库里给 `false`（不抛），在库里给 `true` */
function updateProvider(ctx: Context, id: string, patch: ProviderPatch): boolean {
  const where = `提供商 ${id}`;
  const set: { name?: string; baseUrl?: string; key?: string; updatedAt: number } = {
    updatedAt: patch.updatedAt,
  };
  if (patch.name !== undefined) set.name = requiredText(patch.name, where, "name");
  if (patch.baseUrl !== undefined) set.baseUrl = requiredText(patch.baseUrl, where, "baseUrl");
  if (patch.key !== undefined) set.key = requiredText(patch.key, where, "key");
  return ctx.dao.providers.updateProviderRow(ctx.db, id, set);
}

/** 删一个提供商及其关联的模型：同一事务里先级联删模型，再删提供商本身，防止留下孤儿模型
 * @description ⚠️ 事务里 DAO 的第一个参数是 `tx` 而不是 `ctx.db` —— 行操作目录不绑库 */
function deleteProvider(ctx: Context, id: string): boolean {
  return ctx.db.transaction((tx) => {
    ctx.dao.models.deleteModelRowsByProvider(tx, id);
    return ctx.dao.providers.deleteProviderRow(tx, id);
  });
}

/** 提供商服务 */
export class ProvidersService {
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** 提供商清单；按创建时间 / id 定序（顺序可复现，不靠驱动给的偶然次序） */
  list(): readonly Provider[] {
    return listProviders(this.ctx);
  }

  /** 按 `id` 取一个提供商；不在库里给 `undefined`；id 为空即抛（读侧闸） */
  get(id: string): Provider | undefined {
    return getProvider(this.ctx, id);
  }

  /** 建一个提供商；先校验，`id` 撞了让驱动抛（主键约束的文案自己点名那一列） */
  create(draft: NewProvider): Provider {
    return createProvider(this.ctx, draft);
  }

  /** 改名称 / base url / key；`id` 不在库里给 `false`（不抛），在库里给 `true` */
  update(id: string, patch: ProviderPatch): boolean {
    return updateProvider(this.ctx, id, patch);
  }

  /** 删一个提供商及其关联的模型：同一事务里先级联删模型，再删提供商本身，防止留下孤儿模型 */
  delete(id: string): boolean {
    return deleteProvider(this.ctx, id);
  }
}