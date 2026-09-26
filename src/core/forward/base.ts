/**
 * @fileoverview 转发器公共基类（`forward/` 根，唯一不在 `channel/` 或 `upstream/` 里的文件）
 * @module core/forward/base
 * @description
 * 两条轴的公共基类。**目录按轴分**（`forward/channel/` 是四条入站通道、`forward/upstream/`
 * 是上游对接），本类横跨两轴且**不属任何一轴**，故刻意留在 `forward/` 根——它是「通道共享的
 * 前置接线」那份东西的家，搬进 `channel/` 会让基类反过来依赖自己的子类所在目录。
 *
 * 四条通道（`channel/{http,tunnel,upgrade,socks}.ts`）共享的拨号器与重复胶水收敛到一处：
 * - `services`：**core 需要的三个可替换服务打成一个包**（`CoreServices` = 身份 / 访问控制 /
 *   流量账本，见下方「为什么 `services` 是一个包」一节）
 * - `connectors`：**装配期**已解析完毕的连接器源（`ConnectorSource`，两档：直连 / 走上游）
 * - `dialer`：共享 `Dialer` 实例（无状态）。**自 2c 起它只服务一个成员 `bridge`**
 *   （本类的 `bridgeWithBuffered` 与 `WsForwarder.relay` 两个调用点）。「怎么到达 dest」
 *   一律经 `forward/upstream/connector/`——上游协议实现全住在 `forward/upstream/connector/<协议>.ts`，
 *   `Dialer` 本身是纯传输层（建链 + 桥接）
 * - 发事件：**一律经 `scope.emit(e)`**（`RequestScope` 的逐请求闭包，身份维度只在
 *   `createRequestScope` 里注一次）。本类**不再持有 `emit` 字段，也不再有 `emitWithUser`**
 *
 * **两条「请求期怎么拼装策略」的接线也收在这里**：`routePolicy`（访问控制端口 +
 * 配置模式）与 `upstreamEndpoint`（上游地址）。它们刻意只有这一个出处——见各自注释里
 * 「为什么不让 channel 自己去读」那一段。
 *
 * **前置接线族**（四条通道逐条同形，故收在这里；`channel/*.ts` 里已不再出现「选连接器」
 * 与「补判 preDial」这两件事）：
 * - `connectorForRoute`：按有效路由选连接器——**四条通道唯一的选法**
 * - `preDialPeerTarget`：传输对端 ≠ 有效拨号地址时补判一次 `preDial`（保住「真实目标自环」判定）
 * - `preDial` / `denyUpstreamLoop` / `settleDenied`：守卫本体、上游自环预检、拒绝终态结算
 * - `emitRoute`：client 模式路由事件（`route` → runtime 层落 `[route]` info 行）——preDial 通过后的路由分支处每请求恰发一条，server 模式短路不发
 * - `settleDialFailure`：拨号失败的「协议应答 + `fail(stage="dial")` 终态」骨架
 *
 * **应答形态与事件载荷刻意留在各通道**（`refuse` 之外的每一处协议应答、`upstream-error`
 * 的文案与是否带 `err`）：形态 4 种、载荷 3 种，强行模板化只会得到参数爆炸的假抽象；
 * 建隧收尾里协议无关的「回灌余量 + 桥接」已由 `bridgeWithBuffered` 收口
 *
 * 设计要点：
 * - 事件统一为 `PipeEvent`：守卫 `HelperEvent`（type/message/err）结构兼容，
 *   同一事件槽透传，runtime 层按 `type` 统一分派
 * - 依赖方向：`base → guard/upstream/dial/helpers/constants/types/traffic` 单向，四条通道只 `extends` 本类、
 *   不再各写一份字段与构造器（core 零日志禁区：只抛不记，路由经 `emitRoute` 发事件、
 *   落盘归 `src/runtime/event-log.ts` 的 `bindProxyEventLogs`（CLI 与库共用同一份），
 *   收在本类保证四条路径一致）
 * - **构造收三样，全必填**：`constructor(ctx, services, connectors)`。本类与其四个子类都**不**接收
 *   `PipeEventSink`——事件槽是**逐请求**的数据，它的正确归属是 {@link RequestScope}（每次入口方法传一份），
 *   不是构造期固定的实例字段
 *
 * ## 为什么 `services` 是一个包，而不是三个字段
 *
 * `core/AGENTS.md` 当初以「实测只有 2 个真可替换组件（`identity` 与 `traffic`）」为由否决过
 * 服务包，**那条记录的「何时可重新考虑」门槛现已达成**，理由是三条各自独立成立：
 * - **数量与形态**：现在是三个（`identity` / `access` / `traffic`），且**生命周期不同**——
 *   `identity` 与 `access` 是**纯判定**（无状态、随配置现读），`traffic` 是**进程级可变状态**
 *   （内存账本 + 落盘队列）。三种不同的东西第一次凑齐到同一个「core 需要什么」的清单里。
 * - **外部真的会注入替身**：库调用方经 `createProxyRuntime({ services: { identity } })` 换掉
 *   配置驱动的默认实现，是既有事实（判据一直是「外部调用方真的会注入替身」，不是「core 内部用到了」）。
 * - **改一处好过改四处**：拆成 `this.identity` / `this.access` / `this.traffic` 三个字段，每加一个
 *   服务就要改**四个构造点**（`HttpProxy` 三个 + `SocksProxyBase` 一个）与基类构造器；打包之后
 *   加服务只动一处类型。仓库里已经吃过一次同型亏（配额绕过曾要逐处修补才收敛）。
 *
 * **但不要把它拆开**：`services.traffic` 仍可存字段（它是**进程级**服务、四个转发器共享同一实例
 * 正是「配额能按用户累计」的前提），而 `user` 依旧**绝不**存——见下方铁律。
 *
 * ## 计量落点
 *
 * 本类经 `services.traffic` 持有**进程内配额账本**（与另三个转发器同一实例——各建各的账本等于没配配额），
 * 并提供两个入口把计量落到「建链完成之后流动的真实字节」上：
 * - {@link openTunnelMeter}：隧道 / SOCKS / WebSocket 复用，**两端 `destroy()`**（应答早已发出，改不了）
 * - {@link openHttpQuotaGate}：HTTP 普通转发复用，**响应头未发出回 507、已发出 `destroy()`**
 *
 * 两者都走 `@/core/traffic/meter.ts` 的**被动计数**（源流上挂 `data` 监听器，只读 `chunk.length`）：
 * 不插 Transform、不改 pipe 结构、不用 pause/resume 整形，字节流与背压行为逐字节不变。
 * 计量语义、落点理由、HTTP 头字节的对称性缺口全部写在那个文件的头注释里，**这里不重复**。
 */

