/**
 * @fileoverview 上游连接器端口定义（「怎么到达 dest」的抽象）
 * @module core/forward/upstream/connector/types
 * @description
 * 四条入站通道（http/tunnel/upgrade/socks）各自要按 `upstreamProtocol` 挑一种对接方式
 * （直连 / 经 http(s) 上游 CONNECT / 经 SOCKS 上游握手），而那三种方式**是同一件事的三个形态**。
 * 本目录把它们各抽成一个类，并在此定义它们对调用方的**唯一契约**：
 *
 * - {@link UpstreamKind}：逻辑上游协议（TLS 承载是**传输细节**，不是协议身份，故
 *   `sockss4` 的 kind 是 `socks4`、`https` 的 kind 是 `https` 而不带 TLS 标记）
 * - {@link OpenContext}：打开一条到 `dest` 的字节管道所需的**全部**输入
 * - {@link OpenedUpstream}：建链事实（socket / 上游先发字节 / 上游是否拒绝建链）
 * - {@link UpstreamConnector}：连接器本体
 * - {@link ConnectorSource}：连接器的**供给方式**（装配期已解析完毕的「直连 / 走上游」两档）
 *
 * 四个关键设计裁决（改端口前必须先理解，否则会重新引入第二真相源）：
 *
 * 1. **`OpenContext` 刻意没有 `viaUpstream` 标志位，也没有 `user` 身份字段。**
 *    「用 direct 连接器」与「有效路由是 direct」是**同一件事**——`resolveRoute` 已判定：
 *    `route.route === "direct"` ⟺ 该拨真实目标。传标志位会让 connector 拿到「自己的身份」
 *    和调用方声称的「路由身份」两份可能互相矛盾的输入，那正是要消灭的第二真相源。
 *    connector 的 `kind === "direct"` 就是它唯一的身份声明。
 *
 *    `user` 同样刻意不存在：唯一的出事件通道 `HelperEventSink` 收的是 `HelperEvent`
 *    （载荷只有 `type`/`message`/`err`，**没有 user 字段**），身份一律由 channel 侧的
 *    `ForwarderBase.emitWithUser` 逐会话附带（每会话新建的 sink 闭包或显式传参），
 *    connector 既不需要也拿不到它。
 *
 *    `clientLifetime` 则是**必须申报**的那一个：它是「这条管道与入站客户端是不是同一条
 *    生命周期」的事实，只有 channel 知道（`open()` 的隧道用途 vs `transport()` 的请求用途），
 *    connector 无从推断，故一律透传给拨号守卫，不自己设默认值。
 *
 * 2. **`targetForm` / `upstreamAuthHeader()` / `selfLoopTarget()` 是声明式数据**，
 *    不读调用方状态、不接受入参。HTTP 请求层据此决定 request-target 形态
 *    （`absolute` = 发给代理 / `origin` = 直达源站）以及是否注入上游凭证；
 *    上游自环预检据此拿 `selfLoopTarget()`。它们都是**声明**（这个 connector 是谁），
 *    不是**动作**（打开一条管道）。
 *
 * 3. **连接器不知道入站协议**（http / CONNECT / upgrade / socks）。
 *    端口里只有 `client`（双工流）+ `dest` + 事件汇，成败应答的**协议形态**
 *    （HTTP 200 / SOCKS replySuccess / 等 101）刻意留在 channel——
 *    那是「各协议应答形态」这个刻意不收的差异面（见 `src/core/AGENTS.md`
 *    「刻意不收的」），不是「怎么到达 dest」。
 *
 * 4. **`open()` 与 `transport()` 是两种「要什么」**，不是两种实现：
 *    - `open()`：给我一条到 dest 的**字节管道**（CONNECT / Upgrade / socks 入站都是它，
 *      拿到 socket 就自己桥接，成败应答由 channel 写）；
 *    - `transport()`：给我一条到「**本连接器的对端**」的**传输层**连接，**不做协议级协商**。
 *      `http.ts` 经 `http.request({ createConnection })` 用它——Node 自己负责请求分帧与
 *      响应解析，而连接由连接器建（代理型即上游地址，直连/SOCKS 即目标地址）。
 *    TLS 承载因此**永远是「连接器建传输层时的事」**：`transport()` 的返回值已经是
 *    握手完成的 `net.Socket`/`TLSSocket`，`http.request` 侧**不再注入任何 TLS 选项**。
 *    `peerTarget(dest)` 是与 `transport()` 配套的声明式数据：这条管道**实际落到哪个 TCP 对端**，
 *    供调用方给 `http.request` 的 `host`/`port` 与失败日志路由用（代理型 = 上游地址）。
 *
 *    `peerTarget` 刻意**带 `dest` 参数**而 `selfLoopTarget()` 无参：后者答的是
 *    「**我自己的**上游地址」（纯配置事实，连接器独占），前者答的是「本次请求的传输对端」——
 *    对直连/SOCKS 它就是 `dest`，是**请求作用域的事实**、连接器并不拥有它，
 *    无参就无从回答。传 `dest` 而非整个 `OpenContext`，是为了让这个纯查询不必拖上
 *    `client`/`onEvent`（声明式方法不该有机会去碰事件汇）。
 *    两个成员因此是**两种形状的刻意并存**，不是签名不一致。
 *
 * 5. **`ConnectorSource` 是「用哪个连接器」这件事的端口**。
 *    `UPSTREAM_PROTOCOL` 是 **startup 相位**字段，构造后不再变，所以「按协议查连接器」
 *    天然是**装配期**的一件事。**每请求查表不许存在**：害处有两条——请求路径白读一个启动后
 *    恒定的键，且读代码的人会以为它是可热改的。端口把这件事在装配期定死，
 *    请求路径只问**两档**（「直连」还是「走上游」）。
 *
 * 依赖：本文件只 type-only 引 `node:stream`（`Duplex`）与 `@/core/guard.js`
 * （`HelperEventSink`），编译期擦除、零运行期依赖边。实现类才引 `forward/upstream/dial.js`。
 *
 * 使用示例（跨目录请走 `@/core/forward/upstream/connector/index.js`）：
 * ```ts
 * import {
 *   createConnectorSource,
 *   type UpstreamConnector,
 * } from "@/core/forward/upstream/connector/index.js";
 *
 * // 装配期一次：直连与走上游两个连接器在此定死
 * const connectors = createConnectorSource(ctx);
 *
 * // 请求期只问「哪一档」，不再读 upstreamProtocol
 * const connector: UpstreamConnector =
 *   route.route === "direct" ? connectors.direct() : connectors.upstream();
 *
 * const { sock, rest, refusal } = await connector.open({
 *   client: socket,
 *   dest: { host: "example.com", port: 443 },
 *   onEvent: (e) => emit(e),
 *   logPrefix: "tunnel",
 * });
 * ```
 */

