/**
 * @fileoverview 访问控制判定：把 acl.json 的三组名单翻译成「放行 / 拒绝 / 直连」
 * @module core/access-control
 * @description
 * 本模块是**请求期策略层**，与 config 侧严格三层分离：
 * - 条目规则层 `@/config/files/rules/`（`ip.ts`/`host.ts`）：条目语法的解析/编译/匹配，纯函数
 * - 数据层 `src/config/files/acl.ts`：读文件、校验结构、返回合法的 `AclConfig`
 * - 本模块（策略层）：编译结果按 accessor 记忆，并在每次请求上判定，不认识文件与 IO
 *
 * **判定面只有一个出口：`createFileAccessControl(config)`**（`AccessControl` 端口的唯一实现）。
 * 三个判定方法各自**只**从这里出去，且签名统一为「只读入参对象 + **无 `config` 形参**」：
 * `config` 在工厂里被闭包捕获，于是「这份判定读的是哪份配置」不再有第二个真相源。
 * 过去三个导出函数各收一个 `config` 形参，同一件事有四种传法（三处调用 + 一处装配），
 * 错一处就是「拿 B 实例的名单、判 A 实例的请求」——那类错在运行期表现为「名单时灵时不灵」。
 *
 * 三个判定方法：
 * - `checkClient({ client })`：入站对端 IP（TCP `socket.remoteAddress`，不看 XFF）
 * - `checkTarget({ host, user? })`：出站目标主机（客户端请求的 host 字符串，不做 DNS）
 * - `checkRoute({ host })`：client 模式路由（直连还是交上游）。**纯名单判定、不读 `proxyMode`**；
 *   「非 client 模式即短路且不查 upstream 组」这条模式门**归 `helpers/route:resolveRoute`**（已裁决，
 *   理由见 `checkRoute` 注释）
 *
 * 判定语义：
 * - client / target 两组：黑名单命中 → 拒绝（优先）；白名单非空且未命中 → 拒绝；皆空 → 放行
 * - upstream 组动作相反：黑名单命中 → 直连（优先）；白名单非空且未命中 → 直连；
 *   皆空（含整组缺失）→ 走上游。真值表：走上游 ⇔ 命中 whitelist ∧ 未命中 blacklist；
 *   仅 `PROXY_MODE=client` 有意义，server 模式由 `helpers/route:resolveRoute` 短路
 *
 * **个人名单合流**：`checkTarget` 入参里的 `user` 是**已鉴权用户名**，判定为
 * 「放行 ⇔ 全局 target 组放行 ∧ 该用户 target 组放行」，**先全局后个人、全局短路**：
 * - 全局拒绝是**绝对**的：个人名单只能更严、不能更松，故全局拒即返回，**不再读 users.json**
 * - 两关都拒时报**全局那一条**（`source: "global"`）：全局是权威层，运维先看到自己的
 *   全局配置问题，而不是「某用户碰巧也被全局禁了」
 * - 用户未配 `acl`（或用户不存在/未鉴权，即 `user === undefined`）→ 个人层**中性放行**，
 *   等价于只有全局生效
 *
 * ⚠️ **硬不变量：个人名单绝不参与 `checkClient` 与 `checkRoute`。**
 * `checkClient` 发生在鉴权**之前**，那时还不存在「你是谁」；`checkRoute` 是 client 模式的
 * 路由决策，与身份正交。**这两个函数体里连 `user` 三个字母都不许出现**——这不是风格洁癖，
 * 而是「个人名单一旦渗进准入/路由，鉴权前后就会用两套身份口径」这条不变量唯一可被自动
 * 检查的形态（源码级护栏按函数体逐条断言）。
 *
 * **观察面也只有一个入口：`bindAclFileEvents(config, handler)`，工厂刻意不收 `onFileEvent`。**
 * 理由：ACL 文件观察面必须活在 `runtime.start() → stop()` 的订阅循环里（与 bridge /
 * lifecycle / store 订阅同一轮，泄漏就等于停机后监听残留）。若工厂也能传 `onFileEvent`，
 * 就会出现**两个写同一个 `WeakMap` 的入口** —— 两个 handler 都装上了，而判定层只认后装的
 * 那个，先装的静默收不到事件，外部表现是「日志说名单没变、判定却换了」。**少一个入口永远
 * 优于多一个便利形参。** 故判定路径读观察面的方式与从前一字不差：`fileEventHandlers.get(config)`。
 *
 * 设计要点：
 * - 编译结果按 `ConfigAccessor` 记忆（`WeakMap`），快照未变即复用，只读共享、多会话并发安全；
 *   全局与个人各记一份（个人层键为 `username`，判据同为**源对象身份**）
 * - 两层的目标名单判定走**同一个** `hostDenied` 纯函数：个人组与全局 target 组「同形」
 *   是硬要求，抄两份迟早漂移
 * - 三个判定方法与编译辅助**都是模块级私有函数**（一律不导出），`createFileAccessControl`
 *   只返回一个**调用它们的对象字面量**。这么排不是洁癖：判定层的护栏是**源码级**的
 *   （「个人名单不越界」逐函数体断言、「`hostDenied` 只有一份」），藏进 class 或深层闭包
 *   会让那些断言失去锚点，而失去锚点的护栏不是「红」，是**抛错**——两种失败都算坏，但只有
 *   一种能告诉你哪里坏了。
 * - 零日志：拒绝/路由事实由调用方经 pipe 事件上抛，落盘收在 `src/server`
 * - 判定只认注入的 `ConfigAccessor`，不依赖任何全局配置
 *
 * 使用示例：
 * ```ts
 * import { createFileAccessControl } from "@/core/access-control.js";
 *
 * const access = createFileAccessControl(config);
 *
 * const ip = access.checkClient({ client: socket.remoteAddress ?? "unknown" });
 * if (!ip.allowed) {
 *   // reason === "blacklist" | "whitelist"（本实现出的值；端口是自由文本，见 AccessDecision）
 * }
 * const target = access.checkTarget({ host, user: scope.user });
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
import type {
  AccessClientInput,
  AccessControl,
  AccessDecision,
  AccessRouteDecision,
  AccessRouteInput,
  AccessTargetInput,
} from "@/core/types/proxy.js";
import type { JsonFileEvent } from "@/utils/json-file/index.js";

/**
 * 名单原因（**模块私有**，不再导出）：命中黑名单 / 不在白名单内
 * @description
 * 这是**本实现自己产出的**取值集合，与端口的 `AccessDecision.reason?: string` 是两件事：
 * 端口对外是自由文本（替换实现可能是限速引擎 / 地理封锁 / 订阅制网关，闭合集会让它们**没法用
 * 类型描述自己的结论**，只能回去 `as never` 强转），而名单这一层仍只说这两个字面量。
 *
 * **为什么不再导出**：留着导出等于把「名单语义」重新摆成公共承诺，而事件契约那一份
 * （`core/events/types.ts` 的 `access.*` 载荷）已随端口放宽改成 `string`——两处各挂一个
 * 公共闭合集，正是「两份真相」的起点。收窄是**消费方自己的事**（桥接器按自己能认的取值
 * 决定发不发），判定层不该替它们收。
 */
