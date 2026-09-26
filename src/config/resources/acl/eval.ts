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
 * 三个入口都**显式接收名单文件路径**（由调用方从自己的配置作用域取出）：判定
 * 绝不允许回读进程级单例，否则同进程第二个实例会拿到第一个实例的名单。路径参数
 * 排在首位，因为它决定「判的是哪一份名单」，与业务输入（addr / host）不是一回事。
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
  clientIpWhitelist: IpRule[];
  clientIpBlacklist: IpRule[];
  targetWhitelist: HostMatcher;
  targetBlacklist: HostMatcher;
  upstreamWhitelist: HostMatcher;
  upstreamBlacklist: HostMatcher;
}

/**
 * 快照对象身份 → 编译结果。
 *
 * 键**必须**是快照对象而不是单个模块级槽：多实例下 A/B 各读各的路径，两个实例
 * 轮流调用会互相冲掉单槽，导致每连接都重编译（判定语义仍正确，纯属白烧 CPU）。
 * 改用 WeakMap 后，「每个 path 各自记忆」由 `readJsonCached` 的值身份保证——
 * 该缓存按「资源 + 路径」分条目，路径不变时 `value` 恒为同一对象，于是同一路径
 * 恒命中同一条编译结果，「快照对象未变则复用」这个优化原样保留。
 *
 * 两点附带结论：
 * - **无需手工上界**：键的存活期就是 json 缓存条目的存活期，该条目被按插入顺序
 *   淘汰（`json.ts` 的 16 条上限）后编译条目随键一起回收（WeakMap 按 key 可达性
 *   判定 value，value 里回指 key 也不构成泄漏），多实例/多次 reload 都不累积。
 * - **不同路径共享同一份编译结果是安全的**：只有内容相同的对象才会是同一引用
 *   （`reader.ts` 的 `EMPTY_ACL` 缺省哨兵是唯一的共享来源），共享反而省掉重复编译。
 */
const compiledCache = new WeakMap<AclConfig, CompiledAcl>();

/**
 * 取编译结果；源快照未变则直接复用（只读共享，多会话并发安全）
 * @param path - 名单文件路径；由调用方从自己的配置作用域取出
 */
function compiled(path: string): CompiledAcl {
  const acl = readAcl({ path }).value;
  const hit = compiledCache.get(acl);
  if (hit !== undefined) {
    return hit;
  }
  const next: CompiledAcl = {
    clientIpWhitelist: compileIpRules(acl.clientIp.whitelist) ?? [],
    clientIpBlacklist: compileIpRules(acl.clientIp.blacklist) ?? [],
    targetWhitelist: compileHostRules(acl.target.whitelist) ?? EMPTY_MATCHER,
    targetBlacklist: compileHostRules(acl.target.blacklist) ?? EMPTY_MATCHER,
    upstreamWhitelist: compileHostRules(acl.upstream.whitelist) ?? EMPTY_MATCHER,
    upstreamBlacklist: compileHostRules(acl.upstream.blacklist) ?? EMPTY_MATCHER,
  };
  compiledCache.set(acl, next);
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
 * @param path - 名单文件路径；由调用方从自己的配置作用域取出
 * @param addr - 客户端对端地址
 * @returns 判定结果
 */
export function checkClientIp(path: string, addr: string): AclDecision {
  const c = compiled(path);
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
 * @param path - 名单文件路径；由调用方从自己的配置作用域取出
 * @param host - 客户端请求的目标主机（域名或 IP，可带方括号）
 * @returns 判定结果
 */
export function checkTargetHost(path: string, host: string): AclDecision {
  const c = compiled(path);
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
 * @param path - 名单文件路径；由调用方从自己的配置作用域取出
 * @param host - 客户端请求的目标主机（域名或 IP，可带方括号）
 * @returns 是否直连；因名单命中直连时带 reason（blacklist / whitelist）
 * @example checkUpstreamRoute("cfg/acl.json", "a.com") // blacklist 命中 → { direct: true, reason: "blacklist" }
 */
export function checkUpstreamRoute(path: string, host: string): UpstreamRouteDecision {
  const c = compiled(path);
  if (hostMatches(host, c.upstreamBlacklist)) {
    return { direct: true, reason: "blacklist" };
  }
  if (!isEmptyMatcher(c.upstreamWhitelist) && !hostMatches(host, c.upstreamWhitelist)) {
    return { direct: true, reason: "whitelist" };
  }
  return { direct: false };
}
