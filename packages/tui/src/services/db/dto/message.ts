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
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export interface ToolResultPart {
  readonly type: "tool-result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: unknown;

  readonly isError: boolean;
}

export interface Message {
  readonly id: string;
  readonly sessionId: string;

  readonly seq: number;
  readonly role: MessageRole;

  readonly modelId: ModelId | null;
  readonly parts: readonly MessagePart[];

  readonly createdAt: number;
}