import type { Duplex } from "node:stream";
import type http from "node:http";
import { ContextualBase } from "@/core/context.js";
import type { CoreContext } from "@/core/context.js";
import type {
  ConnectorSource,
  UpstreamConnector,
} from "@/core/forward/upstream/connector/index.js";
import { Dialer, DialTimeoutError } from "@/core/forward/upstream/dial.js";
import {
  guardPreDial,
  httpReplyFor,
  isSelfLoop,
  type ForwardTargets,
  type PreDialOptions,
  type resolveRoute,
  type RouteDecision,
} from "@/core/helpers/index.js";
import type { RequestScope } from "@/core/request-scope.js";
import {
  openLinkMeter,
  type BufferedCharge,
  type TrafficDirection,
  type TrafficVerdict,
} from "@/core/traffic/index.js";
import type { CoreServices } from "@/core/types/proxy.js";
import {
  REASON_INSUFFICIENT_STORAGE,
  STATUS_BAD_GATEWAY,
  STATUS_FORBIDDEN,
  STATUS_GATEWAY_TIMEOUT,
  STATUS_INSUFFICIENT_STORAGE,
} from "@/utils/constants/index.js";

/**
 * 507 收尾所需的 `ServerResponse` 最小形状（结构化而非 import `node:http`）
 * @description 只声明本类真用到的四个成员：`headersSent` / `writableEnded` 判分支、
 * `writeHead` + `end` 写 507、`destroy()` 硬切。真 `http.ServerResponse` 结构满足。
 */
export interface QuotaResponseTarget {
  readonly headersSent: boolean;
  readonly writableEnded: boolean;
  writeHead(status: number): unknown;
  end(body?: string): unknown;
  destroy(): void;
}

/**
 * 转发器公共基类（事件统一为 `PipeEvent`，逐次经 `RequestScope` 发出）
 *
 * 依赖三件套经 {@link ContextualBase} 的 `config` / `log` / `events` getter 取用，
 * 本类不再自有 `config` 字段。
 *
 * ## 铁律：身份维度绝不存实例字段
 *
 * `user` / `requestId` / `connectionId` **只能**经 {@link RequestScope} 参数逐次传入，
 * **绝不**写成 `protected` / `private` 字段。原因不是洁癖，是一个真实的串号雷：
 * 四个转发器实例由服务在**构造期一次组装**、跨请求复用（`HttpProxy` 三个 +
 * `SocksProxyBase` 一个），而这三条身份是**逐请求**才产生的。存字段 = 第二个请求的
 * 身份会覆盖第一个还没发完事件的请求，日志把 A 的请求记到 B 头上。
 * 历史上 `SocksForwarder` 就是共享单例，全靠「调用点从不把身份写回实例」这条**口头约定**
 * 撑着——现在那条约定由 `RequestScope` 的类型签名接管。
 * 护栏：`tests/integration/forwarder-instance-reuse.test.ts`（实例复用 + 身份不串号）、
 * `tests/unit/forwarder-request-path-allocation.test.ts`（请求路径零 `new`）。
 */
export abstract class ForwarderBase extends ContextualBase {
  /**
   * 共享拨号器（稳态无状态，可跨连接复用）；与本类读同一份上下文
   *
   * @description **自 2c 起只剩一个用途**：{@link bridgeWithBuffered} 的 `bridge`
   * （`WsForwarder.relay` 是第二个使用点）。「怎么到达 dest」**一律**经
   * `forward/upstream/connector/`（upgrade 的 client 模式已于 2c 从 `this.dialer.choose` 改走
   * `connector.transport()`），**别再把它当「拨号入口」用**——本字段只是桥接背后的传输层。
   */
  protected readonly dialer: Dialer;