type AclReason = "whitelist" | "blacklist";

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
/** 观察面登记表：只由 `bindAclFileEvents` 写（唯一写入口），判定路径只读。 */
const fileEventHandlers = new WeakMap<ConfigAccessor, (event: JsonFileEvent) => void>();

/**
 * 为当前 accessor 绑定 ACL 文件状态观察面；返回幂等退订函数。
 *
 * @description 判定路径每请求读名单，观察面由 runtime 显式注入（logger 由组合层决定），
 * 不同 accessor 各记一份，实例之间互不干扰。
 *
 * **这是观察面的唯一写入口**（`createFileAccessControl` 刻意不收 `onFileEvent`，理由见文件头）：
 * 两条入口会写同一个 `WeakMap`，判定层只认后装的那个，先装的静默失效。
 * runtime 必须在 `start()`/`stop()` 的订阅循环里成对调用它——泄漏就等于停机后监听残留。
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
 * 判定客户端来源是否放行（`AccessControl.checkClient` 的实现体）
 * @description 只认 TCP 对端地址（由调用方经 socket.remoteAddress 取得），不看 X-Forwarded-For；
 * 地址取不到（"unknown"）且配了白名单时判否（fail-closed）
 *
 * ⚠️ **个人名单绝不参与本判定**（硬不变量）：入站 IP 准入发生在**鉴权之前**，那一刻还不存在
 * 「你是谁」。本函数体里**不许出现 `user` 三个字母**——源码级护栏按函数体断言这条。
 * @param input - 只读入参（`{ client }`）：TCP 对端地址
 * @param config - 配置访问器（由 `createFileAccessControl` 的闭包传入，调用方无从插手）
 * @returns 判定结果
 */
