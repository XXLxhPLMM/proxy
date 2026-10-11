import type { ModelId } from "@/lib/model-id.js";

/**
 * `sessions` 表的行：`id` / `title` / `modelId` / `createdAt` / `updatedAt`。
 * 这是基于表结构的「基类型」（drizzle 按表结构推断），不是手写契约。
 */
export interface Session {
  /** 本地库主键 */
  readonly id: string;

  readonly title: string;

  /** 这个会话选中的模型；`null` = 还没选 */
  readonly modelId: ModelId | null;

  /** 创建时刻（epoch 毫秒） */
  readonly createdAt: number;

  /** 最后更新时刻（epoch 毫秒） */
  readonly updatedAt: number;
}

/**
 * 建一个会话的草稿：除 `updatedAt` 外全字段；`updatedAt` 由写入层从 `createdAt` 填充，
 * 不劳动调用方填两遍。
 */
export type NewSession = Omit<Session, "updatedAt">;

/**
 * 改会话的入参：`title` / `modelId` 可缺省（不动那一格），`modelId: null` = 清掉选中的模型，
 * `updatedAt` 由调用方给。
 */
export type SessionPatch = Pick<Partial<Session>, "title" | "modelId"> & {
  updatedAt: number;
};
