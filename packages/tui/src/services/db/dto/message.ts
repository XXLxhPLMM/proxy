import type { ModelId } from "@/lib/model-id.js";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export const MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Assert<T extends true> = T;

export type MessageRolesMatchDto = Assert<Exact<(typeof MESSAGE_ROLES)[number], MessageRole>>;

export type MessagePart = TextPart | ReasoningPart | ToolCallPart | ToolResultPart;

export const MESSAGE_PART_KINDS = ["text", "reasoning", "tool-call", "tool-result"] as const;

export type MessagePartKind = (typeof MESSAGE_PART_KINDS)[number];

export type MessagePartKindsMatchDto = Assert<Exact<MessagePartKind, MessagePart["type"]>>;

export interface TextPart {
  readonly type: "text";
  readonly text: string;
}

export interface ReasoningPart {
  readonly type: "reasoning";
  readonly text: string;
}

export interface ToolCallPart {
  readonly type: "tool-call";
  /** 这次工具调用的关联 id：与对应 `tool-result` 的 `toolCallId` 配对 */
  readonly toolCallId: string;
  readonly toolName: string;
  /** 模型给工具的入参（原样 JSON，本包不判形） */
  readonly input: unknown;
}

export interface ToolResultPart {
  readonly type: "tool-result";
  /** 与对应 `tool-call` 配对的那个 id */
  readonly toolCallId: string;
  readonly toolName: string;
  /** 工具返回的内容（原样 JSON，本包不判形） */
  readonly output: unknown;

  /** 这次工具调用是否以失败收场 */
  readonly isError: boolean;
}

export interface Message {
  readonly id: string;
  readonly sessionId: string;

  /** 同一会话内的顺序号（与 `sessionId` 组成主键，消息按它定序） */
  readonly seq: number;
  readonly role: MessageRole;

  /** 这条消息关联的模型（可为 `null`）；会话当前选中的模型住 `Session.modelId` */
  readonly modelId: ModelId | null;
  readonly parts: readonly MessagePart[];

  /** 写入时刻（epoch 毫秒） */
  readonly createdAt: number;
}
