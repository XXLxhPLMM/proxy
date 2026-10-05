/**
 * @fileoverview Gemini 方言：`:generateContent` + `x-goog-api-key`，系统提示走 `systemInstruction`
 * @module services/model/gemini
 */

import { replyOfText } from "./dialogue.js";
import { arrayAt, joinPath, listingsFrom, objectAt, requestJson, stringAt } from "./transport.js";
import type { ChatMessage, DialectInput, ModelDialect, ModelListing, ModelReply } from "./types.js";

// ⚠️ 凭据走**头**而不走 `?key=` 查询串：URL 会被对面与沿途每一跳的访问日志原样记下，而头不会

/** 推理强度 → `generationConfig.thinkingConfig.thinkingBudget`（⚠️ `null` 是**那个字段整个不发**） */
const BUDGET: Record<DialectInput["reasoning"], number | null> = {
  off: null,
  low: 1024,
  medium: 2048,
  high: 3072,
};

/** 清单字段里那段资源名前缀（⚠️ 剥掉它是因为**下游拼的正是裸 id** —— 那个 `modelId` 要拿去拼 URL） */
const NAME_PREFIX = "models/";

export const gemini: ModelDialect = {
  format: "gemini",

  async ask(input: DialectInput): Promise<ModelReply> {
    const { system, turns } = splitSystem(input.messages);
    const body: Record<string, unknown> = { contents: turns };
    // ⚠️ **系统提示不在 `contents` 里**：这一家把它单列成 `systemInstruction`
    if (system !== null) body["systemInstruction"] = { parts: [{ text: system }] };
    const budget = BUDGET[input.reasoning];
    if (budget !== null) {
      body["generationConfig"] = { thinkingConfig: { thinkingBudget: budget, includeThoughts: false } };
    }
    const raw = await requestJson({
      url: joinPath(input.baseUrl, `/models/${encodeURIComponent(input.model)}:generateContent`),
      method: "POST",
      // ⚠️ 凭据**只**在这一行出现，而这一行只往 provider 去（`baseUrl` 是用户自己配的地址）
      headers: { "x-goog-api-key": input.apiKey },
      body,
      signal: input.signal,
      fetchImpl: input.fetchImpl,
      what: "模型",
    });
    const candidate = objectAt(
      arrayAt(objectAt(raw, "模型的回答")["candidates"], "candidates")[0],
      "candidates[0]",
    );
    const parts = arrayAt(objectAt(candidate["content"], "candidates[0].content")["parts"], "candidates[0].content.parts");
    return replyOfText(textOfParts(parts));
  },

  async listModels(input: DialectInput): Promise<readonly ModelListing[]> {
    const raw = await requestJson({
      url: joinPath(input.baseUrl, "/models"),
      method: "GET",
      headers: { "x-goog-api-key": input.apiKey },
      signal: input.signal,
      fetchImpl: input.fetchImpl,
      what: "模型清单",
    });
    const rows = arrayAt(objectAt(raw, "模型清单")["models"], "models");
    return listingsFrom(rows, "name", "models 里的一项").map((one) => ({
      modelId: stripPrefix(one.modelId),
      label: stripPrefix(one.modelId),
    }));
  },
};

/** 顶层 `systemInstruction` + 只剩 user/model 的 `contents`（⚠️ 这一家的角色名是 `model` 而不是 `assistant`） */
function splitSystem(messages: readonly ChatMessage[]): {
  readonly system: string | null;
  readonly turns: readonly { role: "user" | "model"; parts: readonly { text: string }[] }[];
} {
  const turns: { role: "user" | "model"; parts: readonly { text: string }[] }[] = [];
  const system: string[] = [];
  for (const one of messages) {
    if (one.role === "system") system.push(one.content);
    else turns.push({ role: one.role === "assistant" ? "model" : "user", parts: [{ text: one.content }] });
  }
  return { system: system.length === 0 ? null : system.join("\n"), turns };
}

/** 剥掉资源名前缀（⚠️ 幂等：不带前缀的 id 原样过一遍，故这一条对两种形状都对） */
function stripPrefix(name: string): string {
  return name.startsWith(NAME_PREFIX) ? name.slice(NAME_PREFIX.length) : name;
}

/** `parts` 里混着「思考」那些块（⚠️ 我们不要思考过程 —— 它会占满模型该给答案的那一格） */
function textOfParts(parts: readonly unknown[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    const obj = objectAt(part, "parts 里的一块");
    if (obj["thought"] === true) continue;
    texts.push(stringAt(obj["text"], "parts 里的 text"));
  }
  return texts.join("\n");
}