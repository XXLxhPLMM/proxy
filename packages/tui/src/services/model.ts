/** @fileoverview 模型那一侧：**唯一**一次出网的请求（去 provider 而不是去控制面） */
// ⚠️ 模型**拿不到** `ManagerClient` —— 这个模块不认识控制面：不知道 token、不知道端点

import { COMMAND_PREFIX, parseLine, type Command } from "@/commands/index.js";
import type { Turn } from "@/lib/log/index.js";

/** 模型看得见的那一格对话（⚠️ **凭据那一列被挖空了** —— 理由与实现在 {@link messageOf}） */
export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** 模型回复的两种形态（判别联合，不是「可选字段」） */
export type ModelReply =
  /** 模型直接给了答案，不调工具 */
  | { readonly kind: "text"; readonly text: string }
  /** 模型要调一条命令；⚠️ `line` **必须**逐字再过一遍 `@/commands/parse.js` */
  | { readonly kind: "command"; readonly line: string };

/** 一次模型往返的失败（⚠️ 分档与 `TuiError` 同形：**「对面没答上」与「形状不对」是两件事**） */
export class ModelError extends Error {
  public readonly code: "unreachable" | "shape";

  public constructor(code: "unreachable" | "shape", message: string) {
    super(message);
    this.name = "ModelError";
    this.code = code;
  }
}

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

/** 模型拿到的那份工具说明（⚠️ **由调用方给**（它从 `@/commands` 的表算出），而本模块不认命令表 —— 见文件头） */

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

/** provider 那一侧要用的参数（⚠️ **凭据就在这里**，故本类型不许进日志 / 错误文案） */
export interface ModelEndpoint {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}

/** 发一次请求、收一条回复（⚠️ **这是全包第二次出网**——第一次是 `manager-client.ts` 的控制面拨号） */
export async function askModel(
  endpoint: ModelEndpoint,
  messages: readonly ChatMessage[],
  signal: AbortSignal,
): Promise<ModelReply> {
  // ⚠️ **不是 `ManagerClient`**：那个 class 会把 token 装进请求头，而它认的是 `ENDPOINTS`；
  // 用它去问模型等于「模型能借控制面的凭据打控制面」—— 模型绝不许拿到 `ManagerClient`
  const url = `${endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // ⚠️ 凭据**只**在这一行出现，而这一行只往 provider 去（`baseUrl` 来自库，用户自己配的）
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: JSON.stringify({ model: endpoint.model, messages }),
      signal,
    });
  } catch (err) {
    throw new ModelError("unreachable", `连不上模型（${describe(err)}）`);
  }
  if (!response.ok) {
    // ⚠️ **不转述响应体**：它可能回显了请求里的东西，而请求里有那句用户输入
    throw new ModelError("shape", `模型那边回了 HTTP ${String(response.status)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text()) as unknown;
  } catch {
    throw new ModelError("shape", "模型的回答不是 JSON");
  }
  return replyOf(parsed);
}

/** 响应体 → {@link ModelReply}（⚠️ 判据是**逐字段**的：一个都不过就是 `shape` 档，不是「尽力取一个」 */
function replyOf(raw: unknown): ModelReply {
  if (typeof raw !== "object" || raw === null) {
    throw new ModelError("shape", "模型的回答不是一个 JSON 对象");
  }
  const choices = (raw as Record<string, unknown>)["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ModelError("shape", "模型的回答里没有 choices");
  }
  const first = choices[0];
  if (typeof first !== "object" || first === null) {
    throw new ModelError("shape", "choices[0] 不是对象");
  }
  const message = (first as Record<string, unknown>)["message"];
  if (typeof message !== "object" || message === null) {
    throw new ModelError("shape", "choices[0].message 不是对象");
  }
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content !== "string") {
    throw new ModelError("shape", "choices[0].message.content 不是字符串");
  }
  const text = content.trim();
  if (text.startsWith(COMMAND_PREFIX)) {
    // ⚠️ **不 trim 掉那条命令**：模型那一行就是命令，逐字交给 {@link commandOfReply} 判
    return { kind: "command", line: text };
  }
  return { kind: "text", text };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}