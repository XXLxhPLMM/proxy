/**
 * @fileoverview MCP 工具契约 —— 「模型能看到什么」与「一次工具调用交回什么」
 * @module protocol/types
 * @description
 * 纯类型、零 IO、零判据。`src/tools/` 照着 {@link ToolDefinition} 写工具，`src/protocol/server.ts`
 * 照着 {@link ToolResult} 组响应 —— 两边共用这一份词汇，避免「工具以为协议层长什么样」与实际漂移。
 *
 * ⚠️ **失败的方向是单向的**：handler 失败**抛**，绝不让它自己拼 `content` / `isError`。
 * 那是协议层的职责（它才知道 `isError` 的形状、以及失败文本该走 `McpError.toReport()`）。
 * 多一份拼法就多一处能漂的地方，而漂了的失败路径只有模型会替我们发现。
 */

/**
 * JSON Schema 的最小子集
 * @description ⚠️ 只声明 MCP 工具入参真正需要的那几种：`type` / `properties` / `required`
 * 加上属性上的 `description` / `enum` / `items`。
 *
 * 代价要认：这不是 JSON Schema，是它的一份**投影** —— 没有 `anyOf` / `$ref` / `additionalProperties`，
 * 也不做校验。工具的入参正确性由 **handler 自己**保证（它拿到的 `args` 已经是 `Record<string, unknown>`），
 * 这里声明的形状只是给模型看的**说明书**。
 * 反过来说，正因为它不承担校验，就不能为了「让类型更好看」把入参往里收窄成具体类型：
 * 那样等于把模型能传的东西在编译期偷偷砍掉。
 */
export interface JsonSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonSchemaProperty>>;
  readonly required?: readonly string[];
}

/** 一个入参项；⚠️ `array` 只要求 `items`（MCP 工具里没有不定长异构数组的实际用法） */
export interface JsonSchemaProperty {
  readonly type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  readonly description?: string;
  readonly enum?: readonly (string | number)[];
  readonly items?: JsonSchemaProperty;
}

/** 一个工具的全部；⚠️ `handler` 的返回值就是给模型看的**原文**，协议层不解释、不包装 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** 成功 ⇒ 回给模型的文本；失败 ⇒ **抛**（协议层 catch 后转成 isError 的 tool result） */
  readonly handler: (args: Readonly<Record<string, unknown>>) => Promise<string>;
}

/** tool result 的一段内容；⚠️ 本包只产出 `text` 一种 —— 没有任何工具需要结构化 / 图像 / 资源 */
export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

/**
 * tool result 的形状（MCP 契约）
 * @description ⚠️ `isError` **成功时不存在**（而不是 `false`）：它是「这次调用失败了」的标记，
 * 模型靠**字段在不在**判断，而一份恒带 `isError: false` 的结果会逼消费方多写一次分支。
 */
export interface ToolResult {
  readonly content: readonly TextContent[];
  readonly isError?: boolean;
}