  /**
   * core 需要的可替换服务包（`@/core/types/proxy` 的 `CoreServices`：身份 / 访问控制 / 流量账本）
   *
   * @description
   * **为什么是一个包、不是三个字段**（三条理由各自独立成立，全文见文件头「为什么 `services`
   * 是一个包」）：① 三个服务**生命周期不同**——`identity`/`access` 是纯判定（无状态、随配置现读），
   * `traffic` 是进程级可变状态；② **外部真的会注入替身**（`createProxyRuntime({ services })`）；
   * ③ 拆开的话每加一个服务就要改**四个构造点**。
   *
   * **`services.traffic` 是逐请求安全的字段**（与下方铁律正交）：它是**进程级**服务，四个转发器
   * 共享同一实例正是「配额能按用户累计」的前提。反过来 `user` **绝不**存这里——它逐请求产生，
   * 由 {@link openTunnelMeter} / {@link openHttpQuotaGate} 从 `scope.user` 现读并只活在本闭包内。
   * 缺省档（显式禁用/显式放行）在唯一组装根 `createProxyRuntime` / `BaseProxy` 归一，
   * **本类零缺省解析**。
   */
  protected readonly services: CoreServices;

  /**
   * 上游连接器源（`@/core/forward/upstream/connector` 的 `ConnectorSource`）：**装配期**已定死的两档
   *
   * @description
   * 「用哪个连接器」是**装配期**的一件事（`UPSTREAM_PROTOCOL` 是 startup 相位），请求路径只问
   * 两档。本字段是**服务对象**、不是逐请求数据，故可以存字段。
   * 与「上游地址」是两件事：地址是请求期的配置事实，见 {@link upstreamEndpoint}。
   */
  protected readonly connectors: ConnectorSource;

  /**
   * @param ctx - 依赖上下文，必须显式注入；其 `config` 同时透传给本类持有的 `Dialer`
   * @param services - 归一后的服务包（`CoreServices`），必须显式注入；**不要拆成三个字段**（理由见字段注释）
   * @param connectors - 装配期解析好的连接器源（`ConnectorSource`），必须显式注入
   * @description 逐请求的事件槽与终态守卫一律经方法参数（{@link RequestScope}）传入，
   * 不进构造期、不进字段。
   */
  constructor(ctx: CoreContext, services: CoreServices, connectors: ConnectorSource) {
    super(ctx);
    this.dialer = new Dialer(ctx);
    this.services = services;
    this.connectors = connectors;
  }

  /**
   * 拨号前置守卫接线（自环 → 目标名单）：四个转发器共用，事件槽由本次请求的 `scope` 提供
   * @description 语义与判定顺序见 `helpers/predial:guardPreDial`：自环看 `dial`（client 模式即上游）、
   * 名单看 `dest`（客户端请求的目标），命中发事件后以状态码调 `deny` 收尾——报文形态由协议自理。
   * **本方法是全仓唯一读 `scope.user` 的地方**（身份只在这条链上流动，见下方铁律）：判该用户的
   * 个人名单，事件的身份维度仍由 `scope.emit` 带上。别的调用点/别的模块都不许
   * 自己去摸 `scope.user`。
   *
   * **四个注入项（`emit` / `config` / `user` / `access`）全部由本类显式给出，四条通道一个都不许传**：
   * - `emit` 来自 `scope`（逐请求的出口，构造期不可能有）；
   * - `config` 是**同一个访问器**（`isSelfLoop` 要读它的 `host`/`port` 判自身监听地址）；
   * - `user` 取自 `scope`（绝不缓存成转发器字段——见铁律）；
   * - `access` 取自 `this.services.access`，**必填无默认**（`PreDialOptions.access` 也没有 `?`）。
   *   **为什么不给它一个缺省档**：名单判定的「缺席」在安全语义上等于**全放行**，那是比「忘了传」
   *   坏得多的静默失败——忘记注入会变成「黑名单整组失效且没有任何症状」。宁可在编译期红。
   * @param opts - `guardPreDial` 选项去掉 `emit`/`config`/`user`/`access`（分别由 `scope` 与本类显式注入）
   * @param scope - 本次请求的作用域（事件出口 + 身份维度）
   * @returns true 表示已拒绝，调用方应立即 return
   */
  protected preDial(
    opts: Omit<PreDialOptions, "emit" | "config" | "user" | "access">,
    scope: RequestScope,
  ): boolean {
    return guardPreDial({
      ...opts,
      // 配置与访问控制由本转发器显式注入到守卫，确保所有调用点使用同一份依赖；
      // 身份逐次取自本请求的 scope（绝不缓存成转发器字段——见本类铁律）
      config: this.config,
      access: this.services.access,
      user: scope.user,
      emit: scope.emit,
    });
  }

