/** @fileoverview 按 `api` 分派到那份方言（⚠️ 这是模型那一侧对**上**的唯一出口） */

import { anthropic } from "./anthropic.js";
import { gemini } from "./gemini.js";
import { openai } from "./openai.js";
import type { DialectInput, ModelDialect, ModelListing, ModelReply } from "./types.js";

/** 三份方言的唯一去处（⚠️ 加一种 API 格式只改这一张表 —— 别处不许长出第二份分派） */
const DIALECTS: Readonly<Record<DialectInput["api"], ModelDialect>> = {
  openai,
  anthropic,
  gemini,
};

/** 发一次请求、收一条回复（⚠️ **这是全包第二次出网** —— 第一次是 `manager-client.ts` 的控制面拨号） */
// ⚠️ 系统提示的位置由各方言自己归位，而**凭据只往 provider 去** —— 一步都不出这个目录
export async function askModel(input: DialectInput): Promise<ModelReply> {
  return DIALECTS[input.api].ask(input);
}

/** 从该提供商的 `/models` 端点拉模型清单（⚠️ 路径与 id 抽取各家不同，故它**不是** `ask` 的副产品） */
export async function listProviderModels(input: DialectInput): Promise<readonly ModelListing[]> {
  return DIALECTS[input.api].listModels(input);
}