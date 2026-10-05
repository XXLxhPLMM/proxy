/**
 * @fileoverview 访问控制判定：把名单的三组编译结果翻译成「放行 / 拒绝 / 直连」
 * @module core/access-control
 * @description
 * **请求期策略层**，与数据层严格三层分离：条目规则层 `@/utils/addr/`
 * （条目语法的解析/编译/匹配，纯函数）、数据层 `@/datasource/acl`（读数据源、结构校验）、
 * 本模块（在每次请求上判定，**不认识文件与 IO**）。
 * ⚠️ 本模块**向下依赖 `@/datasource`**，反向永不成立（数据源层不认识判定层）。
 *
 * 编译结果的记忆与名单文件观察面住在同目录的 `./acl-memo.js`（模块级 `WeakMap` + 取编译结果的
 * 两个函数）；**判定面只有一个出口**：`createFileAccessControl(config)`。三个判定方法签名统一为
 * 「只读入参对象 + **无 `config` 形参**」（`config` 在工厂里被闭包捕获，于是「这份判定读的是
 * 哪份配置」不再有第二个真相源）。判定语义（client / target 两组、upstream 组动作相反的真值表）、
 * 个人名单合流（先全局后个人、全局短路）、`reason` / `source` 是自由 `string`、内置引擎的
 * 源码级自律：判据全文见 `../../../tests/unit/core/access-control/` 与
 * `user-merge-matrix.test.ts` 的头注释。
 *
 * ⚠️ **硬不变量：个人名单绝不参与 `checkClient` 与 `checkRoute`**（鉴权**之前**尚不存在
 * 「你是谁」；client 模式的路由决策与身份正交）。**这两个函数体里连 `user` 都不许出现**——
 * 源码级护栏按函数体逐条断言。
 *
 * **观察面只有一个入口：`bindAclFileEvents(locator, handler)`，工厂刻意不收 `onFileEvent`。**
 * 两个入口会往同一张表上各装一个 handler，于是判定路径只认后装的那个，先装的静默收不到事件，
 * 外部表现是「日志说名单没变、判定却换了」。**少一个入口永远优于多一个便利形参**，故本模块
 * 只把那个入口原样转出去（它的实现与理由住 `./acl-memo.js`）。⚠️ **半个牙齿**：
 * `../../../tests/unit/core/access-control/source-guards.test.ts` 的 import 白名单只锁住
 * 「从本模块只能 import 这两个出口」，**「工厂收几个形参」没有任何断言**。
 *
 * 设计要点：
 * - 两层的目标名单判定走**同一个** `hostDenied` 纯函数：个人组与全局 target 组「同形」是硬
 *   要求，抄两份迟早漂移
 * - 三个判定方法**都是模块级私有函数**（一律不导出），工厂只返回一个**对象字面量**：源码级护栏
 *   （「个人名单不越界」按函数体断言、`hostDenied` 只有一份）才有锚点可切，而失去锚点的护栏
 *   不是「红」，是**抛错**——两种失败都算坏，但只有一种能告诉你哪里坏了
 * - 零日志：拒绝/路由事实由调用方经 pipe 事件上抛
 * - 判定只认注入的名单接线（由 `createFileAccessControl` 从 `ConfigAccessor` 现取），不依赖任何全局配置
 */

import { accountLocatorFor, aclLocatorFor, type ConfigAccessor } from "@/config/index.js";
import type { AccountLocator } from "@/datasource/users/index.js";
import { hostMatches, ipMatches, type HostMatcher } from "@/utils/addr/index.js";
import { aclSourceFor, type AclLocator } from "@/datasource/acl/index.js";
import type {
  AccessClientInput,
  AccessControl,
  AccessDecision,
  AccessRouteDecision,
  AccessRouteInput,
  AccessTargetInput,
} from "@/core/types/proxy.js";

import { compiled, compiledUserTarget } from "./acl-memo.js";

