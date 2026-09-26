/**
 * @fileoverview 出站头剥离与净化：代理凭证不得泄漏到目标站点
 * @module core/helpers/headers
 * @description
 * 代理把**客户端的**头原样发给**目标站点**之前，必须先摘掉「代理自己的」头。
 * 「代理自己的」由**两条互相独立的规则**给出，缺一条就漏：
 * - **协议规则**（`proxy-` 前缀）：纯名称事实，与身份无关，不需要任何插件知道；
 * - **凭证规则**：这个 `(头名, 头值)` 对是不是本代理自己发出的凭证——**只有身份插件知道**。
 *
 * 判据唯一收口在 `isStrippableOutboundHeader`，`sanitizeHeaders` 与 websocket 的
 * Upgrade 报文共用它，错误边界只需要纯名称规则时用 `isProxyHeaderName`。
 *
 * 职责（本文件自此只剩「纯名称规则 + 三个薄封装」）：
 * - 名称规则：`isProxyHeaderName`（**纯**、零依赖、不读配置不碰身份插件）
 * - 判定与封装：`isStrippableOutboundHeader` / `stripProxyHeaders` / `sanitizeHeaders`
 *
 * ⚠️ **凭证判据不在本文件，判据归身份插件**（`IdentityProvider.isOwnCredential`，
 * 实现住 `core/identity/`）。从 `authEnabled` / `authType` / `jwtSecret` +
 * `loadAuthUsers`（users.json 热加载缓存）去**猜**「哪个 `Authorization` 是本代理的」这条路
 * **在身份可插值之后必然失配**：身份变成可插值组件时凭证形态由**插件**决定（自定义头名、
 * HMAC 摘要、云网关签名…），config 不再是真相源。而失配的代价不是「剥多了」
 * （目标的 `Authorization: Bearer <token>` 被误剥，最多少送一个头），
 * 而是反过来：**代理自己的凭证被原样转发给目标站**。故判据**由插件自述**，
 * 本文件只负责转交，**不重复实现**。
 *
 * 由上一条得到本文件的分层事实：**零 `@/config/index.js` 导入**（也不读 users.json）
 * ——出站头净化不需要知道任何配置项，「凭证长什么样」也不归它管。头名规则与封装是无状态的，
 * 身份判据是有状态的，两者唯一的耦合点就是 `identity` 这一个注入的端口。
 *
 * **⚠️ 为什么「协议规则」与「凭证规则」必须是两件事、且顺序不可换**（这是本文件最容易
 * 被「顺手统一」掉的地方，故写在这里而不是只写在函数注释里）：
 * - **协议规则不需要插件知道**：`proxy-` 前缀是 HTTP 代理协议（RFC 7230 §7.6）自己规定的
 *   命名空间——**不认得这个前缀的请求就不知道它在跟代理说话**。它与「谁签发了凭证」完全无关，
 *   连一个恒返回 false 的 `noneIdentity()` 也必须照样剥掉它。故它留在本文件，是一条
 *   **零依赖纯名称规则**，错误边界（`core/error-boundary.ts`）在**拿不到任何插件**的上下文里
 *   也要用它。
 * - **凭证形态只有插件知道**：`Authorization: ApiKey …` / `X-Api-Key: …` / HMAC 摘要 /
 *   云厂商网关签名……把这些全写成一张库层白名单，等于把「配置即身份真相源」那个已经被推翻的
 *   假设换个地方再立一次。判据必须由注入的那一份**插件自述**。
 * - **顺序不可换**：协议规则在前，是因为它不依赖插件、且是「无条件」的——把它放在委派之后
 *   就等于让「插件漏实现」有机会把 `Proxy-Authorization` 放出去，而那个头**根本不该问插件**。
 *
 * **⚠️ 为什么委派必须覆盖「每个出站头名」而不是只问 `authorization`**（S0 收口时漏掉的那一条）：
 * 一个用 `X-Api-Key` 鉴权的库调用方插件，它写 `isOwnCredential(name, value) → true` 认这个头；
 * 而只要 `isStrippableOutboundHeader` 还留着 `lower === "authorization"` 门禁，那个头就**永远
 * 不会被问**，key 被原样转发给目标站。**这不是「支持不全」，是本次重构立项时要关掉的泄漏类型
 * 本身**：把 `Authorization` 这个名字写死在库层，等于库层在替插件规定凭证形态，而插件的形态
 * 恰恰是它自己才知道的事实。故本文件的委派是**无条件的**——只保留 `proxy-` 前缀这一条
 * 协议规则先走，其余头名一律问插件。
 *
 * **代价（实测数字，不许含糊）**：委派放开后，每个出站头 × 每个值都会多调一次
 * `identity.isOwnCredential`。以一个 17 头的典型请求（esbuild bundle + Node 22 + Windows，
 * 7 轮取最小值，扣掉「浅拷贝 + 键遍历 + 强制 connection」的 harness 基线 0.108 µs）实测：
 * - **空判据插件**：`0.744 µs / 17 头` ≈ **每头 44 ns**（一次 `toLowerCase()` + 一次 `!==`，
 *   V8 对已是小写的单字节串走快路径不分配）。这就是「每个出站头 × 每个值一次委派」的天花板量级。
 * - **内置四插件**（`basicIdentity` 等）：`1.315 → 1.612 µs/请求`，**+0.3 µs**。它们的廉价早退在
 *   `core/identity/token.ts:ownCredentialForms` 的**首行**（`name.toLowerCase() !== "authorization"`
 *   即返回），`FileAccountIdentity` 前面还有一层 `!this.isEnabled`。相对一条 HTTP 转发的
 *   拨号 + 收发字节，这个量级在噪声里。
 * - **⚠️ 配置驱动的动态门面（`core/identity/factory.ts:createIdentityFromConfig`）是唯一的大头，
 *   而它的成本中心不是「每请求现造快照」**。这条曾被记错过：旧版归因写「每次委派现造一份快照、
 *   增量 ≈1.57 µs、17 头 = +25 µs/请求」。**归因错了**——快照构造早被 `live()` 的记忆表
 *   （`liveSnapshots`，`WeakMap<ConfigAccessor, LiveSnapshot>`：六个输入每次现读、逐项比身份后
 *   复用快照）压平，「每请求现造」从来不是成本中心。**逐项实测**（同口径：esbuild bundle +
 *   Node 22 + Windows，17 头请求，每次 `live()` 调用）：
 *   | 组成 | ns | 占比 |
 *   |---|---|---|
 *   | **`loadAuthUsers(config, obs)`** | **1793** | **87.7%** |
 *   | `new FileAccountIdentity({...})` | 12 | 0.6% |
 *   | 4 × `config.get` | 31 | 1.5% |
 *
 *   即每次委派 ≈ **1.8 µs**，17 头 ≈ **31 µs/请求**，量级与旧数字接近**但归因完全不同**：
 *   涨上去的是 **`readJsonCached` 的编排被调用了 17 次**，不是快照被构造了 17 次。
 *   **CLI 与 `createProxyRuntime` 走的正是这一条**，所以这是生产路径要付的钱，不是理论值。
 *   **但 stat 次数不变**——`readJsonCached` 的 1s 节流是**按文件**的，调用次数再多，每秒仍至多
 *   一次 `fs.stat`；涨上去的是纯内存的 `path.resolve` / 缓存键拼接 / 一次 `transitionContext`
 *   分配 / `notifyTransition`。
 * - **⚠️ 剩余成本缺口（如实记账，本文件不修）**：大头是 `readJsonCached` 的编排
 *   （实测 `path.resolve` 就占 `loadAuthUsers` 的 **44%**）**× 每请求出站头数**。三条修法
 *   **都必须先裁决**，故刻意只记不动：① 把 `path.resolve` 提出去（会改动 `utils/json-file`
 *   的相对路径绝对化纪律，而「进入缓存前先绝对化」是一条正确性不变量，不是纯开销）；
 *   ② 让每次 `sanitizeHeaders` 只读一次账号表（要改的是**端口形状**——`isOwnCredential`
 *   逐头调用的形状正是「库层不做头名限制」那条契约的实现方式）；③ 用 `Date.now()` 记忆
 *   ——**本仓明确禁止**：`readJsonCached` 的正确性判据是**源对象身份**，按时间记会把
 *   「1s 节流内改文件」耦合成一个可观测的错误。
 * - **结论与后续**：~31 µs/请求换掉「插件说「这是我的凭证」而库层当没听见」这条泄漏路径，
 *   账是划算的（泄漏的是内网口令/代理令牌，量级完全不同）。**不许**为了省它把头名门禁加回来。
 *   记忆化那条待办（`factory.ts` 的 `live()`）**已完成**，但**别把它当性能优化写**：
 *   实测只省 0.2–1.6 µs/次（噪声底量级）——它消除的是**重复构造**，真正的大头在
 *   `loadAuthUsers` 那一侧，**不属于本文件，也不许在 `headers.ts` 里想办法绕开委派**。
 *
 * 四条不变量（改本文件时逐条对照）：
 * 1. **`isProxyHeaderName` 是纯函数、零依赖**：错误分类（`core/error-boundary.ts`）用它在
 *    完全没有配置、也拿不到身份插件的上下文里识别 `proxy-authorization`，
 *    **签名一字不许动**，更不许为了「统一」给它塞参数。
 * 2. **`sanitizeHeaders` 无条件强制 `Connection: close`**：这是自觉的「不复用上游连接」
 *    性能取舍（出站传输层由连接器/拨号守卫掌管，池化与它不兼容），
 *    **不许以「省资源」为名去掉或引入 agent 池**。
 * 3. **`stripProxyHeaders` 原地 mutate 入参**（护栏断言返回 `toBe(headers)`）；
 *    `sanitizeHeaders` 不污染调用方对象，故自己先浅拷贝再剥。
 * 4. **凭证判据的委派不许加头名门禁**（见上面「为什么委派必须覆盖每个出站头名」）：
 *    加回去等于把插件的凭证形态重新关进 `authorization` 这一个名字里。
 *    护栏：`tests/unit/identity-credential-seam.test.ts`（已变异测试验证：改回「只问
 *    `authorization`」→ 那几条必红）。
 *
 * 不负责：
 * - 不实现凭证比对原语（`./credentials.js`）、不判「是不是自己的凭证」（`@/core/identity`）
 * - 不解析目标（`./target.js`）、不做 ACL 判定、不发事件、不打日志
 * - 零配置读取、零文件 IO、零配置全局
 *
 * 依赖：`@/utils/constants/index.js`（头名/取值常量）+ `@/core/types/identity.js`
 * （**type-only** `IdentityProvider`，编译期擦除、零运行期依赖边）。
 *
 * 使用示例：
 * ```ts
 * import { sanitizeHeaders } from "@/core/helpers/headers.js";
 *
 * const outHeaders = sanitizeHeaders({ ...req.headers }, identity);
 * ```
 */

