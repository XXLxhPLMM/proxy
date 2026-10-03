/**
 * @fileoverview 控制面**端点表**（⚠️ 手抄的弱耦合，不 import 服务端那份，见包级 AGENTS.md）
 * @module api/endpoints
 * @description
 * 表里每条 `(method, path)` 都必须与根仓 `src/manager/routes/index.ts` 文件头那张表相等；牙齿在根仓
 * `tests/unit/manager-tui-contract.test.ts`（从**两侧源码文本**现取再比集合，不从任何一侧 import）。`:username` 是
 * **模板**，真发请求时经 {@link endpointPath} 代入并编码。
 *
 * @module
 */

/** HTTP 动词（只用控制面用到的四种；表外的动词在服务端一律 405） */
export type Method = "GET" | "POST" | "PUT" | "DELETE";

/** 一条端点 */
export interface Endpoint {
  readonly method: Method;
  /** 路径；含 `:username` 段的是**模板** */
  readonly path: string;
}

/** 端点表（顺序与服务端 `managerRoutes()` 一致，让 diff 可读；判据是集合相等） */
export const ENDPOINTS: readonly Endpoint[] = [
  { method: "GET", path: "/api/status" },
  { method: "GET", path: "/api/config" },
  { method: "GET", path: "/api/users" },
  { method: "GET", path: "/api/users/:username" },
  { method: "POST", path: "/api/users" },
  { method: "PUT", path: "/api/users/:username" },
  { method: "DELETE", path: "/api/users/:username" },
  { method: "GET", path: "/api/acl" },
  { method: "POST", path: "/api/acl" },
  { method: "DELETE", path: "/api/acl" },
  { method: "GET", path: "/api/usage" },
  { method: "GET", path: "/api/usage/:username" },
];

/**
 * 把模板里的 `:username` 段代入真实值
 * @description ⚠️ **判「模板里有没有这个段」与替换必须用同一条整段判据**：用 `includes(":username")` 判、逐段
 * 替换，会让 `:usernames` 这种含子串的段名通过校验却原样返回 —— 一条「判据说有、实际没换」的路径。
 *
 * ⚠️ **代入必须编码**（控制面 decode 之后才判字符白名单），而**本端不发明字符白名单**：`encodeURIComponent` 不
 * 转义 `.`，所以 `..` 会原样穿过；闸门在服务端 `requireSafeUsername`。后果要记住：`fetch` 的 URL 解析会把
 * `/api/users/..` 消解成 `/api/`，症状是 404。
 *
 * @param template - 表里那条 `path`（含 `:username`）
 * @param username - 账号名
 * @throws {Error} 模板里没有 `:username` **段**（调用方传错了模板，不是运行期数据问题）
 * @example endpointPath("/api/users/:username", "al ice") // => "/api/users/al%20ice"
 */
export function endpointPath(template: string, username: string): string {
  const segments = template.split("/");
  if (!segments.includes(":username")) {
    throw new Error(`端点模板 ${template} 里没有 :username 段`);
  }
  const encoded = encodeURIComponent(username);
  // 逐段替换：只动 `:username` 这个段，不碰别的段里恰好出现的同名字面量
  return segments.map((seg) => (seg === ":username" ? encoded : seg)).join("/");
}