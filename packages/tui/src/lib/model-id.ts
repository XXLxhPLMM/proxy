/** `provider/model` 复合键 —— 本地库 `model_id` 列存的就是这一形态 */
export type ModelId = string;

/** 模型键切出的两段（{@link splitModelId} 的返回） */
export interface ModelIdParts {
  /** 第一个 `/` 之前那一段：提供商标识（非空、不含 `/`） */
  readonly provider: string;
  /** 第一个 `/` 之后那一段：模型名（非空，可含 `/`，如 openrouter 的 `anthropic/claude-x`） */
  readonly model: string;
}

/** 把模型键切成 `provider` / `model` 两段；不是那个形状（缺 `/` 或缺一段）给 `null` */
export function splitModelId(modelId: string): ModelIdParts | null {
  const at = modelId.indexOf("/");
  if (at <= 0) return null;
  const provider = modelId.slice(0, at);
  const model = modelId.slice(at + 1);
  if (model === "") return null;
  return { provider, model };
}

/** 判形：能不能切出两段（即 {@link splitModelId} 非 `null`） */
export function isModelId(modelId: string): boolean {
  return splitModelId(modelId) !== null;
}
