export type ModelId = string;

export interface ModelIdParts {
  readonly provider: string;
  readonly model: string;
}

export function splitModelId(modelId: string): ModelIdParts | null {
  const at = modelId.indexOf("/");
  if (at <= 0) return null;
  const provider = modelId.slice(0, at);
  const model = modelId.slice(at + 1);
  if (model === "") return null;
  return { provider, model };
}

export function isModelId(modelId: string): boolean {
  return splitModelId(modelId) !== null;
}