import {
  HEADER_NAME_CONNECTION,
  HEADER_PREFIX_PROXY,
  HEADER_VALUE_CLOSE,
} from "@/utils/constants/index.js";
import type { IdentityProvider } from "@/core/types/identity.js";

/**
 * 判断头名是否属于代理协议头。
 * @description 这是不读配置、不依赖任何注入的纯名称规则：任意 `proxy-` 前缀
 *          （大小写不敏感）都应从出站报文剥离。错误边界只需要该规则，
 *          不应为了分类错误而注入配置访问器或身份插件——**签名与零依赖都是契约**。
 */
export function isProxyHeaderName(name: string): boolean {
  return name.toLowerCase().startsWith(HEADER_PREFIX_PROXY);
}

/**
 * 判断出站头是否应剥离：**协议规则先走，其余一律委派身份插件**
 * @description
 * 两条规则，顺序与边界都是契约：
 * 1. **`proxy-` 前缀 → 无条件剥离**。这是 HTTP 代理协议自己规定的命名空间，是纯名称事实，
 *    与身份无关，**不需要（也不应该）问插件**——`core/error-boundary.ts` 在拿不到任何插件的
 *    上下文里也要靠 `isProxyHeaderName` 认出 `proxy-authorization`。
 * 2. **其余每一个头名 × 每一个值 → `identity.isOwnCredential(lower, value)`**。凭证形态由
 *    注入的那份插件自述，库层不猜、不写死、**也不对它做任何头名限制**。
 *
 * **为什么第 2 条不能留 `lower === "authorization"` 门禁**：凭证可以放在**任何**头里。写一个用
 * `X-Api-Key` 鉴权的 `IdentityProvider`，门禁会让那个头永远不被问，key 原样转发给目标站——
 * 正是本文件要关掉的那类泄漏。「判据由插件给出」这件事必须**真的**贯彻到每个头名上，
 * 否则端口注释与实现自相矛盾，插件作者会照注释写出插件、照实现得到泄漏。
 * 护栏：`tests/unit/identity-credential-seam.test.ts`（变异测试：改回只问 `authorization`
 * → 那几条必红）。
 *
 * **代价**（17 头典型请求实测，esbuild bundle + Node 22 + Windows，7 轮取最小值、已扣 harness
 * 基线 0.108 µs，详见文件头「代价」一节）：空判据插件每头委派 **≈44 ns**；内置四插件
 * `1.315 → 1.612 µs/请求`（**+0.3 µs**，在噪声里）；**配置驱动动态门面每次委派 ≈1.8 µs，
 * 17 头 ≈31 µs/请求——归因是 `readJsonCached` 的编排被调了 17 次（其中 `path.resolve` 占
 * `loadAuthUsers` 的 44%），不是「每请求现造一份快照」（那条待办已由 `liveSnapshots` 记忆表
 * 完成，实测只省 0.2–1.6 µs/次，噪声底量级）**。**但 `fs.stat` 次数不变**（`readJsonCached` 的
 * 1s 节流按文件计）。这是自觉接受的成本：**不许**以「省这点开销」为名把头名门禁加回来，
 * 也不许在本文件里绕开委派；剩余缺口是那条 `readJsonCached` 编排 × 头数，**三条修法都需先裁决**。
 *
 * **头名以小写归一后传入**（端口契约：调用方先按大小写不敏感归一）；数组值取**任一**命中即整条
 * 剥离——多值头里混进了本代理凭证就整条都不能发；`undefined` 值无从判定，恒不剥离。
 * @param name - 头名（任意大小写）
 * @param value - 头值（数组取任一命中即整条剥离；`undefined` 不剥离）
 * @param identity - 身份插件，出站凭证判据的唯一来源；必须由调用方显式注入
 * @returns 是否应剥离
 * @example isStrippableOutboundHeader("Proxy-Foo", "bar", identity) // => true（协议规则，不问插件）
 * @example isStrippableOutboundHeader("Authorization", "Bearer target-token", identity) // => false（非本代理凭证）
 * @example isStrippableOutboundHeader("X-Api-Key", "k", apiKeyIdentity) // => 插件认这个头就 true
 */
