import { isModelId } from "@/lib/model-id.js";
import type { MessagePart, MessageRole } from "./dto/message.js";

export interface PartRow {
  readonly kind: string;
  readonly text: string | null;
  readonly toolCallId: string | null;
  readonly toolName: string | null;
  readonly payload: unknown;
  readonly isError: number | boolean | null;
}

export function badContentError(where: string, what: string): Error {
  return new Error(`${where} 不像本包声明的形状：${what}`);
}

function requiredText(value: string | null, where: string, column: string): string {
  if (typeof value !== "string" || value === "") throw badContentError(where, column);
  return value;
}

export function partFromRow(row: PartRow, where: string): MessagePart {
  switch (row.kind) {
    case "text":
      if (typeof row.text !== "string") throw badContentError(where, "text");
      return { type: "text", text: row.text };

    case "reasoning":
      if (typeof row.text !== "string") throw badContentError(where, "text");
      return { type: "reasoning", text: row.text };

    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: requiredText(row.toolCallId, where, "tool_call_id"),
        toolName: requiredText(row.toolName, where, "tool_name"),
        input: row.payload,
      };

    case "tool-result": {
      const isError = row.isError;
      if (isError !== 0 && isError !== 1 && typeof isError !== "boolean") {
        throw badContentError(where, "is_error");
      }
      return {
        type: "tool-result",
        toolCallId: requiredText(row.toolCallId, where, "tool_call_id"),
        toolName: requiredText(row.toolName, where, "tool_name"),
        output: row.payload,
        isError: isError === 1 || isError === true,
      };
    }

    default:
      throw badContentError(where, "kind");
  }
}

const ALLOWED_PART_TYPES: Readonly<Record<MessageRole, readonly MessagePart["type"][]>> = {
  system: ["text"],
  user: ["text"],
  assistant: ["text", "reasoning", "tool-call"],
  tool: ["tool-result"],
};

export function assertRoleParts(role: MessageRole, parts: readonly MessagePart[], where: string): void {
  const allowed = ALLOWED_PART_TYPES[role];
  for (const part of parts) {
    if (!allowed.includes(part.type)) {
      throw new Error(`${where} 的 ${role} 消息里出现了 ${part.type} 段`);
    }
  }
}

export function assertModelId(modelId: string | null, where: string): void {
  if (modelId !== null && !isModelId(modelId)) {
    throw new Error(`${where} 不是 provider/模型名 的形状`);
  }
}