  /**
   * 按有效路由选上游连接器：**四条通道唯一的选法**
   *
   * @description
   * `route.route === "direct"` ⟺ 该拨真实目标（`resolveRoute` 已判定的事实，不是独立标志位），
   * 故命中 upstream 路由名单回落直连的请求**必须**走 {@link ConnectorSource.direct}——
   * 走 `upstream()` 会绕过名单判定去拨上游。
   *
   * **「直连」与「走上游」是同一张表的两行**（`ConnectorSource` 的形状就是这么设计的）：
   * 历史上那个三元把「直连」写成了特例，于是它在四条通道里各抄了一份、又各配了一份按协议查表
   * 的调用。现在两档都从同一个供给口取，**本方法体内恰好一个三元**——多一个 `?` 就说明
   * 「第二个选法」又长出来了（护栏：`tests/unit/forward-directory-layout.test.ts`）。
   *
   * **未登记的上游协议由 registry fail-closed 抛错**（server 层 catch 转 `forward.error`），
   * 绝不静默回落直连：「静默直连是流量旁路」（服务在跑、请求成功、但没走你配的链路），
   * 比直接报错糟糕得多。**它抛在请求期**是有意的：`proxyMode: "server"` 下有效路由恒 direct，
   * 本方法一次都不会被调，上游那组字段根本不被读。
   * @param route - `resolveRoute` / `resolveForwardTargets` 给出的有效路由判定
   * @returns 目标连接器（装配期定死的无状态实例，可跨请求复用）
   */
  protected connectorForRoute(route: RouteDecision): UpstreamConnector {
    return route.route === "direct" ? this.connectors.direct() : this.connectors.upstream();
  }

  /**
   * 组装路由判定的策略面：**全仓唯一读 `proxyMode` 的地方**
   *
   * @description
   * 四条通道都要判路由，于是「怎么拼 policy」这件事有四个调用点。**「裸读 `get("proxyMode")`」
   * 因此收在这里一处**：让 channel 各读一次看似只是省一个方法，但它会让「请求路径不许裸读
   * 配置模式」这条规则退化成口头约定（读代码的人看不出哪处读的是判定输入、哪处读的是别的），
   * 而 `tests/unit/dialer-protocol-boundary.test.ts` 那条「`upgrade.ts` 零 `get("proxyMode")`」
   * 的护栏正是靠**调用点无裸读**才写得出来。
   *
   * 两个字段的来源刻意不同：`mode` 是**配置事实**、runtime 相位、**请求期现读**（热改即生效）；
   * `access` 是**服务对象**、每请求同一个引用。两者都不缓存。
   *
   * **返回类型派生自 `resolveRoute` 的 `policy` 形参（`helpers/route.ts:RoutePolicy`），不另抄一份**：
   * 同一个形状在本仓只许有一处声明（抄一份联合迟早与真端口漂移），而跨目录深引
   * `@/core/helpers/route.js` 又是被禁的（barrel 之外不许引实现路径）——派生是这两条纪律
   * 唯一同时成立的解法。它**不会漂移**：那边加了必填字段，本方法的返回类型立刻跟着变。
   * @returns 传给 `resolveRoute` / `resolveForwardTargets` 的策略入参
   */
  protected routePolicy(): Parameters<typeof resolveRoute>[1] {
    return { access: this.services.access, mode: this.config.get("proxyMode") };
  }

  /**
   * 上游地址（`upstreamHost` / `upstreamPort`）：**请求期现读**的纯配置事实
   *
   * @description
   * 与 {@link connectors} **刻意是两种东西，不冲突**：连接器（以及它的协议）由
   * `createConnectorSource(ctx)` 在**装配期**解析完毕（`UPSTREAM_PROTOCOL` 是 startup 相位），
   * 而**上游地址本身是请求期的配置事实**——它是「本次请求要拨的那个上游的地址」这个事实，
   * `PROXY_MODE=server` 的部署压根没有走上游的请求，于是它不属于「装配期钉死」的那一类。
   * 两条链各自有理由，不该互相迁就（把地址也挪进装配期，就得为 server 模式编一个用不到的假上游）。
   *
   * **两个消费方**：`resolveForwardTargets` 靠它出 client 模式的 `dial`（server 模式不取）；
   * `socks.ts` 的 http(s) 上游建隧成功文案用它——那里是**无条件读取**（两次 `Map` 查找），
   * 换来「上游地址是哪两个配置键」这件事在全仓只写一处，与 `resolveForwardTargets` 读的是同一份
   * 事实。直连路径拿到的 `dial` 是 `dest`，与本方法无关。
   * @returns 上游 `{ host, port }`（startup 相位字段，热改不生效——改它要重建 runtime）
   */
  protected upstreamEndpoint(): { host: string; port: number } {
    return {
      host: this.config.get("upstreamHost"),
      port: this.config.get("upstreamPort"),
    };
  }