function checkClient(input: AccessClientInput, config: ConfigAccessor): AccessDecision {
  const c = compiled(config);
  if (ipMatches(input.client, c.clientIpBlacklist)) {
    return { allowed: false, reason: "blacklist" };
  }
  if (c.clientIpWhitelist.length > 0 && !ipMatches(input.client, c.clientIpWhitelist)) {
    return { allowed: false, reason: "whitelist" };
  }
  return { allowed: true };
}

/**
 * 判定目标主机是否放行（全局名单 ∩ 个人名单；`AccessControl.checkTarget` 的实现体）
 * @description
 * 目标为 IP 字面量时只可能命中 IP/CIDR 条目；为域名时只可能命中精确/通配域名条目。
 * 两层判定**逐字同形**（同一个 `hostDenied`），顺序与短路点是：
 * 1. 全局 target 组 → 拒则**立即**返回（`source:"global"`），**不再看个人名单**
 * 2. 全局放行且 `user !== undefined` 时判该用户的 target 组 → 拒则 `source:"user"`
 * 3. 两关都过 → `{allowed:true}`（**不写 source**：放行没有「哪一层放的」这个问题）
 * @param input - 只读入参（`{ host, user? }`）：目标主机 + 已鉴权用户名（省略即个人层中性放行）
 * @param config - 配置访问器（由 `createFileAccessControl` 的闭包传入，调用方无从插手）
 * @returns 判定结果（本实现出的 `reason` 恒为 `whitelist|blacklist`；`source` 恒为 `global|user`）
 * @example access.checkTarget({ host: "ads.io" }) // 全局黑名单 → { allowed:false, reason:"blacklist", source:"global" }
 * @example access.checkTarget({ host: "ads.io", user: "alice" }) // alice 个人名单 → { ..., source:"user" }
 */
function checkTarget(input: AccessTargetInput, config: ConfigAccessor): AccessDecision {
  const c = compiled(config);
  const global = hostDenied(input.host, c.targetWhitelist, c.targetBlacklist);
  if (global !== undefined) {
    // 全局拒绝是绝对的：个人名单只能更严、不能更松，故这里短路，连读 users.json 都不读
    return { allowed: false, reason: global, source: "global" };
  }

  if (input.user !== undefined) {
    const u = compiledUserTarget(config, input.user);
    if (u !== undefined) {
      const denied = hostDenied(input.host, u.whitelist, u.blacklist);
      if (denied !== undefined) {
        return { allowed: false, reason: denied, source: "user" };
      }
    }
  }

  return { allowed: true };
}

