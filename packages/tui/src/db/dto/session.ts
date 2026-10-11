import type { ModelId } from "@/lib/model-id.js";

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
