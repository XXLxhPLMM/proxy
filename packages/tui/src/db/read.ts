import { isModelId } from "@/lib/model-id.js";
import {
  MCP_TRANSPORTS,
  type Mcp,
  type McpConnectionConfig,
  type McpDraft,
  type McpPatch,
  type McpStringMap,
  type NewMcp,
  type ResolvedMcp,
} from "./dto/mcp.js";
import type { MessagePart, MessageRole } from "./dto/message.js";
import { SESSION_STATUSES, type SessionStatus } from "./dto/session.js";

/**
 * @fileoverview 行映射与共享校验：`partFromRow` 仍是 `message_parts` 的行 → DTO（message 仍保留 DTO），
 * `requiredText` / `badContentError` 是 ops 层的共享写侧校验；provider / models 走 DTO（
 * `@/db/dto/provider.js` / `model.js`），出入参即 `Provider` / `Model`；`mcps` 那一圈是**三件事**：
 * `mcpConfigFromRow`（行 → 「怎么起这台」，那张表**唯一**的形状闸）、`mcpNewRowFromDraft` 与
 * `mcpDefinedPatch`（草稿 / patch → 与驱动写下的同形，让写面能拿候选行去过同一道闸）。
 */

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
export function requiredText(value: string | null, where: string, column: string): string {
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

/** 会话状态必须是 `SESSION_STATUSES` 闭合集之一；`null`（= 无事）放行 */
export function assertSessionStatus(status: SessionStatus | null, where: string): void {
  if (status !== null && !SESSION_STATUSES.includes(status)) throw badContentError(where, "status");
}

/** 传输列必须是 `MCP_TRANSPORTS` 闭合集之一（表外值即坏内容） */
export function assertMcpTransport(transport: string, where: string): void {
  if (!(MCP_TRANSPORTS as readonly string[]).includes(transport)) throw badContentError(where, "transport");
}

/**
 * 一行 `mcps` → 「怎么起这台」。
 * @description ⚠️ **形状的全部判据都在这一个函数里**：`transport` 决定哪几列必填、哪几列必须为空。
 *   表上没有 CHECK 约束（理由见 `schemas/mcps.ts` 文件头），所以这一层是**唯一**挡着「形状不对的行
 *   被当成配置交出去」的地方；坏内容一律抛 {@link badContentError}，不猜也不默默按缺省填。
 * @param row - `mcps` 的一行（⚠️ 必须是**与表同形**的那一行：可空列是 `null` 而不是 `undefined` ——
 *   草稿要过这道闸，先走 {@link mcpNewRowFromDraft}）
 * @param where - 指明是哪台（报错要能指到人）
 * @throws `transport` 表外 / JSON 文本坏 / 形状与 `transport` 不符 / 时限不是 ≥1 的整数：即抛
 */
export function mcpConfigFromRow(row: Mcp, where: string): ResolvedMcp {
  assertMcpTransport(row.transport, where);
  const startupTimeoutMs = startupTimeoutOf(row.startupTimeoutMs, where);
  const config: McpConnectionConfig =
    row.transport === "stdio" ? stdioConfig(row, where) : remoteConfig(row.transport, row, where);
  return startupTimeoutMs === undefined ? { config } : { config, startupTimeoutMs };
}

/**
 * 建行草稿 → **与驱动写下的那一行同形**（六个可空列补 `NULL`，两个带列缺省的补缺省值）。
 * @description ⚠️ **写面过闸之前必走这一步**：草稿里省略一个键，拿到的是 `undefined`；而驱动插进去的
 *   那个值恰恰是「不写该列 ⇒ 吃列缺省」（可空列 `NULL`、`args` `'[]'`、`disabled` `false`）。
 *   不化这一下，形状闸会把「**没写 `url`**」判成「**写了 url**」（`absent` 认的就是 `undefined !== null`），
 *   把 `undefined` 当 JSON 文本去 `JSON.parse` 而炸 ⇒ **闸跑的形状不是库里那一行，这道闸等于白设**。
 *
 * ⚠️ 它住在这里而不是 `service/`：这是一条「**drizzle 写下去的那行长什么样**」的知识，与
 *   {@link mcpConfigFromRow} 读的那份是同一件事的两头——闸在哪儿，规矩就该在哪儿；两个调用方是
 *   `db/dao/mcps.js`（谁写库都调它，免得交回半截对象）与 `@/agents/mcp/manager.js`（落库**前**拿候选行过闸）。
 * @param draft - 只有 `id` / `transport` 必填的草稿（`McpDraft`），⚠️ **`createdAt` 必须给**：
 *   本层不读时钟（`dao/` 与 `service/` 都不读），那一格由调用方给（`ctx.mcp` 填 `Date.now()`）
 * @returns 与表同形的一行（**不含 `updatedAt`**：那一格由 DAO 从 `createdAt` 填）
 */
export function mcpNewRowFromDraft(draft: McpDraft & { createdAt: number }): NewMcp {
  return {
    ...draft,
    disabled: draft.disabled ?? false,
    args: draft.args ?? "[]",
    command: draft.command ?? null,
    env: draft.env ?? null,
    cwd: draft.cwd ?? null,
    url: draft.url ?? null,
    headers: draft.headers ?? null,
    startupTimeoutMs: draft.startupTimeoutMs ?? null,
  };
}

/**
 * patch 里显式的 `undefined` 当「没给这一格」剔掉。
 * @description ⚠️ **不许把 `undefined` 送进闸**：drizzle 的 `set` 认「这一格没给」而**原样跳过**（不是写
 *   `NULL`），而合并时 `{ ...existing, ...patch }` 会让那一格变成 `undefined` ⇒ 闸读到「清空了它」、库里却
 *   根本没动。剔掉之后闸跑的形状与写完那一行才对得上。
 * @param patch - `McpPatch` 或它的去时刻版（`ctx.mcp.update` 传的是后者，时刻由它自己填），原样返回同型
 */
export function mcpDefinedPatch<T extends Partial<McpPatch>>(patch: T): T {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as T;
}

/** stdio 那一支：吃 `command` / `args` / `env` / `cwd`，而 `url` / `headers` 必须为空 */
function stdioConfig(row: Mcp, where: string): McpConnectionConfig {
  absent(row.url, where, "url");
  absent(row.headers, where, "headers");
  const env = row.env === null ? undefined : stringMap(row.env, where, "env");
  const cwd = row.cwd === null ? undefined : requiredText(row.cwd, where, "cwd");
  return {
    transport: "stdio",
    command: requiredText(row.command, where, "command"),
    args: stringArray(row.args, where, "args"),
    // ⚠️ **「不给」与「给空」不是一回事**（前者 = 继承 SDK 那份白名单），所以缺席就整格不出现
    ...(env === undefined ? {} : { env }),
    ...(cwd === undefined ? {} : { cwd }),
  };
}

/** 远程那一支（`http` / `sse`）：吃 `url` / `headers`，其余必须为空 */
function remoteConfig(transport: "http" | "sse", row: Mcp, where: string): McpConnectionConfig {
  absent(row.command, where, "command");
  absent(row.cwd, where, "cwd");
  absent(row.env, where, "env");
  // ⚠️ 远端没有子进程可传参，所以 `args` 必须是 `[]`；留着参数说明写这一行的人以为它是 stdio 那一档
  emptyArgs(row.args, where, "args");
  const headers = row.headers === null ? undefined : stringMap(row.headers, where, "headers");
  return {
    transport,
    url: requiredText(row.url, where, "url"),
    ...(headers === undefined ? {} : { headers }),
  };
}

/** 这一传输下必须缺席（`NULL`）的一列；有值就是形状错了 */
function absent(value: string | null, where: string, column: string): void {
  if (value !== null) throw badContentError(where, `${column} 在这一传输下必须为空`);
}

/** 启动时限：`NULL` = 用缺省；给了必须是 ≥1 的整数（与 `agents.maxSteps` 同一档的从严） */
function startupTimeoutOf(value: number | null, where: string): number | undefined {
  if (value === null) return undefined;
  if (!Number.isInteger(value) || value < 1) throw badContentError(where, "startup_timeout_ms 必须是 ≥1 的整数");
  return value;
}

/** JSON 文本 → 解析后的值；坏 JSON 当坏内容抛（不猜也不吞） */
function jsonOf(raw: string, where: string, column: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw badContentError(where, `${column} 不是 JSON（${reason}）`);
  }
}

