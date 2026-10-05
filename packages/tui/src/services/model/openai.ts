/**
 * @fileoverview OpenAI 方言：`/chat/completions` + `Authorization: Bearer`，系统提示留在 `messages[0]`
 * @module services/model/openai
 */

import { replyOfText } from "./dialogue.js";
import { arrayAt, joinPath, listingsFrom, objectAt, requestJson, stringAt } from "./transport.js";
import type { DialectInput, ModelDialect, ModelListing, ModelReply } from "./types.js";

/** 推理强度 → 请求体里那个参数（⚠️ `null` 是**整个字段都不发**，不是发一个「关」的取值） */
const EFFORT: Record<DialectInput["reasoning"], string | null> = {
  off: null,
  low: "low",
  medium: "medium",
  high: "high",
};

export const openai: ModelDialect = {
  format: "openai",

  async ask(input: DialectInput): Promise<ModelReply> {
    const body: Record<string, unknown> = { model: input.model, messages: input.messages };
    // ⚠️ `off` 时**字段整个不出现**：这一档没有「关」的取值，而对面会把多余的键当成非法请求
    const effort = EFFORT[input.reasoning];
    if (effort !== null) body["reasoning_effort"] = effort;
    const raw = await requestJson({
      url: joinPath(input.baseUrl, "/chat/completions"),
      method: "POST",
      // ⚠️ 凭据**只**在这一行出现，而这一行只往 provider 去（`baseUrl` 是用户自己配的地址）
      headers: { Authorization: `Bearer ${input.apiKey}` },
      body,
      signal: input.signal,
      fetchImpl: input.fetchImpl,
      what: "模型",
    });
    const choice = objectAt(arrayAt(objectAt(raw, "模型的回答")["choices"], "choices")[0], "choices[0]");
    const message = objectAt(choice["message"], "choices[0].message");
    return replyOfText(stringAt(message["content"], "choices[0].message.content"));
  },

  async listModels(input: DialectInput): Promise<readonly ModelListing[]> {
    const raw = await requestJson({
      url: joinPath(input.baseUrl, "/models"),
      method: "GET",
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: input.signal,
      fetchImpl: input.fetchImpl,
      what: "模型清单",
    });
    const rows = arrayAt(objectAt(raw, "模型清单")["data"], "data");
    return listingsFrom(rows, "id", "data 里的一项").map((one) => ({ ...one, label: one.modelId }));
  },
};