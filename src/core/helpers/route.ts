/**
 * @fileoverview 路由判定：本请求的有效模式 + 直连还是交上游
 * @module core/helpers/route
 * @description
 * **有效模式唯一入口是 `resolveRoute(dest, policy)`**。四个转发器（http/tunnel/
 * websocket/socks）后续分支一律读返回的 `route.mode`，**不得再裸读
 * `get("proxyMode")`**——裸读会绕过「命中路由名单即回落 server 语义」这条规则。
 *
 * 职责（三步一体，顺序本身是契约）：
 * - `resolveRoute`：`policy.mode === "server"` **零开销短路**（不查名单、不带 `reason`）；
 *   client 模式才问 `policy.access.checkRoute({ host })`——说直连就
 *   `{ mode: "server", route: "direct", reason }`（名单命中回落即 server 语义），
 *   否则 `{ mode: "client", route: "upstream" }`
 * - `resolveForwardTargets`：先解析目标，再定路由，**最后按有效模式选 dial**，
 *   成对给出「拨号目标 dial」与「客户端请求目标 dest」
 * - 类型契约：`RoutePolicy` / `RouteInput` / `DialPlan` / `RouteDecision` / `ForwardTargets`
 *
 * 不负责：
 * - 不做拨号（`forward/upstream/connector/**`）
 * - **不判名单规则**：条目语法归 `@/config/files/rules/`，判定归 `core/access-control.ts`；
 *   本文件只消费 `AccessControl` 端口给出的结论
 * - 不打日志、不发事件：路由事实由各转发器在 preDial 通过后经 `forward/base:emitRoute` 上抛
 *
 * 依赖（**两种性质，刻意不混为一谈**）
 * - **对策略层只 type-only**：`AccessControl` / `AccessRouteDecision` 端口类型经
 *   `@/core/types/proxy.js` 引入，编译期擦除。`helpers/` 是共享工具层，**不得在依赖图上压在
 *   策略层上面**——**别在这里运行期 import `@/core/access-control.js`**：那会让判定层一改就
 *   牵动工具层。本文件运行期依赖边只有一条：`helpers/` →（types）→ `core/types/proxy.ts`。
 * - **对同目录 `./target.js` 是正常运行期依赖**（`parseTargetParts` / `TargetParts`）：
 *   本文件**就是**「解析目标 → 定路由 → 选 dial」这条唯一入口，解析是它的第一手职责而不是
 *   别人的活。这条依赖本来就写在 `core/AGENTS.md` 的 helpers 依赖表里（`route → target`），
 *   层内兄弟依赖与「层不得反向依赖策略层」是**两条不同的纪律**。
 *   ⚠️ 曾经有一版把 `parseTargetParts` 提成调用方注入的 `parsed` 形参，理由是「收配置就得调
 *   解析器，那是实现依赖」——**那个前提是假的**（`route → target` 本来就存在），而且它把
 *   「对策略层必须 type-only」的纪律**误用到了同目录兄弟模块**上。后果是唯一入口被拆散：
 *   四处调用点各自要写一遍三步顺序、各自记住 `dial` 该怎么选，改一处漏三处。
 *
 * **模式门为什么在本文件、不在 `AccessControl.checkRoute`**（裁决，写下来免得下一个人再犯）：
 * `proxyMode` 是**路由模式**决定，与「谁被允许访问哪里」**正交**。把它塞进判定层——无论是让
 * `checkRoute` 去读 `proxyMode`，还是给 `AccessRouteInput` 补一个模式维度——都意味着
 * **每个自定义 `AccessControl`（限速引擎 / 地域引擎 / 订阅网关…）都得重新实现一遍模式门**：
 * 策略端口漏进了路由关切，那是比「工具层读配置」更坏的耦合。故 `RoutePolicy` 把 `mode` 作为
 * 配置事实与 `access` **并列**交给本文件，端口只回答「这个目标该直连吗」这一件事。
 *
 * 使用示例：
 * ```ts
 * import { resolveForwardTargets } from "@/core/helpers/route.js";
 *
 * const t = resolveForwardTargets(url, req.headers.host, policy, { upstream });
 * if (!t) return; // 发 target-unresolved + 400
 * // t.dial 拨号；t.dest 判名单；t.route.mode 决定后续分支
 * ```
 */