import type { Duplex } from "node:stream";
import type { ClientLifetime, HelperEventSink } from "@/core/guard.js";

/**
 * 逻辑上游协议：TLS 承载不参与身份（`sockss4` 的 kind 即 `socks4`）
 *
 * @description
 * **这个闭合集是刻意的编译期强制，不许放宽成 `string`。** 理由不是「整齐」，而是：
 * 第三方实现 {@link ConnectorSource} 时**必须从这 5 个值里挑一个**，而挑的过程会撞上
 * 下面这张**行为分叉表**——每个取值都在 core 里有硬编码消费点，**选错值的代价是静默走错分支**。
 * 放宽成 `string` 等于把「选错值 → **编译期红**」换成「选错值 → **静默走错分支**」，后者危险得多。
 *
 * | `kind`         | 谁硬编码消费它                                                                                                              | 各自什么后果                                                                                                                                                                        |
 * | -------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
 * | `"direct"`     | ① `channel/http.ts` `forwardViaTransport` 的 Host 回写分支                                                                        | 走 RFC 7230 §5.4 **条件回写**（客户端发 absolute-form 时才按 request-target 回写 Host）。选成 `socks4`/`http` 会落到**无条件回写**分支          |
 * |                | ② `channel/socks.ts` `connect` 的三条上游分支判别                                                                                 | `=== "direct"` 走直连分支（成功文案 `[socks] tunnel established …`）。选成别的值会跳过直连分支、直接进下面的 `targetForm` 分支                        |
 * | `"http"`       | `channel/upgrade.ts` 之外的路径**不再读它**；`http-connect.ts` 由 `secure` 构造参数推 `kind`                                     | TLS 承载错配的形态：明文 `http` 拨 TLS 上游 / `https` 拨明文上游，报文全在明文或全在密文里                                                                                          |
 * | `"https"`      | 同上                                                                                                                                  | 同上                                                                                                                                                                                |
 * | `"socks4"`     | ① `channel/socks.ts` 的日志版本号 `connector.kind === "socks4" ? 4 : 5`（`(socks5->socks4)` 那段，**逐字契约**）                | 版本号写错 → 落盘日志与实际握手版本不符，排障时照着日志去抓错误的字节                                                                                                                 |
 * |                | ② `channel/upgrade.ts` `isSocksTunnel`（`kind` 是 socks4/5 → 失败日志带 `"via socks "` 尾巴，**逐字契约**）                    | 尾巴丢/多 → 守卫 route 文本与「这一跳走没走 SOCKS」对不上                                                                                                                              |
 * | `"socks5"`     | 同 `socks4`                                                                                                                                                                                    | 同 `socks4`                                                                                                                                                                          |
 *
 * **两条推论必须同时成立**：
 * - ① `socks4` 与 `socks5` 的**唯一**差别是那两处（版本号 + 是否 SOCKS 隧道）。选 `socks4` 给一个跑
 *   RFC1928 子协商的上游，日志会系统性说谎；选 `socks5` 给一个 4a 上游，同理。
 * - ② **`kind` 与 {@link UpstreamConnector.targetForm} 是两个独立字段、端口对二者零约束**（内置
 *   实现恰好自洽，但那是事实不是契约）。所以**「对端是不是代理」必须读 `targetForm`，绝不能从
 *   `kind` 推**——`upgrade.ts` 曾用 `mode === "client" && !isSocksTunnel(connector)` 推，
 *   那是绕过端口的第二判据，一个 `kind:"https"` + `targetForm:"origin"` 的「隧道中继型」替身
 *   就能让它把上游 Basic 凭证发给真实目标站（护栏：
 *   `tests/integration/forwarder-connector-wiring.test.ts` 的「隧道中继型」那条）。
 *   同理**上游凭证只由 {@link UpstreamConnector.upstreamAuthHeader} 决定**，不许在 channel 里
 *   读 `upstreamUsername` 自己算一遍。
 *
 * ⚠️ 上表不是「文档里的历史」，是**当前源码的事实**。给 `kind` 加新取值、或改动任何一处硬编码
 * 消费点时，两边一起改。
 */
