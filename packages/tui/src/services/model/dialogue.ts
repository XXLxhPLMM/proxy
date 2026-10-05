/** @fileoverview 模型看得见的那一面：对话怎么变成消息、模型回的那一行怎么变成一条 `Command` */

import { COMMAND_PREFIX, parseLine, type Command } from "@/commands/index.js";
import type { Turn } from "@/lib/log/index.js";
import { ModelError, type ChatMessage, type ModelReply } from "./types.js";

/** 模型看得见的历史长度上限（⚠️ **对话桶是 2000 条的环形缓冲**，而请求体只有那么大；超了从**最早**那几条开始丢） */
export const HISTORY_LIMIT = 40;

/** 对话 → 模型看得见的那几段（只给 `user` / `assistant` 两档） */
// ⚠️ `tool-*` 是**本包与控制面之间**的私事（账号名、配额、地址）；而 `error` **刻意不给**：
// 把失败原文喂回模型等于让它模仿一句假事实
export function messagesOf(history: readonly Turn[], tools: string): readonly ChatMessage[] {
  const out: ChatMessage[] = [
    {
      role: "system",
      content:
        "你是一个终端助手的规划器。你唯一能做的事是挑一条命令并填好它的参数；" +
        "你不能自己发请求，也不能编造命令表以外的东西。" +
        tools +
        `选好了就只回一行 ${COMMAND_PREFIX}<命令> <参数…>（不要解释）；` +
        "想直接回答就只回那一句回答本身。",
    },
  ];
  for (const turn of history.slice(-HISTORY_LIMIT)) {
    if (turn.kind === "user") out.push({ role: "user", content: turn.text });
    if (turn.kind === "assistant") out.push({ role: "assistant", content: turn.text });
  }
  return out;
}

/** 模型回复 → 一条 `Command`（**逐字再解析一遍**：⚠️ 模型输出**不是**可信输入） */
// ⚠️ 而 `parseLine` 就是那份**唯一的**命令表判据 —— 模型说什么都得过它
// @throws {ModelError} `shape`：不是一条命令 / 那条命令不存在 / 参数不对
export function commandOfReply(text: string): Command {
  const line = text.trim().split("\n").find((one) => one.trim().startsWith(COMMAND_PREFIX));
  if (line === undefined) {
    throw new ModelError("shape", "模型没有给出以 / 开头的一行（它大概是在闲聊）");
  }
  const parsed = parseLine(line.trim());
  if (parsed.kind !== "ok") {
    // ⚠️ **只转述判据不转述输入**：模型的话会落进可滚动的结果区，而那句话里可能有用户敲的内容
    // ⚠️ `empty` 单独一档：它是「没有内容」而不是「内容不合法」，两者的处置动作不同（前者让模型重挑，后者让用户改问）
    throw new ModelError(
      "shape",
      parsed.kind === "empty"
        ? "模型给的是一行空的"
        : `模型给的那条命令过不了解析（${parsed.kind}）：${parsed.message}`,
    );
  }
  return parsed.command;
}

/** 一段文本 → {@link ModelReply}（⚠️ 三个方言答回来的都是「一段文本」，故这一档是三家共用的） */
export function replyOfText(content: string): ModelReply {
  const text = content.trim();
  if (text.startsWith(COMMAND_PREFIX)) {
    // ⚠️ **不 trim 掉那条命令**：模型那一行就是命令，逐字交给 {@link commandOfReply} 判
    return { kind: "command", line: text };
  }
  return { kind: "text", text };
}