  /**
   * 「传输对端 ≠ 有效拨号地址」时的补判：`peerTarget` 与 `dial` 不同就再判一次 `preDial`
   *
   * @description
   * **这一步是保住「真实目标自环」判定的唯一路径**：第一次 `preDial` 判的 `dial` 在 client 模式下是
   * **上游**，而 SOCKS 隧道实际落到**真实目标**——于是「客户端请求代理自己的监听地址」这条自环
   * 在第一次里根本没被看到。若只跑一次，客户端就能让本代理经 SOCKS 隧道连回它自己的监听地址（成环）。
   *
   * 两种判据并存（**不是同一个东西抄两遍**）：第一次判「有效拨号地址」（自环/名单的通用判据）、
   * 本方法判「这条管道实际落到谁」（代理型即上游、直连/SOCKS 即 dest）。两者恒有一方是多余的，
   * 故按地址是否相同决定要不要补判，而不是无脑判两遍（无脑判两遍会多发一条名单事件）。
   * 判据的第一句恒取自 {@link UpstreamConnector.peerTarget}——连接器**不收 `dest` 就无从回答**
   * 「本次请求的传输对端是谁」（那与它持有的 `selfLoopTarget()` 是两种形状的刻意并存）。
   *
   * **调用方只有 `http` 与 `upgrade` 两条通道**（tunnel/socks 的传输对端恒等于有效拨号地址，
   * 无从需要补判）。护栏：`tests/integration/websocket-single-path.test.ts`（真自环请求 → 502
   * + 恰好一条 `loop-detected`；**已用变异测试验证**：短路掉补判 → 恰好那一条红）。
   * @param req - 原始请求（`target-denied` 事件的 `req` 维度；SOCKS 那种无 req 场景不调本方法）
   * @param connector - 本请求已选定的连接器
   * @param targets - `resolveForwardTargets` 的成对目标（`dial` / `dest` / `route`）
   * @param deny - 拒绝收尾闭包（与第一次 `preDial` 共用同一个，故两条路径**不会**各发一条 `target-denied`）
   * @param scope - 本次请求的作用域（事件出口 + 身份维度）
   * @returns `peer` = 本次的传输对端（`http.request` 的 host/port 与失败日志路由都取它）；
   *   `denied` = 补判已拒绝，调用方应立即 return
   */
  protected preDialPeerTarget(
    req: http.IncomingMessage,
    connector: UpstreamConnector,
    targets: ForwardTargets,
    deny: (status: number) => void,
    scope: RequestScope,
  ): { peer: { host: string; port: number }; denied: boolean } {
    const peer = connector.peerTarget(targets.dest);
    const differs = peer.host !== targets.dial.host || peer.port !== targets.dial.port;
    const denied = differs && this.preDial({ req, dial: peer, dest: targets.dest, deny }, scope);

    return { peer, denied };
  }

  /**
   * 守卫拒绝的**终态结算**：状态码 → `RequestTerminal` 的两分支
   *
   * @description
   * 协议应答**不在这里**（形态 4 种，各通道自理），本方法只管「事实已发生」的终态那一半，
   * 于是四条通道的映射收成一份。
   *
   * **两分支不是遗漏**：`helpers/predial:guardPreDial` 只有两个 `deny(...)` 调用点，
   * 恒为 `STATUS_BAD_REQUEST` 之外的 {@link STATUS_FORBIDDEN}（名单）与 {@link STATUS_BAD_GATEWAY}
   * （自环）。400 那条拒绝走各协议自己的解析失败路径（`request.rejected(reason, "parse", 400)`），
   * **不经 `deny` 闭包**——故「deny 收到 400」在本仓不可达，历史上的那个分支已随之删除。
   * 判据即 `guardPreDial` 的两个调用点：改动那里时本方法必须同步。
   * @param status - 守卫给出的应答状态码（403 名单 / 502 自环）
   * @param scope - 本次请求的作用域（终态守卫由它携带）
   */
  protected settleDenied(status: number, scope: RequestScope): void {
    if (status === STATUS_FORBIDDEN) {
      scope.terminal.reject("target-denied", "access", status);
      return;
    }
    scope.terminal.fail(new Error("proxy loop detected"), "dial");
  }

  /**
   * 上游地址自环预检：client 模式下拨的是上游，上游指回自身监听地址会成环
   * @description
   * 真实目标的自环/名单已由 {@link preDial} 判过；**名单不判上游**（上游只受自环守卫），
   * 故本方法只查自环，不走 `guardPreDial`。
   * **调用点的上游地址一律取自 `UpstreamConnector.selfLoopTarget()`**（直连连接器返回 undefined
   * → 根本不调本方法），本方法刻意不再提供「自动读 UPSTREAM_HOST/UPSTREAM_PORT」的变体：
   * 那是「自己读配置猜上游地址」，正是连接器层要消灭的第二真相源。
   * @param host - 上游主机
   * @param port - 上游端口
   * @param deny - 拒绝收尾（发完 `loop-detected` 后执行；HTTP 调用方写状态行，SOCKS 回失败应答）
   * @param scope - 本次请求的作用域（事件出口 + 身份维度；**身份由它携带，不再单独传 `user`**）
   * @returns true 表示已拒绝（事件已发、`deny` 已执行），调用方应立即 return
   *
   * **不收 `req`**：本方法现在只有一个调用方 {@link denyUpstreamLoopOf}，而它的两个使用方
   * （tunnel / socks）都在 `connector.open()` **之前**，那里既没有 `req` 也不需要——
   * `loop-detected` 事件上的 `req` 维度由 `preDial` 那条路径（`guardPreDial`）带，
   * 那里才真的手上有 `IncomingMessage`。**别把 `req` 形参加回来**：它服务的那条
   * `viaSocks` 早分支已不存在，加回来只会让人以为还有调用方要传它。
   */
  protected denyUpstreamLoop(
    host: string,
    port: number,
    deny: () => void,
    scope: RequestScope,
  ): boolean {
    if (!isSelfLoop(host, port, this.config)) {
      return false;
    }
    scope.emit({
      type: "loop-detected",
      target: `${host}:${port}`,
    });
    deny();
    return true;
  }