import type { AccessControl, AccessRouteDecision } from "@/core/types/proxy.js";
import { parseTargetParts, type TargetParts } from "./target.js";

/**
 * 路由判定的策略输入：只有两个事实，不含整个配置访问器
 * @description
 * 这两个维度**刻意不合并成端口**：
 * - `access` 是「谁被允许访问哪里」（可插拔的策略端口）
 * - `mode` 是「本部署配的是什么模式」（配置事实，**不属于**策略端口——让
 *   `AccessControl.checkRoute` 知道 `proxyMode` 会迫使每个自定义策略实现重写一遍模式门，
 *   详见文件头「模式门为什么在本文件」）
 *
 * 早期形态是整个 `ConfigAccessor`：那让这个纯函数「什么都能读」，是配置层的味道漏进了叶子。
 * 收窄到两个事实之后，本文件对配置的依赖**恰好只剩 `mode` 这一个键**，热路径上零 IO、零查询。
 * @param access - 访问控制端口，路由名单判定的唯一来源；必须由调用方显式注入
 * @param mode - 本部署配置的代理模式（调用方现读 `proxyMode` 后的值）
 */
export interface RoutePolicy {
  readonly access: AccessControl;
  readonly mode: "server" | "client";
}

/**
 * 路由判定的判定对象：只到 host/port 两维
 * @description
 * **刻意不收 `TargetParts`**：路由判定**只判 host**（名单条目不带端口），而 socks 通道手里只有
 * host 与 port——强收完整三元组（含必填的 `path`）只会逼调用方编造一个判定永远读不到的值，
 * 让签名看起来比实际需求更重。`port` 一并收下，是因为「客户端请求的目标」在日志/事件口径上
 * 本就是一个 host+port 对（`emitRoute` 按它拼 `target`），收全比让每个调用点各拼一次更稳。
 * @param host - 客户端请求的目标主机（判定对象；**上游地址永不进名单**）
 * @param port - 目标端口（判定不使用，随判定对象一起携带供日志/事件复用）
 */
export interface RouteInput {
  readonly host: string;
  readonly port: number;
}

/**
 * 拨号计划：client 模式下要拨的上游地址
 * @description
 * **刻意与 `RoutePolicy` 分成两个形参、而不是合并进 policy**：server 模式下这组地址根本不存在
 * （本部署压根没配上游），塞进 policy 等于逼每一个 server 模式部署编一个用不到的假上游。
 * 分开后 server 模式的调用点不必关心这份事实，client 模式的调用点则必须给真值——
 * 缺什么在类型上就看得出来。
 * @param upstream - 上游代理地址（`{ host, port }`），**只在有效模式为 client 时读**
 */
export interface DialPlan {
  readonly upstream: { readonly host: string; readonly port: number };
}

