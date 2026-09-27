/**
 * @fileoverview 上游连接器端口定义（「怎么到达 dest」的抽象）
 * @module core/forward/upstream/connector/types
 * @description
 * 四条入站通道（http/tunnel/upgrade/socks）各自要按 `upstreamProtocol` 挑一种对接方式
 * （直连 / 经 http(s) 上游 CONNECT / 经 SOCKS 上游握手），而那三种方式**是同一件事的三个形态**。
 * 本目录把它们各抽成一个类，并在此定义它们对调用方的**唯一契约**：
 *
 * - {@link UpstreamKind}：逻辑上游协议（TLS 承载是**传输细节**，不是协议身份）
 * - {@link OpenContext}：打开一条到 `dest` 的字节管道所需的**全部**输入
 * - {@link OpenedUpstream}：建链事实（socket / 上游先发字节 / 上游是否拒绝建链）
 * - {@link UpstreamConnector}：连接器本体
 * - {@link ConnectorSource}：连接器的**供给方式**（装配期已解析完毕的「直连 / 走上游」两档）
 *
 * 下面只留**改端口前最容易踩**的四条：
 * 1. `OpenContext` 刻意没有 `viaUpstream` 标志位（`kind === "direct"` 就是 connector 唯一的身份
 *    声明）也没有 `user` 身份字段（`HelperEvent` 载荷里没有这个维度，身份一律由 channel 的
 *    `scope.emit` 逐会话附带）；`clientLifetime` 则是**必须申报**的那一个——只有 channel 知道
 *    这次要的是隧道还是每请求新建的传输层，connector 无从推断，故只透传不自己设默认值。
 * 2. `targetForm` / `upstreamAuthHeader()` / `selfLoopTarget()` 都是**声明**（这个 connector 是谁）
 *    而不是**动作**（打开一条管道）：不读调用方状态、不接受入参。**成败应答的协议形态刻意留在
 *    channel**（连接器不认入站协议）。
 * 3. `peerTarget(dest)` 带参而 `selfLoopTarget()` 无参，是**两种形状的刻意并存**（决策清单第 3 条）。
 * 4. 「用哪个连接器」在**装配期**定死成两档，`upstream()` 不收任何协议形参、**每请求查表不存在**
 *    （决策清单第 2 条）；未登记协议的 fail-closed 抛点固定在**请求期**（硬约定末条，论证全文见
 *    `registry.ts` 模块头）。
 *
 * 依赖：本文件只 type-only 引 `node:stream`（`Duplex`）与 `@/core/guard.js`
 * （`HelperEventSink`），**端口零运行期依赖边**；实现类才引 `forward/upstream/dial.js`。
 */

import type { Duplex } from "node:stream";
import type { ClientLifetime, HelperEventSink } from "@/core/guard.js";