  /**
   * 上游自环预检的**接线半边**：从连接器取上游地址（直连为 undefined 即跳过）→ 判自环 →
   * 发事件 → 结算终态并执行通道自己的协议应答
   *
   * @description
   * 与 {@link denyUpstreamLoop} 的关系：后者是**判定原语**（判一个给定的 host/port），
   * 本方法是**接线**（地址从哪来、`undefined` 怎么办、终态怎么结）——这两半**只有这一份**：
   * 同段三元收口与同一句 `upstream proxy loop detected` 终态必须逐字同形，抄两份迟早漂移。
   *
   * **终态文案与 `settleDenied` 刻意不同**（`proxy loop detected` vs `upstream proxy loop
   * detected`）：那是两个不同的事实（真实目标自环 / 上游指回自身监听地址），运维排查时
   * 靠这个尾巴分辨是哪一种成环，故不合并。
   *
   * 调用方是 tunnel（回 502 状态行）与 socks（回二进制失败应答）——**应答形态两种，
   * 由 `respond` 传入**。
   * @param connector - 本请求已选定的连接器（其 `selfLoopTarget()` 是上游地址的唯一来源）
   * @param respond - 协议应答闭包（上游拒绝时的形态由通道决定）
   * @param scope - 本次请求的作用域
   * @returns true 表示已拒绝，调用方应立即 return
   */
  protected denyUpstreamLoopOf(
    connector: UpstreamConnector,
    respond: () => void,
    scope: RequestScope,
  ): boolean {
    const loop = connector.selfLoopTarget();

    if (!loop) {
      return false;
    }

    return this.denyUpstreamLoop(loop.host, loop.port, () => {
      respond();
      scope.terminal.fail(new Error("upstream proxy loop detected"), "dial");
    }, scope);
  }

  /**
   * client 模式路由事件：preDial 通过后的路由分支处调用，名单参与判定时每请求恰发一条（拒绝路径到不了这里）
   * @description core 零日志：事实经 `route` 事件上抛，runtime 层 `bindProxyEventLogs`
   * （`src/runtime/event-log.ts`，CLI 与库共用同一份）落 `[route]` info 行（1:1）；
   * server 模式短路不发——该判定恒为 `{mode:"server", route:"direct"}` 且未查 upstream 组（零信息量），
   * 而 client 命中回落必带 reason（`acl:checkUpstreamRoute` 两个 direct 分支都返回 reason），据此区分
   * @param dest - 客户端请求的目标（名单判定对象，事件 target 按它拼）
   * @param decision - `resolveRoute` 的判定结果
   * @param scope - 本次请求的作用域（事件出口 + 身份维度）
   */
  protected emitRoute(
    dest: { host: string; port: number },
    decision: RouteDecision,
    scope: RequestScope,
  ): void {
    if (decision.mode === "server" && !decision.reason) {
      return;
    }

    scope.emit({
      type: "route",
      target: `${dest.host}:${dest.port}`,
      mode: decision.mode,
      route: decision.route,
      ...(decision.reason ? { reason: decision.reason } : {}),
    });
  }

  /**
   * 裸 socket 拒绝收尾：向客户端写预拼状态行报文后关闭（`httpReplyFor` 派生，已销毁则跳过）
   * @description 解析失败（400）、名单拒绝（403）、自环/网关失败（502）共用；
   * 仅适用于**尚未回过状态行**的场景（无协议污染），操作 `ServerResponse` 的 HTTP 转发器不走此口
   * @param socket - 客户端双工流
   * @param status - 应答状态码
   */
  protected refuse(socket: Duplex, status: number): void {
    if (!socket.destroyed) {
      socket.end(httpReplyFor(status));
    }
  }

  /**
   * 按拨号成因拒绝收尾：守卫不写报文（`keepClientOnFailure`）时成败应答归调用方——
   * 拨号/等状态行**超时回 504**，连接错误/响应超限回 502（成因已由 `onEvent` 上抛到日志）
   * @param socket - 客户端双工流
   * @param e - catch 到的异常（超时为 {@link DialTimeoutError}）
   */
  protected refuseByCause(socket: Duplex, e: unknown): void {
    this.refuse(
      socket,
      e instanceof DialTimeoutError ? STATUS_GATEWAY_TIMEOUT : STATUS_BAD_GATEWAY,
    );
  }

