import type { ModelId } from "./model-id.js";

export interface Session {
  readonly id: string;

  readonly title: string;

  readonly modelId: ModelId | null;

  readonly createdAt: number;

  readonly updatedAt: number;
}