/**
 * 路由判定结果：本请求的「有效模式」与「直连还是交上游」
 * @description `reason` 随访问控制端口一起放宽为**自由 `string`**（名单语义为 `whitelist` /
 *   `blacklist`，替换实现可以是限速引擎、地理封锁等，它们要能表达自己的原因）。
 *
 *   **消费方必须原样透传：只有缺失/空串才跳过，绝不许加收窄。**
 *   库层唯一的判据是「有值就原样带上去」。**曾经这里写着「只认闭合集的收窄逻辑必须保留」，
 *   那是主动有害的建议、已撤销**——照着做的那份实现（旧的 `runtime/bridge.ts:aclReason`）
 *   对表外值**整条不发布** `access.target-denied`，于是一条真实的拒绝事实**从公共事件面上
 *   彻底消失**：它连「这里发生过什么」都不留痕，比「载荷里带一个没人认识的 reason」坏得多。
 *
 *   代价如实写：`reason` **不再有闭合集保证**，消费方**不能**拿它做穷尽 `switch`
 *   （正确写法是先比 `whitelist` / `blacklist`、其余落一个 `other` 桶）。**对内置引擎逐字不变**：
 *   `access-control.ts` 仍只出那两个值，CLI 落的 `[route]` 行也逐字不变。
 *   **闭合集纪律的落点已从消费者搬回生产者**——由 `hostDenied` 的源码级断言守着
 *   （只返回两个字面量），护栏在 `tests/unit/user-acl-merge.test.ts`。
 *
 *   ⚠️ **`reason` 的有无是承重契约，不许「顺手补齐」**：server 模式短路必须**不带** `reason`
 *   （见 `resolveRoute`），`forward/base:emitRoute` 的跳过条件正是 `mode === "server" && !reason`。
 * @param mode - 有效模式：直连恒 "server"；有效 client 走 "client"
 * @param route - 直连恒 "direct"；走上游为 "upstream"
 * @param reason - 因路由名单命中而回落直连时给出（自由文本）；server 模式短路**恒缺席**
 */
export interface RouteDecision {
  mode: "server" | "client";
  route: "direct" | "upstream";
  reason?: string;
}

/**
 * 拨号目标与客户端请求目标（client 模式两者不同：拨的是上游，名单判的是客户端要访问的站点）
 * @param dial - 实际拨号目标：有效模式为 server 即真实目标（client 配置但路由名单命中时同样直拨真实目标），
 *   有效模式为 client 才是 `dial.upstream`
 * @param dest - 客户端请求的目标（与 dial 同为名单判定对象）
 * @param route - 路由判定（有效模式 + direct/upstream + 名单命中原因），调用方后续分支一律以它为准
 */
export interface ForwardTargets {
  dial: TargetParts;
  dest: TargetParts;
  route: RouteDecision;
}

/**
 * 判定请求的路由：直连（不交上游）还是经 client 上游串联
 * @description 真值表（两种模式逐字不变）：
 * - `policy.mode === "server"` → **第一行就返回** `{ mode: "server", route: "direct" }`：
 *   **不查名单、不带 `reason`**。两条推论各自独立成立：不查名单是 server 模式的零开销短路
 *   （server 模式下 `upstream` 组本就没有任何含义）；**不带 `reason` 是承重契约**——
 *   `forward/base:emitRoute` 的跳过条件正是 `mode === "server" && !reason`，凭空多一个
 *   `reason` 会让 server 模式凭空多发一条 `route` 事件、多落一行 `[route]` 日志
 *   （护栏 `tests/integration/websocket-single-path.test.ts` 的「server 模式直连零条」钉的就是这条）
 * - client 模式 → `policy.access.checkRoute({ host })` 说直连（命中 upstream 路由名单）
 *   → `{ mode: "server", route: "direct", reason }`（**必带 reason**：这份回落有信息量，
 *   正是 `emitRoute` 要发出来的那条），命中即按 server 语义处理：
 *   拨号目标/path 形态/上游凭证/Host 回写/secure 标志全部自然回落；
 *   否则 → `{ mode: "client", route: "upstream" }`
 *
 * **模式门为什么在这里而不在判定层**：见文件头那一节——`proxyMode` 与「谁被允许访问哪里」正交，
 * 塞进 `AccessControl` 会让每个自定义策略实现重写一遍模式门。
 *
 * **为什么是同步纯函数、绝不许加 `async`/`await`**：它是**四条入站通道**（http/tunnel/
 * upgrade/socks）在拨号前必经的一步，返回值要立刻喂给「选哪个连接器 / 拒绝应答 / 发 `route` 事件」
 * 这一整串**同步**控制流。改成 async 会级联：每条通道各多一个 `await` 边界、
 * `resolveForwardTargets` 连带变 async、转发器入口签名与两阶段准入的时序全部要重排，
 * 为「将来也许要查个远程策略」付这个代价不划算。**需要远程查策略的诉求归 `identity` 端口**
 * （`identify` 本来就是 async），不归 `access`——身份判定的结果允许等，准入/路由判定不允许。
 *
 * - 纯函数不打日志：路由事实由各转发器在 preDial 通过后的分支处经 `emitRoute` 发事件
 *   （见 `forward/base:emitRoute`），落盘归 runtime 层（`src/runtime/event-log.ts:bindProxyEventLogs`）。
 * @param dest - 客户端请求的目标（**只判 host**，端口不参与）
 * @param policy - 策略输入（访问控制端口 + 本部署模式），必须由调用方显式注入
 * @returns 路由判定
 * @example resolveRoute({ host: "a.com", port: 80 }, { access, mode: "client" })
 * // upstream 名单未命中 → { mode: "client", route: "upstream" }
 * @example resolveRoute({ host: "a.com", port: 80 }, { access, mode: "server" })
 * // → { mode: "server", route: "direct" }（无 reason，且 access 一次都没被调用）
 */
