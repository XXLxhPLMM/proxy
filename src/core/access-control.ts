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
 * - `checkTargetHost(host, config, user?)`：出站目标主机（客户端请求的 host 字符串，不做 DNS）
 * - `checkUpstreamRoute(host, config)`：client 模式路由（直连还是交上游）
 *
 * 判定语义：
 * - clientIp / target 两组：黑名单命中 → 拒绝（优先）；白名单非空且未命中 → 拒绝；皆空 → 放行
 * - upstream 组动作相反：黑名单命中 → 直连（优先）；白名单非空且未命中 → 直连；
 *   皆空（含整组缺失）→ 走上游。真值表：走上游 ⇔ 命中 whitelist ∧ 未命中 blacklist；
 *   仅 `PROXY_MODE=client` 有意义，server 模式由 `helpers/route:resolveRoute` 短路
 *
 * **个人名单合流（Phase 4b）**：`checkTargetHost` 的第三参是**已鉴权用户名**，判定为
 * 「放行 ⇔ 全局 target 组放行 ∧ 该用户 target 组放行」，**先全局后个人、全局短路**：
 * - 全局拒绝是**绝对**的：个人名单只能更严、不能更松，故全局拒即返回，**不再看个人名单**
 * - 两关都拒时报**全局那一条**（`source: "global"`）：全局是权威层，运维先看到自己的
 *   全局配置问题，而不是「某用户碰巧也被全局禁了」
 * - 用户未配 `acl`（或用户不存在/未鉴权，即 `user === undefined`）→ 个人层**中性放行**，
 *   等价于只有全局生效
 * - 个人名单**绝不**参与 `checkClientIp`（鉴权之前没有身份）与 `checkUpstreamRoute`
 *   （client 模式的路由决策，与「你是谁」正交）
 *
 * 设计要点：
 * - 编译结果按 `ConfigAccessor` 记忆（`WeakMap`），快照未变即复用，只读共享、多会话并发安全；
 *   全局与个人各记一份（个人层键为 `username`，判据同为**源对象身份**）
 * - 两层的目标名单判定走**同一个** `hostDenied` 纯函数：个人组与全局 target 组「同形」
 *   是硬要求，抄两份迟早漂移
 * - 零日志：拒绝/路由事实由调用方经 pipe 事件上抛，落盘收在 `src/server`
 * - 配置经端口注入：所有入口的 `config` 必填，不依赖任何全局配置
 *
 * 使用示例：
 * ```ts
 * import { checkClientIp, checkTargetHost } from "@/core/access-control.js";
 *
 * const ip = checkClientIp(socket.remoteAddress ?? "unknown", config);
 * if (!ip.allowed) {
 *   // reason === "blacklist" | "whitelist"（闭合集合，事件面据此发布）
 * }
 * const target = checkTargetHost(host, config, scope.user);
 * if (!target.allowed) {
 *   // target.source === "global"（权威层）| "user"（该用户的个人名单）
 * }
 * ```
 */

import {
  loadAcl,
  loadUserPolicy,
  readAcl,
  type AclConfig,
  type ConfigAccessor,
  type UserPolicy,
} from "@/config/index.js";
import { compileHostRules, hostMatches, type HostMatcher } from "@/config/files/rules/index.js";
import { compileIpRules, ipMatches, type IpRule } from "@/config/files/rules/index.js";
import type { AclSource } from "@/core/types/proxy.js";
import type { JsonFileEvent } from "@/utils/json-file/index.js";

/** 拒绝原因：命中黑名单 / 不在白名单内 */
export type AclReason = "whitelist" | "blacklist";

