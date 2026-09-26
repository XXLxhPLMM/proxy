/**
 * ACL 判定引擎 - 编译缓存 + 三个判定入口
 *
 * 本模块是 ACL 子系统对外的**运行时**接口：把 `reader.ts` 给出的快照编译成
 * 判定素材（IP 规则 / host 匹配器），并按快照对象身份记忆编译结果，命中后不再
 * 重建。三个判定入口分别是：
 * - `checkClientIp`      入站对端 IP 是否放行
 * - `checkTargetHost`    出站目标主机是否放行
 * - `checkUpstreamRoute` client 模式路由：直连还是交上游
 *
 * 判定对象永远是「客户端请求的目标」或「TCP 对端地址」，上游地址永不进名单。
 * 编译结果为只读共享对象，多会话并发调用无每会话状态、无竞态。
 */
import { compileIpRules, ipMatches, type IpRule } from "@/utils/addr/cidr.js";
import { compileHostRules, hostMatches, type HostMatcher } from "@/utils/addr/host.js";
import { readAcl } from "./reader.js";
import type { AclConfig } from "./schema.js";

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

const EMPTY_MATCHER: HostMatcher = { ip: [], exact: new Set<string>(), wildcards: [] };

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

let compiledCache: CompiledAcl | undefined;

/** 取编译结果；源快照未变则直接复用（只读共享，多会话并发安全） */
function compiled(): CompiledAcl {
  const acl = readAcl().value;
  if (compiledCache && compiledCache.source === acl) {
    return compiledCache;
  }
  compiledCache = {
    source: acl,
    clientIpWhitelist: compileIpRules(acl.clientIp.whitelist) ?? [],
    clientIpBlacklist: compileIpRules(acl.clientIp.blacklist) ?? [],
    targetWhitelist: compileHostRules(acl.target.whitelist) ?? EMPTY_MATCHER,
    targetBlacklist: compileHostRules(acl.target.blacklist) ?? EMPTY_MATCHER,
    upstreamWhitelist: compileHostRules(acl.upstream.whitelist) ?? EMPTY_MATCHER,
    upstreamBlacklist: compileHostRules(acl.upstream.blacklist) ?? EMPTY_MATCHER,
  };
  return compiledCache;
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
 * @returns 判定结果
 */
export function checkClientIp(addr: string): AclDecision {
  const c = compiled();
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
 * @returns 判定结果
 */
export function checkTargetHost(host: string): AclDecision {
  const c = compiled();
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
 * 仅 `PROXY_MODE=client` 有意义（server 模式由 `core/proxy-helpers:resolveRoute` 短路，不进本函数）；
 * 条目语法与 target 组同形（kind "host"）：IP/CIDR/域名/`*.域名`，不支持端口、不做 DNS；
 * 语义与前两组动作相反——黑名单命中 → 直连（优先）；白名单非空且未命中 → 直连；皆空（含整组缺失）→ 走上游。
 * 真值表：走上游 ⇔ 命中 whitelist ∧ 未命中 blacklist，其余一律直连
 * @param host - 客户端请求的目标主机（域名或 IP，可带方括号）
 * @returns 是否直连；因名单命中直连时带 reason（blacklist / whitelist）
 * @example checkUpstreamRoute("a.com") // blacklist 命中 → { direct: true, reason: "blacklist" }
 */
export function checkUpstreamRoute(host: string): UpstreamRouteDecision {
  const c = compiled();
  if (hostMatches(host, c.upstreamBlacklist)) {
    return { direct: true, reason: "blacklist" };
  }
  if (!isEmptyMatcher(c.upstreamWhitelist) && !hostMatches(host, c.upstreamWhitelist)) {
    return { direct: true, reason: "whitelist" };
  }
  return { direct: false };
}