/**
 * 判定目标主机应直连还是交上游（`AccessControl.checkRoute` 的实现体）
 * @description
 * **本判定是纯名单判定，不读 `proxyMode`**：条目语法与 target 组同形（kind "host"）：
 * IP/CIDR/域名/`*.域名`，不支持端口、不做 DNS；
 * 语义与前两组动作相反——黑名单命中 → 直连（优先）；白名单非空且未命中 → 直连；皆空（含整组缺失）→ 走上游。
 * 真值表：走上游 ⇔ 命中 whitelist ∧ 未命中 blacklist，其余一律直连
 *
 * ⚠️ **个人名单绝不参与本判定**（硬不变量）：client 模式的路由决策（这个请求该不该交上游）
 * 与「你是谁」正交。本函数体里**不许出现 `user` 三个字母**——源码级护栏按函数体断言这条。
 *
 * ⚠️ **`proxyMode` 模式门归 `helpers/route.ts:resolveRoute`，本函数刻意不加这条门（已裁决）**：
 * `resolveRoute` 的**第一行**就是 `if (policy.mode === "server") return { mode: "server", route: "direct" }`
 * ——短路健在，且**它就住在那里**：`RoutePolicy` 把 `mode` 与 `access` **并列**交给那个纯函数，
 * 端口只回答「这个目标该直连吗」这一件事。
 *
 * **为什么不塞进判定层**：`proxyMode` 是**路由模式**决定，与「谁被允许访问哪里」**正交**。
 * 让 `checkRoute` 去读它、或给 `AccessRouteInput` 补一个模式维度，都意味着**每个自定义
 * `AccessControl`（限速引擎 / 地域引擎 / 订阅网关…）都得重新实现一遍模式门**——策略端口漏进
 * 路由关切，比「工具层读配置」更坏。**⚠️ 不要因为读了这段就去 `checkRoute` 里加模式门**：
 * 那是本仓已明确否决的方向。
 *
 * **承重契约：短路返回的那个 `RouteDecision` 必须不带 `reason`。**
 * `forward/base:emitRoute` 的跳过条件正是 `mode === "server" && !reason`；凭空多一个 `reason`
 * 会让 `proxyMode=server` 且配了 `upstream` 组的部署**凭空多发一条 `route` 事件 / 多落一行
 * `[route]` 日志**（护栏 `integration/websocket-single-path.test.ts` 的「server 模式直连零条」
 * 钉的就是这条）。相比之下「server 模式下 `upstream` 组根本不查」只是零开销短路，不是安全属性——
 * 名单本就不会在直连路径上产生任何拒绝。
 *
 * @param input - 只读入参（`{ host }`）：目标主机
 * @param config - 配置访问器（由 `createFileAccessControl` 的闭包传入，调用方无从插手）
 * @returns 是否直连；因名单命中直连时带 reason（本实现出 `blacklist` / `whitelist`）
 * @example access.checkRoute({ host: "a.com" }) // blacklist 命中 → { direct: true, reason: "blacklist" }
 */
function checkRoute(input: AccessRouteInput, config: ConfigAccessor): AccessRouteDecision {
  const c = compiled(config);
  if (hostMatches(input.host, c.upstreamBlacklist)) {
    return { direct: true, reason: "blacklist" };
  }
  if (!isEmptyMatcher(c.upstreamWhitelist) && !hostMatches(input.host, c.upstreamWhitelist)) {
    return { direct: true, reason: "whitelist" };
  }
  return { direct: false };
}

/**
 * 造一份读名单的 `AccessControl`（`@/core/types/proxy.ts:AccessControl` 的**唯一实现**）
 *
 * @description 判定面**只有这一个出口**：三个方法都只从这里出去，调用方拿不到裸判定函数。
 *
 * - `config` 在这里被闭包捕获并逐次透传给三个私有判定，**从形参面上消灭了「config 从哪来」
 *   这第二真相源**——三个判定各收一个 `config` 就有四种传法（三个调用点 + 一处装配），
 *   错一处就是「拿 B 实例的名单、判 A 实例的请求」，症状是名单时灵时不灵。
 * - 返回的是**对象字面量**而不是 class 实例：三个判定体保持模块级函数，源码级护栏
 *   （「个人名单不越界」按函数体断言、`hostDenied` 唯一实现）才有锚点可切。
 * - **不收 `onFileEvent`**：观察面唯一入口是 `bindAclFileEvents`，理由见文件头。
 * - 三个方法都是**同步**的（硬裁决，见端口注释）：`checkRoute` 在四条入站通道的拨号之前
 *   被调用，其返回值要立刻喂给「选连接器 / 拒绝应答 / 发 `route` 事件」这一串同步控制流。
 *
 * @param config - 配置访问器（决定读哪份 `aclFile` / `authUsersFile`，并充当编译缓存的隔离键）
 * @example const access = createFileAccessControl(ctx.config)
 */
export function createFileAccessControl(config: ConfigAccessor): AccessControl {
  return {
    checkClient: (input) => checkClient(input, config),
    checkTarget: (input) => checkTarget(input, config),
    checkRoute: (input) => checkRoute(input, config),
  };
}

/** 重新导出名单读取面，便于调用方只 import 一处即可完成「读 + 判」。 */
export { loadAcl, readAcl };
export type { AclConfig, AclList } from "@/config/index.js";
