import type { ModelId } from "@/lib/model-id.js";

export interface Session {
  readonly id: string;

  readonly title: string;

  readonly modelId: ModelId | null;

  readonly createdAt: number;

  readonly updatedAt: number;
}
