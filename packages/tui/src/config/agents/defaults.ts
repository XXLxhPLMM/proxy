/**
 * @fileoverview agents 一节的默认值：步数上限 `maxSteps`（与 AI SDK 的 `stopWhen: isStepCount(n)` 同一个数）
 * @module config/agents/defaults
 */

/** agents 一节的形状 */
export interface AgentsConfig {
  /**
   * 一次调用里最多走几步（一个 step = 一次模型请求 + 它触发的工具执行）。
   * ⚠️ 这是**上限**不是配额：模型不再调工具时循环自然收尾，只有它停不下来（反复调同一个工具）才靠这里兜住。
   */
  readonly maxSteps: number;
}

/** agents 一节的默认值：20 步（与 AI SDK `ToolLoopAgent` 的默认 `stopWhen` 取同一个数，别让人以为这里在改什么） */
export function defaultAgentsConfig(): AgentsConfig {
  return { maxSteps: 20 };
}