export function resolveRoute(dest: RouteInput, policy: RoutePolicy): RouteDecision {
  if (policy.mode === "server") {
    return { mode: "server", route: "direct" };
  }

  const r: AccessRouteDecision = policy.access.checkRoute({ host: dest.host });
  if (r.direct) {
    return { mode: "server", route: "direct", ...(r.reason ? { reason: r.reason } : {}) };
  }
  return { mode: "client", route: "upstream" };
}

/**
 * 成对解析「拨号目标」与「客户端请求的目标」，并给出路由判定
 * @description
 * **本函数是「解析目标 → 定路由 → 按模式选 dial」这条唯一入口**，三步一体就是它存在的理由：
 * 顺序本身是契约（先解析才知道该拿谁去判名单、先定路由才知道该拨哪），拆给调用方等于把这条
 * 顺序复制到四处调用点、各自还会漂。所以它**自己**调 `parseTargetParts`（同目录运行期依赖），
 * 刻意**不接受**注入的解析器。
 *
 * 收敛 http.handle 与 upgrade.handle 逐字重复的两段三元解析：
 * - dest 先解析（绝对 URL 或 Host，与模式无关）→ `resolveRoute(dest, policy)` 出有效模式 →
 *   **按有效模式选 dial**：有效 client 才从 `dial.upstream` 读上游地址（path 保留客户端原始
 *   request-target，串联给上游代理必须 absolute-form），否则 dial = dest
 *   （直连；client 配置但路由名单命中同样直拨真实目标）；
 *   名单判定的永远是 `dest`，上游的协议/地址/端口**不受名单约束**
 * - 任一解析失败返回 null，由调用方发 `target-unresolved` 并回 400
 * - 调用方拿返回的 `route.mode`（有效模式）做后续分支，**不得再裸读 `get("proxyMode")`**
 * @param url - 请求行 target（可能是绝对 URL 或 origin-form 的 path）
 * @param hostHeader - Host 请求头（origin-form 时用于解析目标）
 * @param policy - 策略输入（访问控制端口 + 本部署模式），必须由调用方显式注入
 * @param dial - 拨号计划（client 模式的上游地址），只在有效模式为 client 时读
 * @returns 一对目标 + 路由判定，解析失败返回 null
 * @example resolveForwardTargets("http://a.com/x", "a.com", { access, mode: "client" }, { upstream })
 * // => { dial: {upstream...}, dest: {a.com...}, route: {mode:"client", route:"upstream"} }
 */
export function resolveForwardTargets(
  url: string | undefined,
  hostHeader: string | undefined,
  policy: RoutePolicy,
  dial: DialPlan,
): ForwardTargets | null {
  const dest = parseTargetParts(url ?? "", hostHeader);

  if (!dest) {
    return null;
  }

  const route = resolveRoute(dest, policy);

  if (route.mode === "client") {
    return {
      dial: {
        host: dial.upstream.host,
        port: dial.upstream.port,
        path: url ?? "/",
      },
      dest,
      route,
    };
  }

  return { dial: dest, dest, route };
}
