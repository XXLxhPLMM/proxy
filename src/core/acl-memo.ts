/**
 * @fileoverview 名单记忆：编译结果按接线分槽复用，判定路径只经这两个取编译结果的函数读它
 * @module core/acl-memo
 * @description
 * 名单**是什么意思**归 `./access-control.js` 判定；本模块只回答「同一份名单接线上，这份编译结果
 * 能不能复用」。三张模块级表与两个取编译结果的函数都在这里，判定层是它们唯一的读者。
 *
 * 读面（`readAcl` / `loadUserPolicy`）在这里现取，故本模块向下依赖 `@/datasource`，与判定层
 * 同一方向；反向永不成立（数据源层不认识判定层）。
 *
 * 设计要点：
 * - 编译结果按 `ConfigAccessor` 记忆（`WeakMap`），快照未变即复用，只读共享、多会话并发安全；
 *   全局与个人各记一份（个人层键为 `username`，判据同为**源对象身份**）
 * - 个人层是**两级**（外层按接线、内层按用户名）。账号被删或撤掉 `acl` 时那个槽位一并清掉，
 *   于是缓存规模恒 ≤ 账号表规模；压平成一级就丢掉了这条清理语义
 * - 两处 get-or-rebuild **刻意不共用一份泛型**：键的层级不同、槽位清理的时机不同，抽成
 *   `memoBy(map, key, source, build)` 只能靠把其中一边改形状来对齐，而两边都已经是对的
 * - 零日志：文件状态迁移由观察面回调上抛，本模块自己不记
 */

import {
  compileHostRules,
  compileIpRules,
  type HostMatcher,
  type IpRule,
} from "@/utils/addr/index.js";
import { readAcl, type AclConfig, type AclLocator } from "@/datasource/acl/index.js";
import { loadUserPolicy, type AccountLocator, type UserPolicy } from "@/datasource/users/index.js";
import type { JsonFileEvent } from "@/utils/json-file/index.js";

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

const compiledCaches = new WeakMap<AclLocator, CompiledAcl>();
/** 个人名单编译缓存：外层按 accessor 隔离（与全局同一原则），内层按用户名分槽。 */
const userTargetCaches = new WeakMap<AclLocator, Map<string, CompiledUserTarget>>();
/** 观察面登记表：只由 `bindAclFileEvents` 写（唯一写入口），判定路径只读。 */
const fileEventHandlers = new WeakMap<AclLocator, (event: JsonFileEvent) => void>();

/**
 * 为当前名单接线绑定数据状态观察面；返回幂等退订函数。
 *
 * @param locator - 名单接线（经 `aclLocatorFor(config)` 取得，与判定面用的是**同一个**对象——
 *   观察面表按它分槽，两边不是同一个对象就等于「装了 handler 却没人收」）
 * @param onEvent - 状态迁移回调（`error` / `missing` / `recovered` / `reloaded`）
 * @description 判定路径每请求读名单，观察面由 runtime 显式注入（logger 由组合层决定），
 * 不同接线各记一份，实例之间互不干扰。**本函数是观察面的唯一写入口**，必须由
 * `runtime.start()`/`stop()` 成对调用——泄漏就等于停机后监听残留。判定层的工厂刻意**不收**
 * `onFileEvent`：那会变成**两个写同一张表的入口** —— 两个 handler 都装上了，而判定路径只认
 * 后装的那个，先装的静默收不到事件，外部表现是「日志说名单没变、判定却换了」。
 * **少一个入口永远优于多一个便利形参**，故判定路径读这张表的方式是经下面两个取编译结果的
 * 函数（`fileEventHandlers.get(locator)`），而不是工厂再塞一个回调进来。
 * ⚠️ **半个牙齿**：`../../../tests/unit/core/access-control/source-guards.test.ts` 的 import
 * 白名单只锁住「从 `./access-control.js` 只能 import 两个出口」，**「工厂收几个形参」没有任何断言**。
 */
export function bindAclFileEvents(
  locator: AclLocator,
  onEvent: (event: JsonFileEvent) => void,
): () => void {
  fileEventHandlers.set(locator, onEvent);
  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    if (fileEventHandlers.get(locator) === onEvent) {
      fileEventHandlers.delete(locator);
    }
  };
}

/**
 * 取编译结果；源快照未变则直接复用（只读共享，多会话并发安全）
 * @param locator - 名单接线（决定读哪份名单，并作为编译缓存的隔离键）
 * @description 每条接线独立记忆一份编译结果；数据内容快照不变时复用，
 * 多 runtime 交替判定不会互相挤掉缓存或串用名单。
 */
export function compiled(locator: AclLocator): CompiledAcl {
  const acl = readAcl({
    locator,
    onEvent: fileEventHandlers.get(locator),
  }).value;
  const cached = compiledCaches.get(locator);
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
  compiledCaches.set(locator, next);
  return next;
}

/**
 * 取某用户 target 组的编译结果；策略快照未变即复用
 * @param locator - 名单接线（编译缓存的隔离键）
 * @param accounts - 账号表接线（决定读哪个驱动、哪份数据）
 * @param username - 已鉴权用户名
 * @returns 用户不存在 / 未配 `acl` 返回 undefined（个人层中性放行，不是「空名单放行」的另一种说法）
 */
export function compiledUserTarget(
  locator: AclLocator,
  accounts: AccountLocator,
  username: string,
): CompiledUserTarget | undefined {
  const policy = loadUserPolicy(username, accounts, fileEventHandlers.get(locator));
  let byUser = userTargetCaches.get(locator);
  if (policy === undefined) {
    // 账号被删 / 撤掉了 acl：把槽位一并清掉，缓存规模恒 ≤ 账号表规模
    byUser?.delete(username);
    return undefined;
  }
  if (byUser === undefined) {
    byUser = new Map<string, CompiledUserTarget>();
    userTargetCaches.set(locator, byUser);
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