  /**
   * 拨号失败的收尾骨架：**协议应答（各通道形态不同）+ `fail(stage:"dial")` 终态**
   *
   * @description
   * 四条通道的拨号失败都落在这两件事上，但**只有这两件是共同的**：
   * - **应答形态 4 种**（`ServerResponse` 502 / 裸 socket 状态行 504|502 / SOCKS 二进制失败应答
   *   延时销毁 / http 已发头时 `destroy()`）——刻意不合并，传 `respond` 闭包进来；
   * - **`upstream-error` 事件只在 http 与 upgrade 两处发**，tunnel 靠守卫的
   *   `keepClientOnFailure` 已经发过、socks 那条的载荷压根不带 `err`；文案四处各不相同。
   *   故事件**留在各通道**——把它参数化只会造出一个「要不要发、要不要带 err、文案怎么拼」
   *   三件全靠调用方回答的万能函数，那正是 `core/AGENTS.md` 记为「假抽象」的形态。
   *
   * 「应答先于终态」是契约：`RequestTerminal` 抢占发布后观察面再异常也改不了协议收尾。
   * @param respond - 协议应答闭包（形态由通道决定；它内部该销毁的上游自己已销毁）
   * @param err - catch 到的异常（超时为 {@link DialTimeoutError}，成因已由各通道上抛到日志）
   * @param scope - 本次请求的作用域（终态守卫由它携带）
   */
  protected settleDialFailure(respond: () => void, err: unknown, scope: RequestScope): void {
    respond();
    scope.terminal.fail(err, "dial");
  }

  /**
   * 建隧收尾的协议无关半边：回灌两侧余量后双向桥接（**不写任何协议应答**）
   * @description tunnel 的 `establishTunnel` 与 socks 的 `establish` 共用——两者除协议应答
   * （HTTP 200 / SOCKS 二进制 replySuccess，留在各自调用方）外完全对称；
   * 两个方向写的是不同 socket，跨流先后无可观测差异。
   *
   * **计量**：`toUpstream` / `toClient` 是建链那一刻已经在手上的**真实载荷**
   * （CONNECT/SOCKS 之后客户端的首包、上游应答头之后的上游先发字节），不经 `data` 事件，
   * 故由 `meter.charge(...)` 显式补记；判定不通过就**不写**（写进已销毁的 socket 会抛
   * `ERR_STREAM_DESTROYED`）——判定与收尾都由 `charge` 内部完成（事件 + 双端 destroy），
   * 本方法只负责「不写」。**`meter` 必填、不给「本条链路不计量」的形态**：无身份
   * （关鉴权）由 `openTunnelMeter` 内部返回 `inert` 端口（`charge` 恒 `ALLOW`）表达，
   * 不是靠调用方传 `undefined` —— 那条分支全仓零调用方，走到过的是纸面。
   * @param client - 客户端双工流
   * @param upstream - 已建链的上游
   * @param meter - 计量端口（由 {@link openTunnelMeter} 产出，必填）
   * @param toUpstream - 写给上游的余量（如客户端 CONNECT/SOCKS 请求后的首包），空则不写
   * @param toClient - 写给客户端的余量（如上游响应头之后的先发字节），空则不写
   */
  protected bridgeWithBuffered(
    client: Duplex,
    upstream: Duplex,
    meter: BufferedCharge,
    toUpstream?: Buffer,
    toClient?: Buffer,
  ): void {
    if (toUpstream?.length && !meter.charge("up", toUpstream.length).allow) {
      return;
    }
    if (toClient?.length && !meter.charge("down", toClient.length).allow) {
      return;
    }
    if (toUpstream?.length) {
      upstream.write(toUpstream);
    }
    if (toClient?.length) {
      client.write(toClient);
    }
    this.dialer.bridge(client, upstream);
  }

  // ── 流量计量 ──────────────────────────────────────────────────────────────

  /**
   * 隧道 / SOCKS / WebSocket 的计量：两端各挂一个被动监听器，耗尽即**硬切**（双端 destroy）
   * @description
   * 硬切是**裁决**不是省事：软化（「用尽后只拒新请求、已有连接放着」）等于让一条长连接隧道
   * 永远不触发耗尽判定，配额就成了摆设。而这三条通道的**应答早已发出**（200 / SOCKS reply /
   * 101），改不了，只能断链。
   *
   * **「恰好一次」由本方法的闭锁保证**：一条链路上第一次耗尽就断了，后续 chunk 不会再有
   * 事件（socket 已销毁），但闭锁让这件事**不依赖时序**——即便对端在 destroy 前又挤进来一个
   * chunk，也只发一条事件、只收一次尾。
   *
   * 无身份（`scope.user === undefined`）时**一个监听器都不挂**、返回 `inert` 端口：关鉴权的
   * 部署不为计量付任何代价（产品决策：无身份 → 无归属 → 配额整体不生效）。
   * @param client - 客户端双工流（`up` 方向的源流）
   * @param upstream - 上游双工流（`down` 方向的源流）
   * @param scope - 本次请求/会话的作用域：只在这里读一次 `user`，**不落任何实例字段**
   * @returns 建隧后首批载荷的补记端口
   */
  protected openTunnelMeter(
    client: Duplex,
    upstream: Duplex,
    scope: RequestScope,
  ): BufferedCharge {
    let fired = false;
    const onExceeded = (dir: TrafficDirection, verdict: TrafficVerdict): void => {
      if (fired) {
        return;
      }
      fired = true;
      this.publishQuotaExceeded(scope, dir, verdict);
      if (!client.destroyed) {
        client.destroy();
      }
      if (!upstream.destroyed) {
        upstream.destroy();
      }
    };

    return openLinkMeter(this.services.traffic, scope.user, client, upstream, onExceeded);
  }

