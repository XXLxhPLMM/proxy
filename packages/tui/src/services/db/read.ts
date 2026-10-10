import { isModelId } from "@/lib/model-id.js";
import type { MessagePart, MessageRole } from "./dto/message.js";

/** 一条 `message_parts` 行（各段类型只用到自己那几列） */
export interface PartRow {
  /** `MESSAGE_PART_KINDS` 之一；表外值即坏内容 */
  readonly kind: string;
  /** text / reasoning 段的正文 */
  readonly text: string | null;
  /** 工具调用的关联 id（tool-call / tool-result 段用） */
  readonly toolCallId: string | null;
  /** 工具名（tool-call / tool-result 段用） */
  readonly toolName: string | null;
  /** 工具入参 / 工具结果的原样 JSON（tool-call / tool-result 段用） */
  readonly payload: unknown;
  /** 工具结果是否失败（tool-result 段用）；sqlite 无布尔，`0` / `1` 或 boolean */
  readonly isError: number | boolean | null;
}

/** 坏内容（行与本包 DTO 声明的形状不符）的统一抛法；`where` 指明是哪条记录 */
export function badContentError(where: string, what: string): Error {
  return new Error(`${where} 不像本包声明的形状：${what}`);
}

/** 必填文本列：`null` 与空串都按坏内容抛 */
function requiredText(value: string | null, where: string, column: string): string {
  if (typeof value !== "string" || value === "") throw badContentError(where, column);
  return value;
}

/** 一行 message_parts → 一个 `MessagePart`；`kind` 表外或该段列缺失即抛 */
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

/** 按角色检查段类型集合（system 只许 text、tool 只许 tool-result…），越界即抛 */
export function assertRoleParts(role: MessageRole, parts: readonly MessagePart[], where: string): void {
  const allowed = ALLOWED_PART_TYPES[role];
  for (const part of parts) {
    if (!allowed.includes(part.type)) {
      throw new Error(`${where} 的 ${role} 消息里出现了 ${part.type} 段`);
    }
  }
}

/** 列非空时必须是 `provider/model` 形状；`null` 放行 */
export function assertModelId(modelId: string | null, where: string): void {
  if (modelId !== null && !isModelId(modelId)) {
    throw new Error(`${where} 不是 provider/模型名 的形状`);
  }
}
