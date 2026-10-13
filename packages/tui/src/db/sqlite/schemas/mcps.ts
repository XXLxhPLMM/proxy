import { index, integer, text } from "drizzle-orm/sqlite-core";
import { MCP_TRANSPORTS } from "../../dto/mcp.js";
import { table } from "./base/table.js";

/**
 * mcps 表：MCP 服务器的**配置**清单（本地子进程与远程端点两种传输都在这张表里）
 * @description ⚠️ **这一圈的唯一真值**：不再有 `agents.mcpServers` 那份配置文件 ——
 *   两处都写就会出两份真值，而 MCP 的服务器名要进工具名 `mcp__<id>__<工具>`，撞起来极难查。
 *
 * ⚠️ **`transport` 是唯一的判别列**，其余按它互斥：`stdio` 用 `command` / `args` / `env` / `cwd`，
 *   `http` / `sse` 用 `url` / `headers`。
 * ⚠️ **表上刻意没有 CHECK 约束**：`upgrade/ddl.ts` 的重建表这一档复现不了 CHECK（照 `createTableSql`
 *   见到 checks 就抛），而结构同步只比「类型 + NOT NULL」，加了约束也不会补到已有库上 ⇒ 静默漂移。
 *   形状校验统一收在 `@/db/read.ts` 的 `mcpConfigFromRow`（一处、抛得出、看得见）。
 *
 * ⚠️ **`env` / `headers` 是 JSON 文本，且 `env` 可空**：`env` 缺席（`NULL`）与给 `{}` 在 SDK 那边
 *   **不是一回事**（前者继承它那份白名单，后者一样都不额外给），存成 `{}` 就把「继承」这档弄丢了。
 *   `args` 反过来：不存在「没有 args」这一档（`connection.ts` 直接展开它），故 NOT NULL 缺省 `[]`。
 */
export const mcps = table(
  "mcps",
  {
    /** 服务器名（主键）；形状的判据只有 `@/agents/mcp/naming.ts` 那一把，⚠️ 它同时是工具名里那一段 */
    id: text().primaryKey(),
    /** 怎么连（`MCP_TRANSPORTS` 闭合集）；其余列按它分派 */
    transport: text({ enum: MCP_TRANSPORTS }).notNull(),
    /** 启动时**不**自动起它（sqlite 无布尔，存 `0` / `1`；新建默认 `0` = 起） */
    disabled: integer({ mode: "boolean" }).notNull().default(false),
    /** stdio：可执行文件名或路径（⚠️ 只给程序名，参数一律进 {@link mcps.args}） */
    command: text(),
    /** stdio：参数，逐个给；JSON 字符串数组文本，缺省 `[]` */
    args: text().notNull().default("[]"),
    /** stdio：额外给子进程的环境变量；JSON `Record<string,string>` 文本，`NULL` = 继承 SDK 那份白名单 */
    env: text(),
    /** stdio：工作目录；`NULL` = 本进程当前目录 */
    cwd: text(),
    /** http / sse：MCP 端点 */
    url: text(),
    /** http / sse：随请求发的 HTTP 头；JSON `Record<string,string>` 文本，凭据也走这里 */
    headers: text(),
    /** 起它要等多久（毫秒）；`NULL` = 用 `connection.ts` 的缺省（30s） */
    startupTimeoutMs: integer(),
    /** 创建时刻（epoch 毫秒） */
    createdAt: integer().notNull(),
    /** 最后更新时刻（epoch 毫秒） */
    updatedAt: integer().notNull(),
  },
  // 「启动时取没 disabled 的那批（按 id 排好）」一条索引全包：等值列在前、排序列在后 ⇒ 正反扫都命中，
  // `list()` 也不用再排一次序（与 `sessions_active_updated_at_idx` 同一套写法）
  (t) => [index("mcps_disabled_id_idx").on(t.disabled, t.id)],
);

/** `mcps` 表的行：drizzle 按表结构推断的行类型。 */
export type McpRow = typeof mcps.$inferSelect;