export function isStrippableOutboundHeader(
  name: string,
  value: string | string[] | undefined,
  identity: IdentityProvider,
): boolean {
  const lower = name.toLowerCase();
  if (isProxyHeaderName(lower)) {
    return true;
  }
  if (typeof value === "string") {
    return identity.isOwnCredential(lower, value);
  }
  if (Array.isArray(value)) {
    return value.some((v) => identity.isOwnCredential(lower, v));
  }
  return false;
}

/**
 * 剥离代理相关头（原地删除）
 * @description 遍历头字典，删除所有命中 `isStrippableOutboundHeader` 的键；注意会 mutate 传入对象
 * @param h - 头字典（会被原地修改）
 * @param identity - 身份插件，出站凭证判据的唯一来源；必须由调用方显式注入
 * @returns 同一对象（已删除代理头）
 * @example stripProxyHeaders({ "Proxy-Authorization": "Basic xxx", "Host": "example.com" }, identity) // => { Host: ... }
 */
export function stripProxyHeaders<H extends Record<string, string | string[] | undefined>>(
  h: H,
  identity: IdentityProvider,
): H {
  for (const k of Object.keys(h)) {
    if (isStrippableOutboundHeader(k, h[k], identity)) {
      delete h[k];
    }
  }
  return h;
}

/**
 * 净化出站头（浅拷贝后剥离代理头并强制 `Connection: close`）
 * @description 先浅拷贝再 `stripProxyHeaders`，避免污染原对象；随后覆写 `connection: close`
 *          以禁用上游长连接（**无条件强制**，理由见文件头不变量 2——这是自觉的性能取舍，不是缺陷）
 * @param h - 原始头字典
 * @param identity - 身份插件，出站凭证判据的唯一来源；必须由调用方显式注入
 * @returns 净化后的新头字典
 * @example sanitizeHeaders(req.headers, identity) // => { host: "...", connection: "close", ... }（无 proxy 头）
 */
export function sanitizeHeaders(
  h: Record<string, string | string[] | undefined>,
  identity: IdentityProvider,
): Record<string, string | string[] | undefined> {
  const s = stripProxyHeaders({ ...h }, identity);
  s[HEADER_NAME_CONNECTION] = HEADER_VALUE_CLOSE;
  return s;
}