/**
 * 观察面经本模块出去（判定面收成端口，订阅注册是与之配对的另一个出口，故仍在这个模块路径上）
 * @description 本模块**只**出口这两个名字。名单读取面（`loadAcl` / `readAcl` / `AclConfig` /
 * `AclList`）**刻意不再转出**：它们是数据层的东西，转出等于给判定层开一个与「读 + 判」无关的
 * 第三个出口，而 `source-guards.test.ts` 的出口白名单正是靠「只有这两个名字」才守得住的。
 * 包入口要那两个读取函数时直接从 `@/datasource/index.js` 取。
 */
export { bindAclFileEvents } from "./acl-memo.js";

/**
 * 名单原因（**模块私有**，不导出）：命中黑名单 / 不在白名单内。
 * 端口的 `AccessDecision.reason?: string` 是自由文本，替换实现（限速/地域/订阅网关）不该被迫
 * 套闭合集；**收窄是消费方自己的事**，判定层不替它们收。判据与锁点见
 * `../../../tests/unit/core/access-control/user-merge-matrix.test.ts`。
 */
type AclReason = "whitelist" | "blacklist";

/** 匹配器是否为空（空白名单 = 不做白名单限制） */
function isEmptyMatcher(m: HostMatcher): boolean {
  return m.ip.length === 0 && m.exact.size === 0 && m.wildcards.length === 0;
}

/**
 * 单组名单的目标判定（**全局 target 组与用户 target 组共用的唯一一份实现**）
 * @description 黑名单命中 → `blacklist`（优先）；白名单非空且未命中 → `whitelist`；皆空 → 放行。
 * 两层「同形」是硬要求，故只写这一份（源码级护栏：`blockAfter(code, "function hostDenied(")`，
 * 见 `../../../tests/unit/core/access-control/user-merge-matrix.test.ts`）
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
 * 判定客户端来源是否放行（`AccessControl.checkClient` 的实现体）
 * @description 只认 TCP 对端地址（由调用方经 socket.remoteAddress 取得），不看 X-Forwarded-For；
 * 地址取不到（"unknown"）且配了白名单时判否（fail-closed）。
 * ⚠️ **个人名单绝不参与本判定**（硬不变量，见文件头）：本函数体里**不许出现 `user`**
 * @param input - 只读入参（`{ client }`）：TCP 对端地址
 * @param locator - 名单接线（由 `createFileAccessControl` 的闭包传入，调用方无从插手）
 * @returns 判定结果
 */
