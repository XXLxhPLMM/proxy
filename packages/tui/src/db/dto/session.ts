import type { ModelId } from "@/lib/model-id.js";

/**
 * 会话的工作状态（只给上屏显示用，不描述内容本身）。
 *
 * ⚠️ **「无事」不在这个闭合集里**：`status` 为 `null` 就是无事（还没开始或没有活动），
 * 一个含义只留一处说法，不另设一个 `"idle"` 值。
 */
export const SESSION_STATUSES = [
  /** 已读 */
  "read",
  /** 工作中 */
  "working",
  /** 疑问（要人来答） */
  "question",
  /** 警告 */
  "warning",
  /** 错误 */
  "error",
  /** 完成 */
  "done",
] as const;

/** 工作状态之一；与 {@link SESSION_STATUSES} 同源，故不可能漂 */
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * `sessions` 表的行：`id` / `title` / `modelId` / `status` / `isActive` / `createdAt` / `updatedAt`。
 * 这是基于表结构的「基类型」（drizzle 按表结构推断），不是手写契约。
 */
export interface Session {
  /** 本地库主键；不透明字符串（默认 `randomUUID()` 生成的 UUID v4，36 字符） */
  readonly id: string;

  readonly title: string;

  /** 这个会话选中的模型；`null` = 还没选 */
  readonly modelId: ModelId | null;

  /** 工作状态（`SESSION_STATUSES` 闭合集）；`null` = 无事 */
  readonly status: SessionStatus | null;

  /** 这个会话是不是当前活动的那一个（新建默认是） */
  readonly isActive: boolean;

  /** 创建时刻（epoch 毫秒） */
  readonly createdAt: number;

  /** 最后更新时刻（epoch 毫秒） */
  readonly updatedAt: number;
}

/**
 * 建一个会话的草稿：除 `updatedAt` 外全字段；`updatedAt` 由写入层从 `createdAt` 填充，
 * 不劳动调用方填两遍。
 *
 * ⚠️ `id` **可不带**：主键由写入层现生成 `randomUUID()`（UUID v4，36 字符；与 `messages.id` 同一个
 * 生成器）。显式带了就用带的（空串即坏行，闸在写入层）。
 */
export type NewSession = Omit<Session, "updatedAt" | "id"> & Partial<Pick<Session, "id">>;

/**
 * 改会话的入参：`title` / `modelId` / `status` / `isActive` 可缺省（不动那一格），
 * `modelId: null` = 清掉选中的模型、`status: null` = 回到无事，`updatedAt` 由调用方给。
 */
export type SessionPatch = Pick<Partial<Session>, "title" | "modelId" | "status" | "isActive"> & {
  updatedAt: number;
};