/**
 * 逻辑上游协议：TLS 承载不参与身份（`sockss4` 的 kind 即 `socks4`）
 *
 * @description
 * **这个闭合集是刻意的编译期强制，不许放宽成 `string`**。理由不是「整齐」，而是：第三方实现
 * {@link ConnectorSource} 时必须从这 5 个值里挑一个，而每个取值在 core 里都有**硬编码消费点**、
 * **选错值不会编译报错、只会静默走错分支**。放宽成 `string` 等于把「选错 → 编译期红」换成
 * 「选错 → 静默走错分支」。逐个取值：
 * - `direct`：`channel/http.ts` `forwardViaTransport` 的 Host **条件回写**分支（客户端发
 *   absolute-form 时才回写）+ `channel/socks.ts` `connect` 的直连分支判别。选成别的值 → 落到
 *   **无条件回写**分支，或跳过直连分支直接进 `targetForm` 分支。
 * - `http` / `https`：TLS 承载错配的形态——明文 `http` 拨 TLS 上游 / `https` 拨明文上游，报文全在
 *   明文或全在密文里。
 * - `socks4` / `socks5`：`channel/socks.ts` 的日志版本号 `connector.kind === "socks4" ? 4 : 5`
 *   （`(socks5->socks4)` 那段，**逐字契约**）+ `channel/upgrade.ts` 的 `isSocksTunnel`
 *   （失败日志的 `"via socks "` 尾巴，**逐字契约**）。选错 → 落盘日志与实际握手版本不符 /
 *   尾巴对不上「这一跳走没走 SOCKS」。**两者的唯一差别就是这两处**：选 `socks4` 给一个跑 RFC1928
 *   子协商的上游，日志会系统性说谎。
 *
 * **两条推论必须同时成立**：
 * - ① `kind` 与 {@link UpstreamConnector.targetForm} 是两个独立字段、端口对二者零约束（内置实现
 *   恰好自洽，但那是事实不是契约）。所以**「对端是不是代理」必须读 `targetForm`，绝不能从 `kind`
 *   推**——`upgrade.ts` 曾用 `mode === "client" && !isSocksTunnel(connector)` 推，那是绕过端口的
 *   第二判据，一个 `kind:"https"` + `targetForm:"origin"` 的「隧道中继型」替身就能让它把上游
 *   Basic 凭证发给真实目标站（护栏：`tests/integration/forwarder-connector-wiring.test.ts` 的
 *   「隧道中继型」那条）。同理**上游凭证只由 `upstreamAuthHeader()` 决定**。
 * - ② 上表不是「文档里的历史」，是**当前源码的事实**：给 `kind` 加新取值、或改动任何一处硬编码
 *   消费点时，两边一起改。
 */
export type UpstreamKind = "direct" | "http" | "https" | "socks4" | "socks5";

/**
 * 打开一条到 dest 的字节管道所需的全部输入
 *
 * @description
 * 刻意**不含** `viaUpstream` 标志位：「用 direct 连接器」与「有效路由是 direct」是同一件事，
 * `resolveRoute` 已判定（`route.route === "direct"` ⟺ 该拨真实目标），传标志位只会让 connector
 * 拿到「自己的身份」与「调用方声称的路由身份」两份可能互相矛盾的输入。
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
   * @description
   * **必填**（历史遗留的 `?` + 三处 `?? DEFAULT_LOG_PREFIX` 已删）：缺省那份 `"tunnel"` 零调用方，
   * 却在三个连接器里各抄了一份常量——同一份没人用的兜底抄三遍，没有存在理由。
   * 四个 channel 恒传各自的通道名（`"http"` / `"tunnel"` / `"socks"` / `"upgrade"`），而这四个字面量
   * 是**落盘日志文本契约**（`forwarder-connector-wiring` 逐字断言 `[upgrade] error …`）。
   *
   * **刻意不由入站派发表统一给**（① 派发表现只覆盖三个 `server.on` 事件、SOCKS 根本不在表里；
   * ② 本字段的使用点在转发器深处，要由派发表给就得给四个入口逐请求加形参，等于把一个**通道的
   * 编译期常量**降级成**调用方可能传错的每请求参数**）：故它留在 channel 侧如实申报。
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
 * connector **只如实报告事实**，不替调用方决定成败应答：`refusal` 的处置形态刻意按通道分两种
 * （tunnel 是「原样透传 `head`+`rest` 给客户端再销毁上游」、socks 是「发 `upstream-refused` 事件
 * + 回 SOCKS 失败应答再销毁上游」）。
 */
