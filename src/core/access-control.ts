/**
 * @fileoverview 访问控制判定：把 acl.json 的三组名单翻译成「放行 / 拒绝 / 直连」
 * @module core/access-control
 * @description
 * 本模块是**请求期策略层**，与 config 侧严格三层分离：
 * - 条目规则层 `@/config/files/rules/`（`ip.ts`/`host.ts`）：条目语法的解析/编译/匹配，纯函数
 * - 数据层 `src/config/files/acl.ts`：读文件、校验结构、返回合法的 `AclConfig`
 * - 本模块（策略层）：编译结果按 accessor 记忆，并在每次请求上判定，不认识文件与 IO
 *
 * 三个判定入口：
 * - `checkClientIp(addr, config)`：入站对端 IP（TCP `socket.remoteAddress`，不看 XFF）
 * - `checkTargetHost(host, config)`：出站目标主机（客户端请求的 host 字符串，不做 DNS）
 * - `checkUpstreamRoute(host, config)`：client 模式路由（直连还是交上游）
 *
 * 判定语义：
 * - clientIp / target 两组：黑名单命中 → 拒绝（优先）；白名单非空且未命中 → 拒绝；皆空 → 放行
 * - upstream 组动作相反：黑名单命中 → 直连（优先）；白名单非空且未命中 → 直连；
 *   皆空（含整组缺失）→ 走上游。真值表：走上游 ⇔ 命中 whitelist ∧ 未命中 blacklist；
 *   仅 `PROXY_MODE=client` 有意义，server 模式由 `helpers/route:resolveRoute` 短路
 *
 * 设计要点：
 * - 编译结果按 `ConfigAccessor` 记忆（`WeakMap`），快照未变即复用，只读共享、多会话并发安全
 * - 零日志：拒绝/路由事实由调用方经 pipe 事件上抛，落盘收在 `src/server`
 * - 配置经端口注入：所有入口的 `config` 必填，不依赖任何全局配置
 *
 * 使用示例：
 * ```ts
 * import { checkClientIp, checkTargetHost } from "@/core/access-control.js";
 *
 * const ip = checkClientIp(socket.remoteAddress ?? "unknown", config);
 * if (!ip.allowed) {
 *   // reason === "blacklist" | "whitelist"
 * }
 * const target = checkTargetHost(host, config);
 * ```
 */

import {
  loadAcl,
  readAcl,
  type AclConfig,
  type ConfigAccessor,
} from "@/config/index.js";
import { compileHostRules, hostMatches, type HostMatcher } from "@/config/files/rules/index.js";
import { compileIpRules, ipMatches, type IpRule } from "@/config/files/rules/index.js";
import type { JsonFileEvent } from "@/utils/json-file/index.js";

/** 拒绝原因：命中黑名单 / 不在白名单内 */
export type AclReason = "whitelist" | "blacklist";

/** 判定结果 */
export interface AclDecision {
  allowed: boolean;
  reason?: AclReason;
}

/** 路由判定结果：direct = 直连（不交上游），非 direct = 走上游 */
export interface UpstreamRouteDecision {
  direct: boolean;
  reason?: AclReason;
}

/** 编译后的判定素材（按快照身份记忆，避免每连接重复编译） */
interface CompiledAcl {
  source: AclConfig;
  clientIpWhitelist: IpRule[];
  clientIpBlacklist: IpRule[];
  targetWhitelist: HostMatcher;
  targetBlacklist: HostMatcher;
  upstreamWhitelist: HostMatcher;
  upstreamBlacklist: HostMatcher;
}

const EMPTY_MATCHER: HostMatcher = { ip: [], exact: new Set<string>(), wildcards: [] };

const compiledCaches = new WeakMap<ConfigAccessor, CompiledAcl>();
const fileEventHandlers = new WeakMap<ConfigAccessor, (event: JsonFileEvent) => void>();

/**
 * 为当前 accessor 绑定 ACL 文件状态观察面；返回幂等退订函数。
 * @description 判定路径每请求读名单，观察面由 runtime 显式注入（logger 由组合层决定），
 * 不同 accessor 各记一份，实例之间互不干扰。
 */
export function bindAclFileEvents(
  config: ConfigAccessor,
  onEvent: (event: JsonFileEvent) => void,
): () => void {
  fileEventHandlers.set(config, onEvent);
  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    if (fileEventHandlers.get(config) === onEvent) {
      fileEventHandlers.delete(config);
    }
  };
}