function checkClient(input: AccessClientInput, locator: AclLocator): AccessDecision {
  const c = compiled(locator);
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
 * 放行 ⇔ 全局 target 组放行 ∧ 该用户 target 组放行，**先全局后个人、全局短路**：
 * 全局拒则**立即**返回（`source:"global"`，连 `users.json` 都不读），全局放行且
 * `user !== undefined` 时判该用户的 target 组（拒则 `source:"user"`），两关都过 →
 * `{allowed:true}`（**不写 source**：放行没有「哪一层放的」这个问题）。两层走同一个 `hostDenied`。
 * 判据与锁点（3×3 穷举真值表）见 `../../../tests/unit/core/access-control/user-merge-matrix.test.ts`。
 * @param input - 只读入参（`{ host, user? }`）：目标主机 + 已鉴权用户名（省略即个人层中性放行）
 * @param locator - 名单接线（由 `createFileAccessControl` 的闭包传入，调用方无从插手）
 * @returns 判定结果（本实现出的 `reason` 恒为 `whitelist|blacklist`；`source` 恒为 `global|user`）
 * @example access.checkTarget({ host: "ads.io" }) // 全局黑名单 → { allowed:false, reason:"blacklist", source:"global" }
 * @example access.checkTarget({ host: "ads.io", user: "alice" }) // alice 个人名单 → { ..., source:"user" }
 */
function checkTarget(
  input: AccessTargetInput,
  locator: AclLocator,
  accounts: AccountLocator,
): AccessDecision {
  const c = compiled(locator);
  const global = hostDenied(input.host, c.targetWhitelist, c.targetBlacklist);
  if (global !== undefined) {
    // 全局拒绝是绝对的：个人名单只能更严、不能更松，故这里短路，连读 users.json 都不读
    return { allowed: false, reason: global, source: "global" };
  }

  if (input.user !== undefined) {
    const u = compiledUserTarget(locator, accounts, input.user);
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
 * **纯名单判定，不读 `proxyMode`**（条目语法与 target 组同形，不支持端口、不做 DNS），语义与前两组
 * 动作相反：黑名单命中 → 直连（优先）；白名单非空且未命中 → 直连；皆空（含整组缺失）→ 走上游。
 * 真值表与 `tests/unit/core/access-control/file-engine.test.ts` 一致。
 *
 * ⚠️ **个人名单绝不参与本判定**（硬不变量，见文件头）：本函数体里**不许出现 `user`**。
 *
 * ⚠️ **`proxyMode` 模式门归 `helpers/route.ts:resolveRoute`，本函数刻意不加这条门（已裁决）**：
 * 那道门就住在 `resolveRoute` 的**第一行**（`policy.mode === "server"` 即短路）。把它塞进判定层
 * 会让策略端口漏进路由关切——**每个自定义 `AccessControl` 都得重写一遍模式门**。判据见
 * `../../../tests/unit/core/access-control/file-engine.test.ts` 的「server 模式零开销短路」那条。
 *
 * **承重契约：短路返回的那个 `RouteDecision` 必须不带 `reason`**（`emitRoute` 的跳过条件正是
 * `mode === "server" && !reason`）——理由与护栏 `tests/integration/forward/upgrade-channel.test.ts`。
 *
 * @param input - 只读入参（`{ host }`）：目标主机
 * @param locator - 名单接线（由 `createFileAccessControl` 的闭包传入，调用方无从插手）
 * @returns 是否直连；因名单命中直连时带 reason（本实现出 `blacklist` / `whitelist`）
 * @example access.checkRoute({ host: "a.com" }) // blacklist 命中 → { direct: true, reason: "blacklist" }
 */
function checkRoute(input: AccessRouteInput, locator: AclLocator): AccessRouteDecision {
  const c = compiled(locator);
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
 * 接线在这里被闭包捕获并逐次透传三个私有判定；从形参面上消灭「读的是哪份名单」这第二真相源。
 * 返回**对象字面量**而非 class 实例，是为了让三个判定体保持模块级函数、源码级护栏有锚点可切。
 * 三个方法都是**同步**的（硬裁决）：`checkRoute` 在四条入站通道的拨号之前被调用，其返回值要立刻
 * 喂给「选连接器 / 拒绝应答 / 发 `route` 事件」这一串同步控制流。判据见
 * `../../../tests/unit/core/access-control/file-engine.test.ts` 的「三个方法都是**同步**的」那条，
 * 出口唯一性那条在 `../../../tests/unit/core/access-control/source-guards.test.ts`。
 *
 * @param config - 配置访问器（决定读哪个名单驱动、哪份数据，并充当编译缓存的隔离键）
 * @throws 名单驱动未注册时抛错（错误文本列出全部已注册驱动名）
 * @example const access = createFileAccessControl(ctx.config)
 */
export function createFileAccessControl(config: ConfigAccessor): AccessControl {
  // ⚠️ **装配期就把驱动解析掉**（`aclSourceFor` 内部经注册表 `resolve`）。判据必须在装配点而不是
  // 第一个请求：懒解析会让「驱动名拼错」的表现是「所有请求全放行 + 一条 acl-inert 告警」——
  // 那是一次配置事故伪装成「没配名单」。fail-fast 一条不丢，只是挪到了它该在的位置。
  // 落地的读取仍逐次现读（`compiled` 每次经同一个 `aclSourceFor` 读），故热改名单路径照样生效。
  const aclLocator = aclLocatorFor(config);
  aclSourceFor(aclLocator);
  // 账号表接线**只造一次**并逐次透传：它是 `WeakMap` 记忆的键（下游实现器按它分槽），
  // 每请求现造会让个人名单每次判定都拿不到实现器记忆。热改路径仍生效（接线内部是现读闭包）。
  const accounts = accountLocatorFor(config);
  return {
    checkClient: (input) => checkClient(input, aclLocator),
    checkTarget: (input) => checkTarget(input, aclLocator, accounts),
    checkRoute: (input) => checkRoute(input, aclLocator),
  };
}
