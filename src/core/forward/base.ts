/**
 * @fileoverview 转发器公共基类
 * @module core/forward/base
 * @description
 * 四个转发器（http/tunnel/websocket/socks）共享的拨号器与重复胶水收敛到一处：
 * - `dialer`：共享 `Dialer` 实例（无状态）。**自 2c 起它只服务一个成员 `bridge`**
 *   （本类的 `bridgeWithBuffered` 与 `WsForwarder.relay` 两个调用点）。「怎么到达 dest」
 *   一律经 `forward/connector/`——上游协议实现全住在 `forward/connector/<协议>.ts`，
 *   `Dialer` 本身是纯传输层（建链 + 桥接）
 * - 发事件：**一律经 `scope.emit(e)`**（`RequestScope` 的逐请求闭包，身份维度只在
 *   `createRequestScope` 里注一次）。本类**不再持有 `emit` 字段，也不再有 `emitWithUser`**
 * - `preDial`：拨号前置守卫（自环 + 目标名单）接线——事件槽由调用方给的 `scope` 提供
 * - `emitRoute`：client 模式路由事件（`route` → server 层落 `[route]` info 行）——preDial 通过后的路由分支处每请求恰发一条，server 模式短路不发
 * - `denyUpstreamLoop`：上游地址自环预检（client 模式下拨的是上游，三处调用点的上游地址
 *   一律取自 `UpstreamConnector.selfLoopTarget()`；直连连接器返回 undefined 即不判）
 * - `refuse` / `refuseByCause`：裸 socket 状态行拒绝收尾（tunnel/websocket 共用），
 *   后者按拨号成因分流 `DialTimeoutError` → 504、其余 → 502
 * - `bridgeWithBuffered`：建隧收尾的**协议无关半边**——回灌两侧余量（toUpstream/toClient）后 `dialer.bridge`，
 *   tunnel 与 socks 共用（各自把 HTTP 200 / SOCKS 二进制 replySuccess 留在调用方）
 *
 * 设计要点：
 * - 事件统一为 `PipeEvent`：守卫 `HelperEvent`（type/message/err）结构兼容，
 *   同一事件槽透传，server 层按 `type` 统一分派
 * - 依赖方向：`base → guard/dial/helpers/constants/types/traffic` 单向，四个转发器只 `extends` 本类、不再各写一份字段与构造器
 *   （core 零日志禁区：只抛不记，路由经 `emitRoute` 发事件、落盘归 `src/server` 的 `bindProxyEventLogs`，收在本类保证四条路径一致）
 * - **构造只收 `ctx` 与 `traffic`**：本类与其四个子类都不再接收 `PipeEventSink`——事件槽是**逐请求**的数据，
 *     它的正确归属是 {@link RequestScope}（每次 `handle` 传一份），不是构造期固定的实例字段
 * - **刻意不收的**：各协议的应答形态（HTTP `ServerResponse` 早失败、SOCKS 二进制失败/成功应答、
 *   tunnel 回 200、websocket 等 101）——协议语义本质不同，强行模板化只会得到参数爆炸的假抽象；
 *   建隧收尾里协议无关的「回灌余量 + 桥接」已由 `bridgeWithBuffered` 收口
 *
 * ## 计量落点（Phase 5a）
 *
 * 本类持有**进程内配额账本**（`traffic`，与另三个转发器同一实例——各建各的账本等于没配配额），
 * 并提供两个入口把计量落到「建链完成之后流动的真实字节」上：
 * - {@link openTunnelMeter}：隧道 / SOCKS / WebSocket 复用，**两端 `destroy()`**（应答早已发出，改不了）
 * - {@link openHttpMeters}：HTTP 普通转发复用，**响应头未发出回 507、已发出 `destroy()`**
 *
 * 两者都走 `@/core/traffic/meter.ts` 的**被动计数**（源流上挂 `data` 监听器，只读 `chunk.length`）：
 * 不插 Transform、不改 pipe 结构、不用 pause/resume 整形，字节流与背压行为逐字节不变。
 * 计量语义、落点理由、HTTP 头字节的对称性缺口全部写在那个文件的头注释里，**这里不重复**。
 */