export type UpstreamKind = "direct" | "http" | "https" | "socks4" | "socks5";

/**
 * 打开一条到 dest 的字节管道所需的全部输入
 *
 * @description
 * 刻意**不含** `viaUpstream` 标志位：connector 的 `kind` 就是它的身份，
 * 「有效路由是 direct」与「用 direct 连接器」是同一件事（见模块头裁决 1）。
 */
export interface OpenContext {
  /** 客户端双工流，仅供拨号守卫联动取地址；connector 绝不允许向它写任何字节 */
  readonly client: Duplex;
  /** 真实目标（客户端请求的目标，不是上游地址） */
  readonly dest: { host: string; port: number };
  /** 守卫/等待事件汇；只上抛事实，不打日志 */
  readonly onEvent: HelperEventSink;
  /**
   * 日志前缀：守卫事件与等应答超时的文案前缀（`[<logPrefix>] timeout <route>` 等）
   *
   * @description **必填**（历史遗留的 `?` + 三处 `?? DEFAULT_LOG_PREFIX` 已删）。
   *
   * 四个 channel 恒传各自的通道名（`"http"` / `"tunnel"` / `"socks"` / `"upgrade"`），
   * 而这四个字面量是**落盘日志文本契约**的一部分（`forwarder-connector-wiring` 逐字断言
   * `[upgrade] error …`）。缺省那份 `"tunnel"` 从来没被任何调用方触发过，
   * 却在三个连接器里各抄了一份常量——**同一份没人用的兜底抄三遍**。
   *
   * **为什么不由入站派发表统一给**：① 派发表现只覆盖三个 `server.on` 事件，
   * **SOCKS 根本不在表里**（它不是 Node 事件，是连接内的握手状态机），那条通道的
   * `"socks"` 前缀无处可取；② 本字段的使用点在**转发器深处**（`openUpstream` /
   * `transportVia` / `openVia` / `forwardViaTransport`），要由派发表给就得给四个
   * `handle()` 逐请求加一个形参——把一个**通道的编译期常量**降级成**调用方可能传错的
   * 每请求参数**，是纯粹的退化。故它留在 channel 侧，由 channel 如实申报自己是谁。
   */
  readonly logPrefix: string;
  /**
   * `ctx.client` 与本管道**是否同一条生命周期**（缺省 `"linked"`，即隧道语义）
   *
   * @description
   * 由 channel 如实申报「我要的是什么」，connector 只负责透传给拨号守卫：
   * - 隧道三通道（CONNECT / upgrade / SOCKS 会话）**省略**——管道两端就是同一个资源；
   * - **http 普通请求通道显式传 `"independent"`**（唯一使用方）：那里的上游 socket 是
   *   每请求新建的传输层，而 `ctx.client` 是 Node `http`/`tls` 服持有的长连接。上游关闭
   *   不得回敬客户端连接，否则客户端的入站 keep-alive 会被源站单方面关连接的动作打死。
   *
   * 语义细节（为什么存在、为什么不能挪到隧道路径）见 `DialGuardOptions.clientLifetime`。
   */
  readonly clientLifetime?: ClientLifetime;
}