/** JSON 数组文本 → 字符串数组，每项非空（空串传给 spawn 没有意义，只会拼出更难查的错） */
function stringArray(raw: string, where: string, column: string): string[] {
  const value = jsonOf(raw, where, column);
  if (!Array.isArray(value)) throw badContentError(where, `${column} 不是 JSON 数组`);
  return value.map((item, index) => {
    if (typeof item !== "string" || item === "") throw badContentError(where, `${column}[${index}] 必须是非空字符串`);
    return item;
  });
}

/** 远程那一支的 `args`：必须是 `[]`，不是就点名列出来 */
function emptyArgs(raw: string, where: string, column: string): void {
  const items = stringArray(raw, where, column);
  if (items.length !== 0) throw badContentError(where, `${column} 在远程传输下必须是 []，却有 ${items.length} 项`);
}

/**
 * JSON 对象文本 → 名字到字符串的映射。
 * @description ⚠️ **逐项重建而不是把 `JSON.parse` 的结果直接摊出去**：`Object.fromEntries` 走
 *   `CreateDataPropertyOrThrow`，而摊对象走的是赋值 —— 一个 `__proto__` 键就会改动返回对象的原型
 *   （这份 map 随后要当 `env` 递给子进程）。
 */
function stringMap(raw: string, where: string, column: string): McpStringMap {
  const value = jsonOf(raw, where, column);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badContentError(where, `${column} 不是 JSON 对象`);
  }
  const entries: [string, string][] = [];
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw badContentError(where, `${column}.${key} 必须是字符串`);
    entries.push([key, item]);
  }
  return Object.fromEntries(entries);
}