/** 判定结果 */
export interface AclDecision {
  allowed: boolean;
  reason?: AclReason;
  /**
   * 拒绝来自哪一层：全局 `acl.json`（`"global"`）还是该用户的个人名单（`"user"`）。
   *
   * **只在拒绝时写**：放行没有「哪一层放的」这个问题，写了就是噪音（且会让
   * 「两关都过」与「个人层不存在」两种情况无法区分）。放行即恒为 `{allowed:true}`。
   *
   * 判定层出的**永远是** `AclReason` 闭合集合那两个字面量之一：来源信息走这个**独立**字段，
   * 绝不许把 `reason` 扩成 `"user:blacklist"` 之类——`runtime/bridge.ts:aclReason` 只认
   * 闭合集合，遇到表外值**静默不发布** `access.target-denied`，那等于把安全事实弄丢了。
   */
  source?: AclSource;
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

/**
 * 单个用户的 target 组编译结果（按 `username` 分槽，判据与全局同一手法：源对象身份）
 * @description `source` 是 `loadUserPolicy` 记忆过的那份**已冻结快照**：文件内容没变时
 * `readJsonCached` 返回同一个对象，故身份不变即整份编译结果可复用（含冻结本身，零分配）。
 */
interface CompiledUserTarget {
  source: UserPolicy;
  whitelist: HostMatcher;
  blacklist: HostMatcher;
}

const compiledCaches = new WeakMap<ConfigAccessor, CompiledAcl>();
/** 个人名单编译缓存：外层按 accessor 隔离（与全局同一原则），内层按用户名分槽。 */
const userTargetCaches = new WeakMap<ConfigAccessor, Map<string, CompiledUserTarget>>();
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
 * 单组名单的目标判定（**全局 target 组与用户 target 组共用的唯一一份实现**）
 * @description 黑名单命中 → `blacklist`（优先）；白名单非空且未命中 → `whitelist`；皆空 → 放行。
 * 两层「同形」是硬要求，故只写这一份：抄两份的话，某一侧改了优先级而另一侧没跟上，
 * 「全局与个人名单语义一致」这条不变量就悄悄破了
 * @returns 放行返回 undefined，拒绝返回 `AclReason`（只可能是那两个闭合字面量之一）
 */
function hostDenied(
  host: string,
  whitelist: HostMatcher,
  blacklist: HostMatcher,
): AclReason | undefined {
  if (hostMatches(host, blacklist)) {
    return "blacklist";
  }
  if (!isEmptyMatcher(whitelist) && !hostMatches(host, whitelist)) {
    return "whitelist";
  }
  return undefined;
}

/**
 * 取某用户 target 组的编译结果；策略快照未变即复用
 * @param config - 配置访问器（决定读哪份 `authUsersFile`）
 * @param username - 已鉴权用户名
 * @returns 用户不存在 / 未配 `acl` 返回 undefined（个人层中性放行，不是「空名单放行」的另一种说法）
 */
function compiledUserTarget(
  config: ConfigAccessor,
  username: string,
): CompiledUserTarget | undefined {
  const policy = loadUserPolicy(username, config, fileEventHandlers.get(config));
  let byUser = userTargetCaches.get(config);
  if (policy === undefined) {
    // 账号被删 / 撤掉了 acl：把槽位一并清掉，缓存规模恒 ≤ 账号表规模
    byUser?.delete(username);
    return undefined;
  }
  if (byUser === undefined) {
    byUser = new Map<string, CompiledUserTarget>();
    userTargetCaches.set(config, byUser);
  }
  const cached = byUser.get(username);
  if (cached?.source === policy) {
    return cached;
  }
  const next: CompiledUserTarget = {
    source: policy,
    whitelist: compileHostRules(policy.target.whitelist) ?? EMPTY_MATCHER,
    blacklist: compileHostRules(policy.target.blacklist) ?? EMPTY_MATCHER,
  };
  byUser.set(username, next);
  return next;
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
 * 判定目标主机是否放行（全局名单 ∩ 个人名单）
 * @description
 * 目标为 IP 字面量时只可能命中 IP/CIDR 条目；为域名时只可能命中精确/通配域名条目。
 * 两层判定**逐字同形**（同一个 `hostDenied`），顺序与短路点是：
 * 1. 全局 target 组 → 拒则**立即**返回（`source:"global"`），**不再看个人名单**
 * 2. 全局放行且 `user !== undefined` 时判该用户的 target 组 → 拒则 `source:"user"`
 * 3. 两关都过 → `{allowed:true}`（**不写 source**：放行没有「哪一层放的」这个问题）
 * @param host - 客户端请求的目标主机（域名或 IP，可带方括号）
 * @param config - 必填配置访问器
 * @param user - 已鉴权用户名（Phase 4b）；省略/未鉴权即个人层中性放行
 * @returns 判定结果（`reason` 恒为 `whitelist|blacklist` 闭合集合之一）
 * @example checkTargetHost("ads.io", config) // 全局黑名单 → { allowed:false, reason:"blacklist", source:"global" }
 * @example checkTargetHost("ads.io", config, "alice") // alice 个人名单 → { ..., source:"user" }
 */
export function checkTargetHost(
  host: string,
  config: ConfigAccessor,
  user?: string,
): AclDecision {
  const c = compiled(config);
  const global = hostDenied(host, c.targetWhitelist, c.targetBlacklist);
  if (global !== undefined) {
    // 全局拒绝是绝对的：个人名单只能更严、不能更松，故这里短路，连读 users.json 都不读
    return { allowed: false, reason: global, source: "global" };
  }

  if (user !== undefined) {
    const u = compiledUserTarget(config, user);
    if (u !== undefined) {
      const denied = hostDenied(host, u.whitelist, u.blacklist);
      if (denied !== undefined) {
        return { allowed: false, reason: denied, source: "user" };
      }
    }
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