export interface OpenedUpstream {
  /** 已建链的上游 socket */
  readonly sock: Duplex;
  /**
   * 上游先发字节（server-speaks-first）：握手应答（CONNECT 响应头 / SOCKS 应答）之后上游已发出的字节
   *
   * @description 只认 CONNECT 响应头一种情形；无则空 Buffer。直连与 SOCKS 恒为空
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
 * 六个 `ProxyProtocol`（http/https/socks4/sockss4/socks5/sockss5）映射到四个类（TLS 承载是构造参数、是传输细节，故 `kind` 归一到逻辑协议）
 * （映射表是 `registry.ts:PROTOCOL_FACTORIES`，由 {@link ConnectorSource} 装配期取出）
 */
export interface UpstreamConnector {
  /** 逻辑上游协议身份（`sockss*` 的 kind 就是 `socks4`/`socks5`），四个类由 `registry.ts` 装配期取出 */
  readonly kind: UpstreamKind;
  /**
   * 对端是「代理」还是「源站」：决定出站 request-target 形态
   *
   * @description
   * - `absolute`：request-target 保留 absolute-form（发的是**代理**，它需要完整 URL 才能转发）
   * - `origin`：origin-form + Host 头（直连源站；SOCKS 隧道也直达源站，故同属 `origin`；
   *   **「中间有一跳中继、终点仍是源站」的连接器同样属于这一档**）
   *
   * **这是「对端是不是代理」的唯一判据，绝不许从 {@link kind} 推**——`kind:"https"` +
   * `targetForm:"origin"` 编译期完全合法，那正是「隧道中继型」连接器。两个方向错判各自的后果、
   * 以及上游凭证同样只由 `upstreamAuthHeader()` 决定，见 {@link UpstreamKind}。
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
   * 配合 `http.request({ createConnection })` 使用（`http.ts` 的单一路径，**Upgrade 通道也用它**）：
   * - **direct / socks4 / socks5**：与 `open()` 同源（取 `open().sock`；`rest` 契约上恒空）
   * - **http / https**：只拨号到 `upstreamHost:upstreamPort`（`secure` 决定 net/tls），
   *   **不发 CONNECT、不等状态行**——对端就是上游代理本身，HTTP 报文由 Node 自己写
   *
   * **TLS 承载因此永远是「连接器建传输层时的事」**：返回值已是握手完成的 `net.Socket`/`TLSSocket`
   * （拨号的空闲超时已按 `established()` 交出），`http.request` 侧**不再注入任何 TLS 选项**——那会出现
   * 两处协商。失败一律 reject（成因语义与 `open()` 一致：超时为 `DialTimeoutError`），
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
   * 是**纯查询**：不建立连接、不发事件。
   *
   * **刻意带 `dest` 而 {@link selfLoopTarget} 无参**——两个成员是**两种形状的刻意并存**，
   * 不是签名不一致（两个成员是「传进来的目标」与「连接器自己的对端」两种身份，刻意并存）。
   * @param dest - 本次请求的真实目标（客户端请求的目标，不是上游地址）
   */
  peerTarget(dest: OpenContext["dest"]): { host: string; port: number };
  /**
   * 上游 HTTP 代理的 Basic 凭证头值；直连与 SOCKS 一律返回 undefined（凭证走 SOCKS 握手而非 HTTP 头）
   *
   * @description
   * **上游凭证注入与否的唯一判据**：`http.ts` 与 `upgrade.ts` 两条通道都只判「有没有」，
   * **绝不**自己读 `upstreamUsername` 算一遍（猜错的方向是「代理自己的凭证被原样发给真实目标站」）。
   * 返回 `undefined` 就是**本次不该给**，与「本连接器是不是代理型」是两件事。
   */
  upstreamAuthHeader(): string | undefined;
  /**
   * 上游地址（仅代理型，用于上游自环预检）；直连返回 undefined
   *
   * @description 上游自环预检的**唯一**数据源——channel 不许回头读 `UPSTREAM_HOST`/`UPSTREAM_PORT`
   * 去猜（那正是「自己读配置猜上游地址」的第二真相源）。
   */
  selfLoopTarget(): { host: string; port: number } | undefined;
}

/**
 * 上游接入来源：**装配期**已解析完毕的两个连接器。
 * @description
 * 「无上游直连」与「走上游」在这里是**同一张表的两行**，不是三元式的两支——它本来只是
 * 「走上游」的一个取值（否掉了「直连要不要单独一条快路径」）。
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
   * **抛点固定在请求期而不是装配期**：`proxyMode: "server"` 下有效路由恒 direct，本方法一次都不会
   * 被调，上游那组字段根本不被读；装配期就为它抛，等于让「上游字段填错」打挂一个压根不上游的
   * 服务。论证全文见 `registry.ts` 模块头。
   */
  upstream(): UpstreamConnector;
}