import type { Duplex } from "node:stream";
import { ContextualBase } from "@/core/context.js";
import type { CoreContext } from "@/core/context.js";
import {
  guardPreDial,
  httpReplyFor,
  isSelfLoop,
  type PreDialOptions,
  type RouteDecision,
} from "@/core/helpers/index.js";
import type { RequestScope } from "@/core/request-scope.js";
import {
  openLinkMeter,
  type BufferedCharge,
  type TrafficAccount,
  type TrafficDirection,
  type TrafficVerdict,
} from "@/core/traffic/index.js";
import {
  REASON_INSUFFICIENT_STORAGE,
  STATUS_BAD_GATEWAY,
  STATUS_GATEWAY_TIMEOUT,
  STATUS_INSUFFICIENT_STORAGE,
} from "@/utils/constants/index.js";
import { Dialer, DialTimeoutError } from "./dial.js";

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
   * `forward/connector/`（websocket 的 client 模式已于 2c 从 `this.dialer.choose` 改走
   * `connector.transport()`），**别再把它当「拨号入口」用**——本字段只是桥接背后的传输层。
   */
  protected readonly dialer: Dialer;

  /**
   * 进程内每用户流量配额账本（`@/core/traffic` 端口）
   * @description
   * **这不是逐请求数据**，故可以存字段：它是进程级服务，四个转发器实例必须**共享同一个**
   * 账本（各建各的等于没配配额）。反过来，`user` **绝不**存这里——它逐请求产生，
   * 由 {@link openTunnelMeter} / {@link openHttpMeters} 从 `scope.user` 现读并只活在本闭包内。
   * 显式注入优先；未注入时 `BaseProxy` 归一成**显式禁用档**（不计量、不判定）。
   */
  protected readonly traffic: TrafficAccount;

  /**
   * @param ctx - 依赖上下文，必须显式注入；其 `config` 同时透传给本类持有的 `Dialer`
   * @param traffic - 配额账本端口，必须显式注入（禁用档由 `BaseProxy` 归一好再传进来）
   * @description **只收 `ctx` 与 `traffic`**。逐请求的事件槽与终态守卫一律经方法参数
   * （{@link RequestScope}）传入，不进构造期、不进字段。
   */
  constructor(ctx: CoreContext, traffic: TrafficAccount) {
    super(ctx);
    this.dialer = new Dialer(ctx);
    this.traffic = traffic;
  }

  /**
   * 拨号前置守卫接线（自环 → 目标名单）：四个转发器共用，事件槽由本次请求的 `scope` 提供
   * @description 语义与判定顺序见 `helpers/predial:guardPreDial`：自环看 `dial`（client 模式即上游）、
   * 名单看 `dest`（客户端请求的目标），命中发事件后以状态码调 `deny` 收尾——报文形态由协议自理。
   * **身份（`scope.user`）只在本方法读一次并逐次传入**：`predial` 拿到用户名去判该用户的
   * 个人名单（Phase 4b），事件的身份维度仍由 `scope.emit` 带上。别的调用点/别的模块都不许
   * 自己去摸 `scope.user` —— 那会让「身份只在 preDial/RequestScope 这条链上流动」这条
   * 铁律退化成口头约定。
   * @param opts - `guardPreDial` 选项去掉 `emit`/`config`/`user`（分别由 `scope` 与本类显式注入）
   * @param scope - 本次请求的作用域（事件出口 + 身份维度）
   * @returns true 表示已拒绝，调用方应立即 return
   */
  protected preDial(
    opts: Omit<PreDialOptions, "emit" | "config" | "user">,
    scope: RequestScope,
  ): boolean {
    return guardPreDial({
      ...opts,
      // 配置由本转发器显式注入到守卫，确保所有调用点使用同一访问器；
      // 身份逐次取自本请求的 scope（绝不缓存成转发器字段——见本类铁律）
      config: this.config,
      user: scope.user,
      emit: scope.emit,
    });
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
   * @param extra - `req` 随事件带原请求（websocket）；这是请求对象本身而非身份维度，故仍是显式参数
   * @returns true 表示已拒绝（事件已发、`deny` 已执行），调用方应立即 return
   */
  protected denyUpstreamLoop(
    host: string,
    port: number,
    deny: () => void,
    scope: RequestScope,
    extra?: { req?: unknown },
  ): boolean {
    if (!isSelfLoop(host, port, this.config)) {
      return false;
    }

    scope.emit({
      type: "loop-detected",
      target: `${host}:${port}`,
      ...(extra?.req ? { req: extra.req } : {}),
    });

    deny();
    return true;
  }

  /**
   * client 模式路由事件：preDial 通过后的路由分支处调用，名单参与判定时每请求恰发一条（拒绝路径到不了这里）
   * @description core 零日志：事实经 `route` 事件上抛，server 层 `bindProxyEventLogs` 落 `[route]` info 行（1:1）；
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
   * 建隧收尾的协议无关半边：回灌两侧余量后双向桥接（**不写任何协议应答**）
   * @description tunnel 的 `establishTunnel` 与 socks 的 `establish` 共用——两者除协议应答
   * （HTTP 200 / SOCKS 二进制 replySuccess，留在各自调用方）外完全对称；
   * 两个方向写的是不同 socket，跨流先后无可观测差异。
   *
   * **计量**（Phase 5a）：`toUpstream` / `toClient` 是建链那一刻已经在手上的**真实载荷**
   * （CONNECT/SOCKS 之后客户端的首包、上游应答头之后的上游先发字节），不经 `data` 事件，
   * 故由 `meter.charge(...)` 显式补记；判定不通过就**不写**（写进已销毁的 socket 会抛
   * `ERR_STREAM_DESTROYED`）。`meter` 为 null 表示本条链路不计量（无身份）。
   * @param client - 客户端双工流
   * @param upstream - 已建链的上游
   * @param meter - 计量端口（由 {@link openTunnelMeter} 产出）
   * @param toUpstream - 写给上游的余量（如客户端 CONNECT/SOCKS 请求后的首包），空则不写
   * @param toClient - 写给客户端的余量（如上游响应头之后的先发字节），空则不写
   */
  protected bridgeWithBuffered(
    client: Duplex,
    upstream: Duplex,
    meter: BufferedCharge | undefined,
    toUpstream?: Buffer,
    toClient?: Buffer,
  ): void {
    if (toUpstream?.length && !meter?.charge("up", toUpstream.length).allow) {
      return;
    }

    if (toClient?.length && !meter?.charge("down", toClient.length).allow) {
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

  // ── 流量计量（Phase 5a）──────────────────────────────────────────────────

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

    return openLinkMeter(this.traffic, scope.user, client, upstream, onExceeded);
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
    return (dir, verdict): void => {
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
   * `src/server/index.ts:bindProxyEventLogs`（与 `[target-denied]` 同一面）。
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
