/**
 * @fileoverview 控制面**端点表**（本包对 `@b-hole/proxy` HTTP 契约的完整声明）
 * @module client/endpoints
 * @description
 * 这张表是本包与控制面之间的**契约**：每一个 `(method, path)` 都必须与
 * `src/manager/routes/index.ts` 文件头那张表逐条相等。两份各写一遍是不可接受的 ——
 * 控制面加端点时漏改这里，本包就少一个功能；本包写了控制面没有的端点，本包就会对着一个
 * 永远 404 的路径发请求，而两边都「绿」。
 *
 * 牙齿在仓库根的 `tests/unit/manager-tui-contract.test.ts`：它**分别从两侧源码里现取**
 * `(method, path)` 再比集合（不从任何一侧 import，避免跨包耦合），少一条 / 多一条 / 拼错
 * 方法名都会红。
 *
 * ## 为什么**不 import** `@b-hole/proxy` 来共享契约
 * @description
 * 本包与控制面之间是**网络边界**：本包连的是别的机器上那个进程，而那个进程可能跑的是**旧版本**
 * 的 `@b-hole/proxy`。跨包 import 共享契约会把「网络两端版本可以不同」这件事抹掉，而那正是
 * 运维最需要知道的现实。因此这里的形状是**手抄的、有测试兜着的**，而不是编译期绑定的 ——
 * 这是刻意选的弱耦合，不是疏忽。
 *
 * ## `:username` 是**模板**，不是 URL
 * @description
 * 表里存 `/api/users/:username`，真发请求时经 {@link endpointPath} 代入并
 * `encodeURIComponent`。⚠️ 代入**必须**编码：控制面在路由层 `decodeURIComponent` 之后才判形状，
 * 而它的 username 白名单窄到 `[A-Za-z0-9._-]` —— 不编码等于给穿越留了一条路。
 */

/** HTTP 动词（只用控制面用到的四种；表外的动词在服务端一律 405） */
export type Method = "GET" | "POST" | "PUT" | "DELETE";

/** 一条端点 */
export interface Endpoint {
  readonly method: Method;
  /** 路径；含 `:username` 段的是**模板** */
  readonly path: string;
}

/**
 * 端点表 —— **与 `src/manager/routes/index.ts` 的端点表互锁的那个副本**
 * @description 顺序即服务端 `managerRoutes()` 的装配顺序；⚠️ 顺序本身不是契约的一部分
 * （判据是集合相等），但保持一致让 diff 可读。
 */
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
 * @description
 * 逐段 `encodeURIComponent` —— 服务端在 decode 之后才判字符白名单，本端不编码就是把
 * 「一个 `../` 拼进路径」这件事交给运气。
 *
 * ⚠️ **判「模板里有没有这个段」与替换必须用同一条判据**（都是**整段**相等）。
 * 用 `template.includes(":username")` 判、逐段替换，会让 `:usernames` 这种含子串的段名通过校验
 * 却原样返回 —— 那是一条「判据说有、实际没换」的路径，调用方拿到一个带占位符的真实 URL。
 *
 * ⚠️ **`encodeURIComponent` 不转义 `.`**，所以 `..` 会原样穿过本端。这**是对的**：真正的闸门在
 * 服务端 `requireSafeUsername`（白名单 `[A-Za-z0.9._-]` 之外的直接 400），而在本端再发明一份
 * 字符集会与服务端漂。但要知道后果：`fetch` 的 URL 解析会把 `/api/users/..` **消解**成
 * `/api/`，于是症状是 404 而不是 400 —— 排查时先怀疑地址，别怀疑权限。
 *
 * @param template - 表里那条 `path`（含 `:username`）
 * @param username - 账号名
 * @returns 可直接拼到 base URL 后的路径（以 `/` 开头）
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