  /**
   * HTTP 普通转发的耗尽闸门：一次请求**恰好一条**事件 + 按「响应头是否已发出」二选一收尾
   * @description
   * 计量本身由调用方用 `meterStream` 分两处挂（`up` 挂 `req`、`down` 挂 `upRes`——两者存在
   * 于不同时刻），本方法只提供**共享闭锁 + 收尾**，故签名是一个返回闭包的工厂：
   * 两处挂点共用同一个闭包，跨方向的竞态（`up` 耗尽恰好与 `down` 首个 chunk 同一轮事件循环）
   * 也不会发第二条事件。
   *
   * **收尾分支**：响应头**未**发出 → 回 **507 Insufficient Storage**（配额耗尽不是权限问题：
   * 403 会诱导客户端换凭证/换身份重试，而重试对「用完了」毫无意义）；**已**发出 →
   * `destroy()`（往已开始的流里追加 507 正文就是协议污染）。两条分支都中止出站请求并销毁
   * 我们自己建的那条传输层。
   *
   * **`down` 方向实际上总是走 destroy 分支**：响应体字节只在 `res.writeHead(...)` 之后才流动，
   * 那一刻 `res.headersSent` 必为 true。507 分支由 `up` 方向承载——请求体撞顶时响应还没开始，
   * 这才是「响应头未发出 → 507」唯一可达的路径。两条分支都要有：只留 destroy 会让上传超限
   * 的请求变成裸 ECONNRESET（客户端看不懂），只留 507 会让下载超限的响应体被截断后仍声称
   * 自己完整。
   *
   * **状态行不保证到达客户端**（写进注释免得被后人当 bug 修）：`res.destroy()` 直接销毁 socket，
   * 尚在 socket 写缓冲里的应答头会一起丢掉，客户端可能看到 200、也可能只看到 ECONNRESET。
   * 两者都是「硬切」的正确表现，客户端不能依赖状态行。**不要**为了「让状态行一定送到」而改成
   * `setImmediate` 延迟 destroy——那会在延迟窗口里漏掉本该被拒的字节，硬切就不硬了。
   *
   * @param scope - 本次请求的作用域：只在这里读一次 `user`
   * @param res - 客户端响应（决定 507 还是 destroy）
   * @param upstream - 已建链的上游传输层，耗尽时一并销毁
   * @param proxy - 出站请求，耗尽时一并中止（否则它会一直挂到 `upstreamTimeout`）
   * @returns 传给两处 `meterStream` 的耗尽回调
   */
  protected openHttpQuotaGate(
    scope: RequestScope,
    res: QuotaResponseTarget,
    upstream: { destroyed: boolean; destroy(): void },
    proxy: { destroy(): void },
  ): (dir: TrafficDirection, verdict: TrafficVerdict) => void {
    let fired = false;

    return (dir: TrafficDirection, verdict: TrafficVerdict): void => {
      if (fired) {
        return;
      }
      fired = true;
      this.publishQuotaExceeded(scope, dir, verdict);

      if (res.headersSent || res.writableEnded) {
        res.destroy();
      } else {
        res.writeHead(STATUS_INSUFFICIENT_STORAGE);
        res.end(REASON_INSUFFICIENT_STORAGE);
      }
      if (!upstream.destroyed) {
        upstream.destroy();
      }
      proxy.destroy();
    };
  }

  /**
   * 耗尽事实的唯一发布点：一条 `traffic.quota-exceeded` 公共事件
   * @description
   * core 零日志：这里**只**发布事实，落盘 `[quota-exceeded]` warn 收在
   * `src/runtime/event-log.ts:bindProxyEventLogs`（与 `[target-denied]` 同一面）。
   *
   * `EventContext` 恒带 `user`（任务硬要求，也是「配额是谁的」这个问题唯一可答的来源），
   * 并把该请求已知的关联维度（`client` / `target` / `requestId` / `connectionId`）一并带出——
   * 读 `RequestTerminal` 的快照而不是重新推导：那里是协议入口已经算好的同一份事实，
   * 重算会出现「同一请求两个 id 口径」。
   * @param scope - 本次请求/会话的作用域
   * @param dir - 本次流动的方向（`up` / `down`）
   * @param verdict - 判定结果（`scope` / `usage` / `limit` 必带，缺一不可）
   */
  protected publishQuotaExceeded(
    scope: RequestScope,
    dir: TrafficDirection,
    verdict: TrafficVerdict,
  ): void {
    const user = scope.user;

    if (user === undefined || verdict.scope === undefined) {
      // 无身份即不计量（不该到这里）；判定缺 scope 说明端口实现坏了。
      // **宁可不发也不臆造**：编一个 scope 会让运维去改错的那条上限。
      return;
    }

    this.events.publish(
      "traffic.quota-exceeded",
      {
        user,
        dir,
        scope: verdict.scope,
        usage: verdict.usage ?? 0,
        limit: verdict.limit ?? 0,
      },
      { ...scope.terminal.snapshotContext(), user },
    );
  }
}
