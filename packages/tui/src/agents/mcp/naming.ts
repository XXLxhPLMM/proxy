/**
 * @fileoverview MCP 工具的命名：`<服务器名>` + `<工具名>` → 注册表认的那一个键
 * @module agents/mcp/naming
 * @description
 * 模型看到的工具名 = `mcp__<服务器名>__<工具名>`（Claude Code 的约定）。**前缀不是装饰**：不带它，
 * 两台互不相识的服务器各给一条 `search` 就会在 `registerTool` 上撞成重名（它对重名是**抛**，
 * 不是覆盖）⇒ 谁先登记谁好，另一台整台哑掉，而用户看到的现象是「某台服务器的工具全没了」。
 *
 * ⚠️ 服务器名**不许含 `__`**（{@link SERVER_NAME_PATTERN} 挡住）：前缀靠它分界，含了的话
 *   服务器 `a` + 工具 `b__c` 与服务器 `a__b` + 工具 `c` 会拼出同一个键，可分性就没了。
 *   工具名那一段来自第三方服务器，本模块管不着 ⇒ 拼完再过一遍 {@link isRegistrableToolName}。
 *
 * ⚠️ 本模块**零依赖**（不 import 任何东西，cordis 也不 import）：`config/agents/parse.ts` 要拿
 *   {@link SERVER_NAME_PATTERN} 校验配置里的服务器名，让「配置里的名字」与「拼出来的工具名」
 *   只有这一处出处。改规则只改这里。
 */

/** 拼工具名的前缀；固定以它开头，对应 {@link isRegistrableToolName} 末尾那条「结构上不可能」的说明 */
const PREFIX = "mcp";

/** 服务器名与工具名之间的分隔符（与 {@link PREFIX} 后那两个下划线同形） */
const SEPARATOR = "__";

/**
 * 服务器名的形状：**不许含 `__`**，其余为「字母或数字开头 + 字母数字 / `_` / `.` / `-`」。
 * @description 两条硬要求各有出处：不得含 `__` 是为了 {@link mcpToolName} 拼出来的键可分；
 *   不许空白是 `registerTool` 会拒收带空白的名字（见 `@/agents/tools/index.js`）。
 *   @example
 *   ```ts
 *   SERVER_NAME_PATTERN.test("github");   // true
 *   SERVER_NAME_PATTERN.test("my_server");// true —— 单个下划线可以
 *   SERVER_NAME_PATTERN.test("my__server"); // false —— 双下划线会把前缀分界搅乱
 *   SERVER_NAME_PATTERN.test("my server");  // false
 *   ```
 */
export const SERVER_NAME_PATTERN = /^(?!.*__)[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 名字能不能当配置里的服务器名；不能的话 {@link SERVER_NAME_PATTERN} 之外的原因都算不合法 */
export function isValidServerName(name: string): boolean {
  return SERVER_NAME_PATTERN.test(name);
}

/**
 * 把一台服务器的一条工具拼成注册表认的键：`mcp__<服务器名>__<工具名>`
 * @description 拼完**不保证**合法（工具名是第三方给的），合法性由 {@link isRegistrableToolName} 判。
 */
export function mcpToolName(server: string, tool: string): string {
  return `${PREFIX}${SEPARATOR}${server}${SEPARATOR}${tool}`;
}

/**
 * 拼出来的名字能不能交给 `registerTool`。
 * @description ⚠️ `registerTool` 还挡「`Object.prototype` 上的键」这一档，**在这里结构上不可能**：
 *   名字恒以 `mcp__` 开头，而 `Object.prototype` 上没有这样的键。别为了「对齐」把那个死分支抄回来。
 */
export function isRegistrableToolName(name: string): boolean {
  return name !== "" && !/\s/.test(name);
}