/**
 * 取编译结果；源快照未变则直接复用（只读共享，多会话并发安全）
 * @param config - 配置访问器（决定读哪份 `aclFile`）
 * @description 每个 accessor 独立记忆一份编译结果；文件内容快照不变时复用，
 * 多 runtime 交替判定不会互相挤掉缓存或串用名单。
 */
function compiled(config: ConfigAccessor): CompiledAcl {
  const acl = readAcl({ config, onEvent: fileEventHandlers.get(config) }).value;
  const cached = compiledCaches.get(config);
  if (cached?.source === acl) {
    return cached;
  }
  const next: CompiledAcl = {
    source: acl,
    clientIpWhitelist: compileIpRules(acl.clientIp.whitelist) ?? [],
    clientIpBlacklist: compileIpRules(acl.clientIp.blacklist) ?? [],
    targetWhitelist: compileHostRules(acl.target.whitelist) ?? EMPTY_MATCHER,
    targetBlacklist: compileHostRules(acl.target.blacklist) ?? EMPTY_MATCHER,
    upstreamWhitelist: compileHostRules(acl.upstream.whitelist) ?? EMPTY_MATCHER,
    upstreamBlacklist: compileHostRules(acl.upstream.blacklist) ?? EMPTY_MATCHER,
  };
  compiledCaches.set(config, next);
  return next;
}

/** 匹配器是否为空（空白名单 = 不做白名单限制） */
function isEmptyMatcher(m: HostMatcher): boolean {
  return m.ip.length === 0 && m.exact.size === 0 && m.wildcards.length === 0;
}

/**
 * 判定客户端来源是否放行
 * @description 只认 TCP 对端地址（由调用方经 socket.remoteAddress 取得），不看 X-Forwarded-For；
 * 地址取不到（"unknown"）且配了白名单时判否（fail-closed）
 * @param addr - 客户端对端地址
 * @param config - 必填配置访问器
 * @returns 判定结果
 */
export function checkClientIp(addr: string, config: ConfigAccessor): AclDecision {
  const c = compiled(config);
  if (ipMatches(addr, c.clientIpBlacklist)) {
    return { allowed: false, reason: "blacklist" };
  }
  if (c.clientIpWhitelist.length > 0 && !ipMatches(addr, c.clientIpWhitelist)) {
    return { allowed: false, reason: "whitelist" };
  }
  return { allowed: true };
}

/**
 * 判定目标主机是否放行
 * @description 目标为 IP 字面量时只可能命中 IP/CIDR 条目；为域名时只可能命中精确/通配域名条目
 * @param host - 客户端请求的目标主机（域名或 IP，可带方括号）
 * @param config - 必填配置访问器
 * @returns 判定结果
 */
export function checkTargetHost(host: string, config: ConfigAccessor): AclDecision {
  const c = compiled(config);
  if (hostMatches(host, c.targetBlacklist)) {
    return { allowed: false, reason: "blacklist" };
  }
  if (!isEmptyMatcher(c.targetWhitelist) && !hostMatches(host, c.targetWhitelist)) {
    return { allowed: false, reason: "whitelist" };
  }
  return { allowed: true };
}

/**
 * 判定 client 模式下目标主机应直连还是交上游
 * @description
 * 仅 `PROXY_MODE=client` 有意义（server 模式由 `core/helpers/route:resolveRoute` 短路，不进本函数）；
 * 条目语法与 target 组同形（kind "host"）：IP/CIDR/域名/`*.域名`，不支持端口、不做 DNS；
 * 语义与前两组动作相反——黑名单命中 → 直连（优先）；白名单非空且未命中 → 直连；皆空（含整组缺失）→ 走上游。
 * 真值表：走上游 ⇔ 命中 whitelist ∧ 未命中 blacklist，其余一律直连
 * @param host - 客户端请求的目标主机（域名或 IP，可带方括号）
 * @param config - 必填配置访问器
 * @returns 是否直连；因名单命中直连时带 reason（blacklist / whitelist）
 * @example checkUpstreamRoute("a.com", config) // blacklist 命中 → { direct: true, reason: "blacklist" }
 */
export function checkUpstreamRoute(host: string, config: ConfigAccessor): UpstreamRouteDecision {
  const c = compiled(config);
  if (hostMatches(host, c.upstreamBlacklist)) {
    return { direct: true, reason: "blacklist" };
  }
  if (!isEmptyMatcher(c.upstreamWhitelist) && !hostMatches(host, c.upstreamWhitelist)) {
    return { direct: true, reason: "whitelist" };
  }
  return { direct: false };
}

/** 重新导出名单读取面，便于调用方只 import 一处即可完成「读 + 判」。 */
export { loadAcl, readAcl };
export type { AclConfig, AclList } from "@/config/index.js";
