/**
 * @fileoverview 模型门面：`attach` 包装已打开的库句柄，方法即 `models` 表的操作
 * @module business/store/models
 * @description 方法们只是把 `@/service/models.js` 的原语绑上本实例的句柄（判据、事务都在那边）。
 * ⚠️ 出入参走 DTO（`@/db/dto/model.js`：`Model` / `NewModel`，`createdAt` 由调用方给）。
 * ⚠️ 句柄的开 / 关不归本门面（归 `@/starter/plugins/database.js`）；应用里组装走 `@/business/attach.js` 的 `attachResource`。
 */

import type { Db } from "@/db/dialect.js";
import type { Model, NewModel } from "@/db/dto/index.js";
import {
  createModel,
  deleteModel,
  getModel,
  getModelsByProvider,
  listModels,
} from "@/service/models.js";

export class ModelsStore {
  private readonly db: Db;

  private constructor(db: Db) {
    this.db = db;
  }

  /** 包装一个已打开的库句柄（schema 由 `attachResource` 备好） */
  static attach(db: Db): ModelsStore {
    return new ModelsStore(db);
  }

  /** 模型清单；按提供商 / 创建时间 / id 排序 */
  list(): readonly Model[] {
    return listModels(this.db);
  }

  /** 按提供商取该提供商下的模型清单 */
  listByProvider(providerId: string): readonly Model[] {
    return getModelsByProvider(this.db, providerId);
  }

  /** 按（提供商 id / 模型 id）取一个模型；不在库里给 `undefined` */
  get(providerId: string, id: string): Model | undefined {
    return getModel(this.db, providerId, id);
  }

  /** 建一个模型（`NewModel` 加 `createdAt`：调用方给时刻） */
  create(draft: NewModel & { createdAt: number }): Model {
    return createModel(this.db, draft);
  }

  /** 删一个模型；`providerId` 与模型 id 须同时匹配 */
  delete(providerId: string, id: string): boolean {
    return deleteModel(this.db, providerId, id);
  }
}
