/**
 * @fileoverview 提供商门面：`attach` 包装已打开的库句柄，方法即 `providers` 表的操作
 * @module business/store/providers
 * @description 方法们只是把 `@/service/providers.js` 的原语绑上本实例的句柄（判据、事务都在那边）。
 * ⚠️ 出入参走 DTO（`@/db/dto/provider.js`：`Provider` / `NewProvider` / `ProviderPatch`）。
 * ⚠️ 句柄的开 / 关不归本门面（归 `@/starter/plugins/database.js`）；应用里组装走 `@/business/attach.js` 的 `attachResource`。
 */

import type { Db } from "@/db/dialect.js";
import type { NewProvider, Provider, ProviderPatch } from "@/db/dto/index.js";
import {
  createProvider,
  deleteProvider,
  getProvider,
  listProviders,
  updateProvider,
} from "@/service/providers.js";

export class ProvidersStore {
  private readonly db: Db;

  private constructor(db: Db) {
    this.db = db;
  }

  /** 包装一个已打开的库句柄（schema 由 `attachResource` 备好） */
  static attach(db: Db): ProvidersStore {
    return new ProvidersStore(db);
  }

  /** 提供商清单；按创建时间 / id 排序 */
  list(): readonly Provider[] {
    return listProviders(this.db);
  }

  /** 按 `id` 取一个提供商；不在库里给 `undefined` */
  get(id: string): Provider | undefined {
    return getProvider(this.db, id);
  }

  /** 建一个提供商（缺 `updatedAt`，内部由 `createdAt` 填充） */
  create(draft: NewProvider): Provider {
    return createProvider(this.db, draft);
  }

  /** 改名称 / base url / key；`id` 不在库里给 `false` */
  update(id: string, patch: ProviderPatch): boolean {
    return updateProvider(this.db, id, patch);
  }

  /** 删一个提供商及其关联的模型：事务内一起删，防孤儿 */
  delete(id: string): boolean {
    return deleteProvider(this.db, id);
  }
}
