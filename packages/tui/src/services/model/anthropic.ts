/**
 * @fileoverview Anthropic 方言：`/v1/messages` + `x-api-key`，系统提示**拆到顶层** `system`
 * @module services/model/anthropic
 */

import { replyOfText } from "./dialogue.js";
import { arrayAt, joinPath, listingsFrom, objectAt, requestJson, stringAt } from "./transport.js";
import type { ChatMessage, DialectInput, ModelDialect, ModelListing, ModelReply } from "./types.js";

/** 答复上限（⚠️ `max_tokens` 是**必填**，缺了对面直接拒；保守缺省：一轮只答一行命令或一句话） */
const MAX_TOKENS = 4096;

/** 推理强度 → `thinking.budget_tokens`（⚠️ `null` 是**不发 `thinking` 那个对象**） */
// ⚠️ 逐档对齐 `ReasoningEffort`：加一档而忘了给预算，对面就当「没开推理」而静默降级，屏上完全看不出来
const BUDGET: Record<DialectInput["reasoning"], number | null> = {
  off: null,
  low: 1024,
  medium: 2048,
  high: 3072,
};

/**
 * Anthropic 的版本头（⚠️ **必填**：这一家是按版本发版的，而缺了它对面按最老的一档处理）
 */
const ANTHROPIC_VERSION = "2023-06-01";

export const anthropic: ModelDialect = {
  format: "anthropic",

  async ask(input: DialectInput): Promise<ModelReply> {
    const { system, turns } = splitSystem(input.messages);
    const body: Record<string, unknown> = {
      model: input.model,
      messages: turns,
      max_tokens: MAX_TOKENS,
    };
    // ⚠️ **system 不在 `messages` 里**：这一家把系统提示放在顶层，而留在数组里会被当成一条用户消息
    if (system !== null) body["system"] = system;
    const budget = BUDGET[input.reasoning];
    if (budget !== null) body["thinking"] = { type: "enabled", budget_tokens: budget };
    const raw = await requestJson({
      url: joinPath(input.baseUrl, "/v1/messages"),
      method: "POST",
      // ⚠️ 凭据**只**在这一行出现，而这一行只往 provider 去（`baseUrl` 是用户自己配的地址）
      headers: { "x-api-key": input.apiKey, "anthropic-version": ANTHROPIC_VERSION },
      body,
      signal: input.signal,
      fetchImpl: input.fetchImpl,
      what: "模型",
    });
    const blocks = arrayAt(objectAt(raw, "模型的回答")["content"], "content");
    return replyOfText(textOfBlocks(blocks));
  },

  async listModels(input: DialectInput): Promise<readonly ModelListing[]> {
    const raw = await requestJson({
      url: joinPath(input.baseUrl, "/v1/models"),
      method: "GET",
      headers: { "x-api-key": input.apiKey, "anthropic-version": ANTHROPIC_VERSION },
      signal: input.signal,
      fetchImpl: input.fetchImpl,
      what: "模型清单",
    });
    const rows = arrayAt(objectAt(raw, "模型清单")["data"], "data");
    return listingsFrom(rows, "id", "data 里的一项").map((one) => ({ ...one, label: one.modelId }));
  },
};

/** 顶层 `system` + 只剩 user/assistant 的 `messages`（⚠️ 这一家**不接受** `system` 出现在数组里） */
function splitSystem(messages: readonly ChatMessage[]): {
  readonly system: string | null;
  readonly turns: readonly { role: "user" | "assistant"; content: string }[];
} {
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  const system: string[] = [];
  for (const one of messages) {
    if (one.role === "system") system.push(one.content);
    else turns.push({ role: one.role, content: one.content });
  }
  return { system: system.length === 0 ? null : system.join("\n"), turns };
}

/** `content` 是一串**块**（⚠️ 开推理时里面混着 `thinking` 那些块 —— 只取 `text` 那些） */
function textOfBlocks(blocks: readonly unknown[]): string {
  const texts: string[] = [];
  for (const block of blocks) {
    const obj = objectAt(block, "content 里的一块");
    if (obj["type"] === "text") texts.push(stringAt(obj["text"], "content 里的 text"));
  }
  return texts.join("\n");
}