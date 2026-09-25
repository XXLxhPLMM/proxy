/**
 * @fileoverview 路由判定：本请求的有效模式 + 直连还是交上游
 * @module core/helpers/route
 * @description
 * **有效模式唯一入口是 `resolveRoute(dest, config)`**。四个转发器（http/tunnel/
 * websocket/socks）后续分支一律读返回的 `route.mode`，**不得再裸读
 * `get("proxyMode")`**——裸读会绕过「命中路由名单即回落 server 语义」这条规则。
 *
 * 职责：
 * - `resolveRoute`：client 模式委托 `acl:checkUpstreamRoute`（黑名单命中优先 /
 *   白名单非空未命中）→ 回落 `{ mode: "server", route: "direct", reason }`；
 *   否则 `{ mode: "client", route: "upstream" }`；非 client 配置**零开销短路**（不查 upstream 组）
 * - `resolveForwardTargets`：成对给出「拨号目标 dial」与「客户端请求目标 dest」，dial 按有效模式选
 * - 类型契约：`RouteDecision` / `ForwardTargets`
 *
 * 不负责：
 * - 不解析目标（`target.ts`）、不做拨号（`forward/dial.ts`）
 * - 不打日志、不发事件：路由事实由各转发器在 preDial 通过后经 `forward/base:emitRoute` 上抛
 *
 * 依赖：`./target.js`（`TargetParts`）+ `@/core/access-control.js`（`checkUpstreamRoute` / `AclReason`）
 * + `@/config/index.js`（类型）。
 *
 * 使用示例：
 * ```ts
 * import { resolveForwardTargets } from "@/core/helpers/route.js";
 *
 * const t = resolveForwardTargets(url, req.headers.host, config);
 * if (!t) return; // 发 target-unresolved + 400
 * // t.dial 拨号；t.dest 判名单；t.route.mode 决定后续分支
 * ```
 */

import type { ConfigAccessor } from "@/config/index.js";
import { checkUpstreamRoute, type AclReason } from "@/core/access-control.js";
import { parseTargetParts, type TargetParts } from "./target.js";

/**
 * 拨号目标与客户端请求目标（client 模式两者不同：拨的是上游，名单判的是客户端要访问的站点）
 * @param dial - 实际拨号目标：有效模式为 server 即真实目标（client 配置但路由名单命中时同样直拨真实目标），
 *   有效模式为 client 才是 `upstreamHost:upstreamPort`
 * @param dest - 客户端请求的目标（与 dial 同为名单判定对象）
 * @param route - 路由判定（有效模式 + direct/upstream + 名单命中原因），调用方后续分支一律以它为准
 */
export interface ForwardTargets {
  dial: TargetParts;
  dest: TargetParts;
  route: RouteDecision;
}

/**
 * 路由判定结果：本请求的「有效模式」与「直连还是交上游」
 * @param mode - 有效模式：配置 server 恒 "server"；配置 client 命中路由名单回落 "server"（该请求按 server 语义处理）
 * @param route - server 代理模式恒 "direct"；client 模式按名单判 "direct" | "upstream"
 * @param reason - 直连且因路由名单命中时给出（blacklist / whitelist）
 */
export interface RouteDecision {
  mode: "server" | "client";
  route: "direct" | "upstream";
  reason?: AclReason;
}

/**
 * 判定请求的路由：直连（不交上游）还是经 client 上游串联
 * @description
 * - `proxyMode !== "client"` → `{ mode: "server", route: "direct" }`，**不查 upstream 组**（server 模式零开销短路）；
 * - client 模式委托 `acl:checkUpstreamRoute`：黑名单命中（优先）/ 白名单非空未命中 → 回落
 *   `{ mode: "server", route: "direct", reason }`（命中即按 server 语义处理：拨号目标/path 形态/
 *   上游凭证/Host 回写/secure 标志全部自然回落）；否则 `{ mode: "client", route: "upstream" }`。
 * - 纯函数不打日志：路由事实由各转发器在 preDial 通过后的分支处经 `emitRoute` 发事件（见 `forward/base:emitRoute`），落盘归 server 层
 * @param dest - 客户端请求的目标（名单只判 host，端口不参与）
 * @param config - 配置访问器，必须由调用方显式注入
 * @returns 路由判定
 */
export function resolveRoute(
  dest: { host: string; port: number },
  config: ConfigAccessor,
): RouteDecision {
  if (config.get("proxyMode") !== "client") {
    return { mode: "server", route: "direct" };
  }
  const r = checkUpstreamRoute(dest.host, config);
  if (r.direct) {
    return { mode: "server", route: "direct", ...(r.reason ? { reason: r.reason } : {}) };
  }
  return { mode: "client", route: "upstream" };
}

/**
 * 成对解析「拨号目标」与「客户端请求的目标」，并给出路由判定
 * @description
 * 收敛 http.handle 与 websocket.handle 逐字重复的两段三元解析：
 * - dest 先解析（绝对 URL 或 Host，与模式无关）→ `resolveRoute(dest, config)` 出有效模式 → **按有效模式选 dial**：
 *   有效 client 才拨 `UPSTREAM_*`（path 保留客户端原始 request-target，串联给上游代理必须 absolute-form），
 *   否则 dial = dest（server 配置直连；client 配置但路由名单命中同样直拨真实目标）；
 *   名单判定的永远是 `dest`，上游的协议/地址/端口只来自 `UPSTREAM_*`、**不受名单约束**
 * - 任一解析失败返回 null，由调用方发 `target-unresolved` 并回 400（与改造前两段独立判空的行为一致）
 * - 调用方拿返回的 `route.mode`（有效模式）做后续分支，**不得再裸读 `get("proxyMode")`**
 * @param url - 请求行 target（可能是绝对 URL 或 origin-form 的 path）
 * @param hostHeader - Host 请求头（origin-form 时用于解析目标）
 * @param config - 配置访问器，必须由调用方显式注入
 * @returns 一对目标 + 路由判定，解析失败返回 null
 * @example resolveForwardTargets("http://a.com/x", "a.com", config)
 * // => { dial: {upstream...}, dest: {a.com...}, route: {mode:"client", route:"upstream"} }
 */
export function resolveForwardTargets(
  url: string | undefined,
  hostHeader: string | undefined,
  config: ConfigAccessor,
): ForwardTargets | null {
  const dest = parseTargetParts(url ?? "", hostHeader);

  if (!dest) {
    return null;
  }

  const route = resolveRoute(dest, config);

  if (route.mode === "client") {
    return {
      dial: {
        host: config.get("upstreamHost"),
        port: config.get("upstreamPort"),
        path: url ?? "/",
      },
      dest,
      route,
    };
  }

  return { dial: dest, dest, route };
}