/**
 * 建链事实：已建链的上游 + 上游在握手应答之后已经发出的字节 + 上游是否拒绝建链
 *
 * @description
 * connector **只如实报告事实**，不替调用方决定成败应答：
 * `tunnel.viaHttp` 在 `refusal` 存在时是「原样透传 `head`+`rest` 给客户端再销毁上游」，
 * 在 `socks.connect` 是「发 `upstream-refused` 事件 + 回 SOCKS 失败应答再销毁上游」——
 * 协议形态不同，故留在 channel。
 */
export interface OpenedUpstream {
  /** 已建链的上游 socket */
  readonly sock: Duplex;
  /**
   * 上游先发字节（server-speaks-first）
   *
   * @description
   * 即握手应答（CONNECT 响应头 / SOCKS 应答）之后上游已经发出的字节。
   * 只认 CONNECT 响应头一种情形；无则空 Buffer。直连与 SOCKS 恒为空
   * （它们的应答长度固定、无「头之后还有余量」这回事）。
   */
  readonly rest: Buffer;
  /**
   * 上游拒绝建链（仅 http-connect 的非 200 应答）；成功时不出现
   *
   * @description
   * 存在时**必须走拒绝路径**（透传/回失败应答后销毁 `sock`），不得拿去建隧。
   * `rest` 与 `OpenedUpstream.rest` 此时是**同一缓冲**（都描述响应头之后上游发出的字节），
   * 重复暴露是为了让 channel 在拒绝分支不必去猜该读哪个字段。
   */
  readonly refusal?: { statusCode: string; head: Buffer; rest: Buffer };
}

/**
 * 上游连接器：把「怎么到达 dest」这件事收进一个可替换的对象
 *
 * @description
 * 六个 `ProxyProtocol`（http/https/socks4/sockss4/socks5/sockss5）映射到四个类
 * （映射表在 `registry.ts:PROTOCOL_FACTORIES`，由 {@link ConnectorSource} 装配期取出）；
 * TLS 承载是构造参数（传输细节），故 `kind` 归一到逻辑协议。
 */
export interface UpstreamConnector {
  /** 逻辑上游协议身份（`sockss*` 的 kind 就是 `socks4`/`socks5`） */
  readonly kind: UpstreamKind;
  /**
   * 对端是「代理」还是「源站」：决定出站 request-target 形态
   *
   * @description
   * - `absolute`：request-target 保留 absolute-form（发的是**代理**，它需要完整 URL 才能转发）
   * - `origin`：origin-form + Host 头（直连源站；SOCKS 隧道也直达源站，故同属 `origin`；
   *   **「中间有一跳中继、终点仍是源站」的连接器同样属于这一档**）
   *
   * ⚠️ **这是「对端是不是代理」的唯一判据，绝不许从 {@link kind} 推**。`kind` 与本字段是
   * 两个独立声明式字段、端口对二者零约束（`kind: "https"` + `targetForm: "origin"` 编译期
   * 完全合法，那正是「隧道中继型」连接器）。理由与两个方向错判各自的后果见 {@link UpstreamKind}。
   */
  readonly targetForm: "absolute" | "origin";
  /**
   * 打开一条到 `ctx.dest` 的字节管道
   *
   * @description
   * 拨号失败 / 握手失败 / 等应答超时一律 **reject**（不吞）：调用方据异常成因
   * 分流 504（`DialTimeoutError`）/ 502。绝不在本方法内向 `ctx.client` 写字节。
   */
  open(ctx: OpenContext): Promise<OpenedUpstream>;
  /**
   * 打开一条到「本连接器对端」的**传输层**连接，**不做协议级协商**
   *
   * @description
   * 配合 `http.request({ createConnection })` 使用（`http.ts` 的单一路径）：
   * - **direct**：与 `open()` 同源（取 `open().sock`；`rest` 契约上恒空）
   * - **http/https**：只拨号到 `upstreamHost:upstreamPort`（`secure` 决定 net/tls），
   *   **不发 CONNECT、不等状态行**——对端就是上游代理本身，HTTP 报文由 Node 自己写
   * - **socks4/socks5**：等价于 `open()`（隧道直达 dest）
   *
   * 返回的 socket 已经是**稳态**连接（TLS 已握手、拨号的空闲超时已按
   * `established()` 交出），调用方直接交给 `createConnection` 即可。
   * 失败一律 reject（成因语义与 `open()` 一致：超时为 `DialTimeoutError`）。
   * 绝不向 `ctx.client` 写任何字节。
   */
  transport(ctx: OpenContext): Promise<Duplex>;
  /**
   * 本连接器实际会连到的 TCP 对端：代理型 = 上游地址；直连/SOCKS = 目标地址
   *
   * @description
   * 供 `http.ts` 给 `http.request` 的 `host`/`port`（Node 据此算默认 Host 与 agent 名）
   * 与上游失败日志路由；也用于「传输对端 ≠ 有效拨号地址时补判自环」
   * （SOCKS 隧道直达 dest，而 client 模式的 `dial` 是上游）。
   * 是**纯查询**：不读配置以外的任何东西、不建立连接、不发事件。
   * @param dest - 本次请求的真实目标（客户端请求的目标，不是上游地址）
   */
  peerTarget(dest: OpenContext["dest"]): { host: string; port: number };
  /**
   * 上游 HTTP 代理的 Basic 凭证头值；直连与 SOCKS 一律返回 undefined（凭证走 SOCKS 握手而非 HTTP 头）
   *
   * @description
   * **上游凭证注入与否的唯一判据**：`http.ts` 与 `upgrade.ts` 两条通道都只判「有没有」，
   * **绝不**自己读 `upstreamUsername` 算一遍（那是绕过端口的第二判据，猜错的方向是
   * 「代理自己的凭证被原样发给真实目标站」）。返回 `undefined` 就是**本次不该给**，
   * 与「本连接器是不是代理型」是两件事——判据在本方法，不在调用方。
   */
  upstreamAuthHeader(): string | undefined;
  /** 上游地址（仅代理型，用于上游自环预检）；直连返回 undefined */
  selfLoopTarget(): { host: string; port: number } | undefined;
}

/**
 * 上游接入来源：**装配期**已解析完毕的两个连接器。
 * @description
 * 「无上游直连」与「走上游」在这里是**同一张表的两行**，不是三元式的两支——历史上
 * `route.route === "direct" ? directConnector(ctx) : connectorFor(proto, ctx)` 那个三元
 * 把「直连」写成了特例，而它本来就只是「走上游」的一个取值。
 *
 * **为什么在装配期就定死**：上游协议是 startup 相位字段（`FIELDS.keysByPhase().startup`
 * 决定，accessor 对它读 runtime 构造时的冻结值），每请求重读既浪费，也与
 * 「startup 键不随 store 热改变变」这条不变量冲突——那会让人以为它可热改。
 *
 * **可注入性**：库调用方实现本接口即可完全替换上游接入（自研协议、隧道中继、代理链…），
 * **不必碰配置文件**。默认实现由 `registry.ts:createConnectorSource(ctx)` 造出。
 *
 * **「两行」说的是端口形状，不是内部表**：`direct` 不是 `ProxyProtocol` 的取值，
 * 故它不进那张协议表，由工厂直接 `new DirectConnector(ctx)`。
 */
export interface ConnectorSource {
  /**
   * 无上游直连。
   * @description 恒返回同一个实例（连接器无状态、可安全复用），永不抛错。
   */
  direct(): UpstreamConnector;
  /**
   * 走上游：协议取 startup 相位的 `upstreamProtocol`，装配期已定死。
   * @description
   * **不收任何协议参数**——「这个部署走上游是什么协议」是装配期的一个事实，不存在
   * 「逐请求换一个协议」这种形态（那正是本端口要消灭的每请求查表）。真需要按请求分流
   * （不同目标走不同上游、代理链）**自己实现本接口并注入**，别往这里加形参。
   *
   * **未登记的协议 fail-closed 抛错**，绝不静默回落直连（「静默直连 = 流量旁路」：
   * 服务照跑、请求照成功，但流量根本没走你配的链路——比直接报错糟糕得多）。
   *
   * **抛在请求期而不是装配期**：`proxyMode: "server"` 下有效路由恒 direct，本方法一次都不会
   * 被调，上游那组字段根本不被读；装配期就为它抛，等于让「上游字段填错」打挂一个压根不上游的
   * 服务。想要「启动就报错」，正确位置是配置校验层（CLI 路径的 `FIELDS.parseEnum` 已经
   * fail-fast；库路径的 `ConfigStore` 零校验，那是库调用方自己的责任）。
   * 论证全文见 `registry.ts` 模块头。
   */
  upstream(): UpstreamConnector;
}
