/**
 * @fileoverview 传输策略插件默认装配 - `ForwardTransport` 注册表
 * @module plugins/forwarders
 * @description
 * `ForwarderProvider`（`plugins/contracts.ts`）的默认实现集合，也是「传输方式」维度
 * 的**唯一实现处**。注册表键 = `ForwardTransport`（`direct-stream` / `http-upstream` /
 * `socks-upstream`），与入站协议维度 `ForwardInbound`（`http` / `connect` / `upgrade` /
 * `socks`）**正交**——同一个 `DirectStreamForwarderPlugin` 同时服务四条入站通道，
 * 「换传输策略」只是换注册表里的一项，不改任何调用方。
 *
 * ```
 * 入站协议插件 (core/forward/inbound/*)      RoutingProvider         本文件的三个策略
 * 解析协议 / 拒绝收尾 / 答协议   ──▶   产出自包含 ForwardPlan  ──▶  按 plan.transport 选一项
 *      │                                  （含 upstreamTls）              │
 *      └── ctx.responder（怎么应答）─┴──── ctx.client/head/auth ───────────┘
 * ```
 *
 * ## 五块逻辑为什么在这里
 * 此前它们散在 `core/forward/{http,tunnel,websocket,socks}.ts` 里，与「入站协议形态」纠缠：
 * 1. **`http-request` 语义转发**（`http.request` / `https.request`）：载荷形态由 `plan.payload`
 *    决定，是**传输方式**的事。同一份实现现在服务 direct / http-upstream / socks-upstream 三条策略
 *    （前两者只差「拨谁、要不要注凭证」，后者多一段「先建 SOCKS 隧道再复用隧道 socket」）。
 * 2. **Upgrade 101 握手等待**（`awaitStatusLine` 等 101）：报文形态由 `plan.transport` 决定
 *    （absolute-form + `Proxy-Authorization` 只在 http-upstream），同样是传输维度。
 * 3. **上游非预期应答的透传**：经 `ctx.responder.relayUpstreamResponse` —— 裸 socket 通道原样
 *    写回客户端（CONNECT 客户端因此重新拿得到 `Proxy-Authenticate`），HTTP 通道写
 *    `ServerResponse`，SOCKS 通道未实现该钩子故回退 `upstream-refused` + FAIL。
 *    **传输策略因此仍不认 `ServerResponse`、不写 SOCKS 字节序、不拼任何入站报文**。
 * 4. **出站 TLS 校验策略**：读 `plan.upstreamTls`（**不是配置**）。它曾以
 *    `upstreamInsecure`/`upstreamCa` 不在计划契约内为由，让入站基类每次转发现读
 *    `deps.config.scope`——那是「转发器零配置读取」的唯一例外；现已冻结进计划，
 *    本层连 `ConfigProvider` 都拿不到。热加载能力不丢（路由插件每次 `plan()` 现读 scope）。
 * 5. **出站凭证剥离**：`ctx.auth`（由入站层从 `deps.auth` 注入，`ForwarderContext` 的契约字段）
 *    交给 `sanitizeHeaders` / `isStrippableOutboundHeader`。此前 `ForwarderContext` 不含它，
 *    本层对 client 模式只能 **fail-closed 直接断链**——加上字段后才能安全剥离而不是断链。
 *
 * 留在 `core/forward/inbound/` 的是**入站维度**：SOCKS 握手解析、SOCKS4a 哨兵、
 * 畸形握手的 `bytesReceived` 事实、各协议的 `ProtocolResponder` 构造、路由/守卫/路由事件。
 *
 * ## 五条不变量（红线，逐条照搬 `src/core/AGENTS.md`）
 * 1. **零配置读取**：不 import `@/config/*`；上游地址/端口/协议/凭证/超时预算/**出站 TLS 策略**
 *    全从 `plan` 取。本层**不需要**最严缺省 TLS 策略了（`upstreamTls` 必填）。
 * 2. **零日志**：本层不碰 logger/console，一切事实经 `ctx.emit` 上抛，落盘在 server 层。
 * 3. **不认入站协议**：不 import `node:http` 的 `ServerResponse`、不写任何 SOCKS 字节序、
 *    不拼任何入站应答报文；成败应答全走 `ctx.responder`。唯一读 `plan.inbound` 的地方是
 *    载荷形态分流（`upgrade` 要写握手报文并等 101），那是**传输执行**的必要判据。
 * 4. **SOCKS 成功应答的 BND**：本层只做**事实采集**——`getSocketLocalBinding` 鸭子嗅探
 *    出站 socket 的本地绑定，**成对给出**才经 `responder.establish({ local })` 交出去，
 *    否则传 `undefined`。ATYP 恒 `0x01`、v4-mapped 归一、真 IPv6 / 取不到即回退
 *    `0.0.0.0:0` + `debug` 事件、**绝不抛错绝不让会话失败**、失败应答 BND 恒全零——
 *    这些字节级规则由应答器（`inbound/socks.ts:boundReplyAddress` +
 *    `utils/protocol/socks.ts:buildSocks5ReplySuccess`）按 RFC 实现，本层**不重复实现**，
 *    更不内联偏移或魔数。
 * 5. **拨号失败成因分流**：`DialTimeoutError` → 504，其余 → 502（`refuseByCause`）。
 *    catch 里一刀切 502 会吃掉超时成因，SOCKS 侧不区分（应答器忽略状态码）。
 *
 * 另外三条被照搬的执行语义：
 * - **余量回灌后再桥接**：`ctx.head`（客户端握手之后已读到的首包）写给上游，上游应答头
 *   之后的先发字节（`rest`）写给客户端，两侧都在 `bridge` 之前落盘。
 * - **上游自环 fail-closed**：经上游时拨的就是上游，上游指回 `plan.listen` 会成环；
 *   本层在拨号前再判一次（纵深防御，不依赖路由插件单点实现质量），命中发 `loop-detected`
 *   事实并回 502。
 * - **`http-request` 载荷的上游响应绝不降级 502**：正常应答（404/407/500 对客户端都是有效应答）
 *   一律经 `responder.relayUpstreamResponse({ incoming })` 交出；只有上游应答本身不合法/超限
 *   （`awaitStatusLine` 的 `overflow`）才按网关失败收尾。
 *
 * ## 事实消息前缀
 * 守卫/事件的 `[...]` 前缀是**传输标签**（`direct-stream` / `http-upstream` / `socks-upstream`）：
 * 同一份传输实现跨四条入站复用，入站标签已不再是该事实的主体（入站特有的事实——SOCKS
 * 握手分类行、建隧成功行、`bad-request` 的字节数——由入站层自己发，仍带 `[socks]` 标签）。
 * **事件的 `type` 与结构化字段一字未改**，分级仍由 `src/server/index.ts:bindProxyEventLogs`
 * 按 type 单点收口。
 *
 * @example
 * ```ts
 * const forwarders = createForwarderRegistry();
 * // 入站适配器拿到计划后按传输维度取实现（入站维度对这里是透明的）
 * await forwarders.require(plan.transport).forward(ctx);
 * ```
 */

import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { awaitStatusLine, socksUpstreamGuard, type HelperEventSink } from "@/core/guard.js";
import { Dialer, DialTimeoutError } from "@/core/forward/dial.js";
import {
  absoluteFormAuthority,
  formatAuthority,
  isSelfLoop,
  isStrippableOutboundHeader,
  sanitizeHeaders,
  socksVersionOf,
  upstreamAuthValue,
} from "@/core/proxy-helpers.js";
import { getSocketLocalBinding } from "@/utils/net/socket.js";
import { upstreamTlsOptions } from "@/utils/net/upstream-tls.js";
import {
  CRLF,
  DOUBLE_CRLF,
  HEADER_NAME_CONNECTION,
  HEADER_NAME_HOST_LOWER,
  HEADER_NAME_HOST_TITLE,
  HEADER_NAME_PROXY_AUTHORIZATION,
  HEADER_VALUE_CLOSE,
  STATUS_BAD_GATEWAY,
  STATUS_GATEWAY_TIMEOUT,
  STATUS_OK,
  STATUS_SWITCHING_PROTOCOLS,
} from "@/utils/protocol/http.js";
import type {
  ForwarderContext,
  ForwardFact,
  ForwardTransport,
  ProtocolResponder,
  UpstreamEndpoint,
} from "@/core/types/plan.js";
import {
  createPluginRegistry,
  type ForwarderProvider,
  type PluginRegistry,
} from "./contracts.js";

/** 异常 → 人类可读文本（`catch` 收到的是 `unknown`；非 Error 也得有文案） */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 出站 socket 的本地绑定（供 SOCKS 成功应答填 BND.ADDR/BND.PORT）
 * @description 本地绑定这个事实**只存在于 socket 上**，鸭子类型嗅探（`net.Socket` 与
 * `tls.TLSSocket` 都有 `localAddress`/`localPort`）。**成对给出才返回**，否则返回
 * `undefined` 让应答器走 `0.0.0.0:0` 回退——本层**不抛错、不猜地址族**
 * （ATYP 恒 `0x01` 与 v4-mapped 归一由应答器按 RFC 处理，见文件头第 4 条不变量）。
 * @param sock - 已建链的上游
 * @returns `{ host, port }` 或 `undefined`（取不到绑定）
 */
function localBinding(sock: Duplex): { host: string; port: number } | undefined {
  const { address, port } = getSocketLocalBinding(sock);
  return address === undefined || port === undefined ? undefined : { host: address, port };
}

/**
 * 上游端点 → Basic 凭证对（`upstreamAuthValue` / `upstreamAuthHeaderLine` 的入参形态）
 * @description 端点里两个字段都是可选的（未配置即不带上游凭证），此处统一补成空串，
 * 免得各调用点各写一遍 `?? ""`
 * @param upstream - 计划里冻结的上游端点
 */
function credentialsOf(upstream: UpstreamEndpoint | undefined): {
  username: string;
  password: string;
} {
  return { username: upstream?.username ?? "", password: upstream?.password ?? "" };
}

/**
 * 构建 Upgrade 请求（剔除 proxy-* 头，重写 Host）
 * @param req - 原始 Upgrade 请求
 * @param host - 握手 Host 回写主机（客户端请求的目标）
 * @param port - 握手 Host 回写端口
 * @param path - origin-form 请求目标（直连与经 SOCKS 隧道时使用）
 * @param opts.toUpstreamProxy - 是否发给 http/https 上游代理（**唯一判据 = `plan.transport === "http-upstream"`**）：
 *   true 时 request-target 保留客户端的 absolute-form，并注入 Proxy-Authorization
 *   （上游凭证，仅端点里显式配了 username 时携带）。经 SOCKS 隧道或路由名单命中直连
 *   已直达真实目标，必须用 origin-form 且绝不能带上游凭证
 * @param opts.auth - 本实例鉴权插件（出站 `Authorization` 的凭证形态判据，与 `sanitizeHeaders` 同源）
 * @param opts.credentials - 上游 Basic 凭证（`username` 空串表示未配置 ⇒ 不带头）
 * @description Host 回写走 `formatAuthority`：解析侧已剥去 IPv6 方括号，
 *   拼装侧必须补回（否则 `::1:80` 是畸形 authority，上游/源站无法解析）
 */
function buildUpgradeReq(
  req: http.IncomingMessage,
  host: string,
  port: number,
  path: string,
  opts: {
    toUpstreamProxy: boolean;
    auth: ForwarderContext["auth"];
    credentials: { username: string; password: string };
  },
): string {
  const target = opts.toUpstreamProxy ? (req.url ?? path) : path;
  const requestLine = `${req.method} ${target} HTTP/${req.httpVersion}${CRLF}`;

  const headerLines: string[] = [];

  const raw = req.rawHeaders ?? [];

  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];

    // 出站净化与 sanitizeHeaders 同谓词：任意 proxy- 前缀 + 命中代理凭证的 authorization
    if (isStrippableOutboundHeader(name, value, opts.auth)) {
      continue;
    }

    if (name.toLowerCase() === HEADER_NAME_HOST_LOWER) {
      headerLines.push(`${HEADER_NAME_HOST_TITLE}: ${formatAuthority(host, port)}`);
    } else {
      headerLines.push(`${name}: ${value}`);
    }
  }

  // 仅向 http/https 上游代理注入（与 http-request 路径同规则）：socks 隧道/直连直达真实目标，不得携带
  if (opts.toUpstreamProxy) {
    const auth = upstreamAuthValue(opts.credentials);

    if (auth) {
      headerLines.push(`${HEADER_NAME_PROXY_AUTHORIZATION}: ${auth}`);
    }
  }

  return `${requestLine}${headerLines.join(CRLF)}${DOUBLE_CRLF}`;
}

/**
 * 上游应答首包 → 状态行（`upstream-refused` 事件的 `statusLine` 字段）
 * @param head - 上游应答首包（状态行 + 响应头 [+ 已读字节]）
 */
function statusLineOf(head: Buffer): string {
  return head.toString().split(CRLF)[0];
}

/**
 * 传输策略公共基类 - 拨号器、形状/上游闸门、事实发射、应答收尾的**唯一收口**
 * @description 只拿到 `ForwarderContext`（计划 + 应答器 + 活对象 + 事件汇 + 鉴权判据）：
 * 它**刻意不持有任何实例插件**，因此「传输策略零配置、跨入站复用」成立。
 * 与 `core/forward/inbound/base.ts:InboundForwarderBase` 的分工：那边持有
 * `ForwarderDeps` 做路由决策与守卫接线，这边只消费**已被批准**的计划。
 */
abstract class TransportForwarderBase implements ForwarderProvider {
  /** 注册表键回显（各子类以字面量声明，与 `ForwardTransport` 同步） */
  abstract readonly transport: ForwardTransport;

  /** 共享拨号器（稳态无状态，跨会话复用） */
  protected readonly dialer = new Dialer();

  /**
   * 契约入口：执行一次传输，**resolve 表示计划已执行完毕**
   * @description 兜底网只接「策略自身的编程错误」——各 `execute` 各自 catch 拨号失败并
   * 完成了协议应答，走到这里说明是未预期异常。仍然不把它抛给数据面（契约：forward 不抛
   * 未处理异常），也仍然按成因分流状态码而不是无条件 502。
   * @param ctx - 计划之外的本次连接上下文
   */
  async forward(ctx: ForwarderContext): Promise<void> {
    try {
      await this.execute(ctx);
    } catch (e) {
      this.emit(ctx, {
        type: "upstream-error",
        message: `[${this.transport}] internal forward failure: ${errorText(e)}`,
        err: e,
      });
      this.refuseByCause(ctx.responder, e);
    }
  }

  /** 子类的传输执行体（各自负责 catch 拨号失败并完成应答） */
  protected abstract execute(ctx: ForwarderContext): Promise<void>;

  /**
   * 事实发射（附本会话身份 + 容错包装）
   * @description - 身份经 `ctx.responder.username` 逐次取用、**绝不存字段**：同一个策略实例
   *   会被多个并发会话共用，存字段必然串号（与入站侧 `emitWithUser` 同理由）
   * - 事件汇是调用方的回调，监听器抛错**不得反噬数据面**（同 `guard:createEventEmitter`
   *   与 `BaseProxy.setState` 的 emit 保护）
   * @param ctx - 本次连接上下文
   * @param fact - 事实（`type` 是稳定 grep 契约，落盘等级由 server 层定）
   */
  protected emit(ctx: ForwarderContext, fact: ForwardFact): void {
    const user = ctx.responder.username;
    try {
      ctx.emit(user ? { ...fact, user } : fact);
    } catch {
      // 事件汇异常就地吞掉：数据面的成败由 responder 决定，不受日志链路影响
    }
  }

  /**
   * 拨号/转发失败事实（`upstream-error`，server 层落 warn）
   * @description 成因必须随事实上抛（TLS 校验失败 / ECONNREFUSED / DNS 都落在这条），
   * 否则 502 在日志里无痕。`err` 一并带上，server 层渲染成可读单行。
   *
   * **与守卫事件去重**：拨号守卫（`socksUpstreamGuard` → `guardDialing.fail`）在拨号失败时
   * 自己就发一条 `upstream-error`/`upstream-timeout`，catch 再发一条会让**每一次失败落两条
   * 重复 warn**。于是用 {@link dialReporter} 记录「本次拨错的成因是否已由守卫上抛」，
   * 只在守卫没报过时才补发——既保住「502 必带成因」的红线，又不制造噪音。
   * @param ctx - 本次连接上下文
   * @param route - 日志路由串（如 `example.com:443 via 127.0.0.1:1080`）
   * @param cause - 原始异常
   */
  protected emitUpstreamError(ctx: ForwarderContext, route: string, cause: unknown): void {
    this.emit(ctx, {
      type: "upstream-error",
      message: `[${this.transport}] upstream error ${route}: ${errorText(cause)}`,
      err: cause,
    });
  }

  /**
   * 一次拨号的「成因是否已上抛」记账器（守卫事件与 catch 事件去重）
   * @description `onEvent` 挂在守卫选项上，透传全部守卫事件（`dial` / `established` /
   *   `upstream-timeout` / `upstream-error` / `client-error`），只在**失败类**事件出现时记账；
   *   `reported()` 为 true 时调用点不再补发 `upstream-error`。
   * @param ctx - 本次连接上下文
   * @returns `onEvent`（守卫事件汇）与 `reported`（记账查询）
   */
  protected dialReporter(ctx: ForwarderContext): {
    onEvent: HelperEventSink;
    reported: () => boolean;
  } {
    let reported = false;

    return {
      onEvent: (e) => {
        if (e.type === "upstream-error" || e.type === "upstream-timeout") {
          reported = true;
        }

        this.emit(ctx, e);
      },
      reported: () => reported,
    };
  }

  /**
   * 按拨号成因拒绝收尾：超时回 504，其余回 502
   * @description catch 里一刀切 502 会吃掉超时成因（`DialTimeoutError` 是唯一可辨识的
   * 超时标记，由 `Dialer` 抛出）。SOCKS 语境不区分——应答器忽略状态码一律回 FAIL。
   * @param responder - 协议应答器（写什么形态由入站协议决定）
   * @param cause - catch 到的异常
   */
  protected refuseByCause(responder: ProtocolResponder, cause: unknown): void {
    responder.fail(
      cause instanceof DialTimeoutError ? STATUS_GATEWAY_TIMEOUT : STATUS_BAD_GATEWAY,
    );
  }

  /**
   * 拒绝收尾：把状态码交给协议应答器（形态由入站协议自决）
   * @param responder - 协议应答器
   * @param status - 语义状态码（400/403/502/504，映射到报文由协议自理）
   */
  protected refuse(responder: ProtocolResponder, status: number): void {
    responder.fail(status);
  }

  /**
   * 形状闸门：按 `plan.payload` 决定本次传输的形态，并取出必需的活对象
   * @description 两个形态各自的必需条件（任一不满足即发 `upstream-error` 事实 + 502 并返回 null）：
   * - `http-request`：需要 `ctx.request`（`http.request` 的报文来源）；出站凭证剥离还要
   *   `ctx.auth`（`ForwarderContext` 的**必填**字段，契约上不存在「没给」这一形态）
   * - `raw-stream`：需要 `ctx.client`（裸流桥接的两端都是必需的）
   *
   * 形状判据是**载荷**而不是入站：`plan.payload` 由路由插件按入站派生
   * （`http` → `http-request`，其余 → `raw-stream`），传输策略消费它即可，
   * 不再需要「哪些入站我服务得了」的白名单。
   * @param ctx - 本次连接上下文
   * @returns 本形态必需的活对象；已拒绝并应答完毕返回 null
   */
  protected gateShape(
    ctx: ForwarderContext,
  ): { client: Duplex | undefined; request: http.IncomingMessage | undefined } | null {
    const { plan, responder } = ctx;
    const problem =
      plan.payload === "http-request"
        ? ctx.request
          ? undefined
          : "no inbound request for http-request payload"
        : ctx.client
          ? undefined
          : "no client stream for raw-stream payload";

    if (problem !== undefined) {
      this.emit(ctx, {
        type: "upstream-error",
        message: `[${this.transport}] unusable forward shape ${plan.payload}: ${problem}`,
      });
      responder.fail(STATUS_BAD_GATEWAY);
      return null;
    }

    return { client: ctx.client, request: ctx.request };
  }

  /**
   * 上游端点闸门（fail-closed）+ 上游自环纵深防御
   * @description 两条都是「绝不静默直连」：
   * - 契约只保证「`direct-stream` 时必须缺省 `upstream`」，反方向靠这里守住。路由插件一旦
   *   给出残缺计划（装配 bug），若静默按直连处理，本该走企业上游的流量会**直连出去**——
   *   绕过出口策略的泄漏远比断链危险，故发 `upstream-error` + 502。
   * - 上游指回 `plan.listen`（本实例监听地址）会成环：真实目标的自环已由路由插件与入站层
   *   的 `preDial` 判过，这里查的是**上游端点**。命中发 `loop-detected` + 502（自环恒 502，
   *   与名单拒绝的 403 绝不合并）。
   * @param ctx - 本次连接上下文
   * @returns 计划里冻结的上游端点；已拒绝并应答完毕返回 null
   */
  protected gateUpstream(ctx: ForwarderContext): UpstreamEndpoint | null {
    const { plan, responder } = ctx;
    const upstream = plan.upstream;

    if (!upstream) {
      this.emit(ctx, {
        type: "upstream-error",
        message: `[${this.transport}] plan transport=${plan.transport} without upstream endpoint`,
        target: `${plan.target.host}:${plan.target.port}`,
      });
      responder.fail(STATUS_BAD_GATEWAY);
      return null;
    }

    if (isSelfLoop(upstream.host, upstream.port, plan.listen)) {
      this.emit(ctx, {
        type: "loop-detected",
        target: `${upstream.host}:${upstream.port}`,
        detail: `${upstream.host}:${upstream.port} points at own listen address`,
      });
      responder.fail(STATUS_BAD_GATEWAY);
      return null;
    }

    return upstream;
  }

  /**
   * 把「上游给了应答，但不是我要的成功码」交给协议层自己答
   * @description
   * **不是成功码就绝不降级成 502**——上游的 407（要重新鉴权）/ 403 / 404 对客户端都是
   * 有效应答，抹成 502 会让客户端做出错误判断。形态由应答器自决：
   * - 裸 socket 通道（connect / upgrade）：`head` 原样写回客户端（因此 CONNECT 客户端
   *   重新拿得到 `Proxy-Authenticate`）
   * - HTTP 通道：写 `ServerResponse`
   * - **未实现该钩子的入站（SOCKS）**：把 HTTP 字节写进 SOCKS 流就是协议污染，
   *   回退到「发 `upstream-refused` 事实 + `responder.fail(502)`」，与重构前逐字一致。
   *   （裸 socket 通道的 `fail` 写的正是预拼状态行 `httpReplyFor(502)`，两种回退形态都由
   *   应答器自决，本层**不拼任何入站报文**。）
   * @param ctx - 本次连接上下文
   * @param statusCode - 上游状态码字符串（`readResponseHead` 已严格提取三位码）
   * @param head - 上游应答首包（状态行 + 响应头 + 紧随其后的已读字节）
   * @param socket - 已建链的上游（本方法负责销毁：应答交出去后它没有存在意义了）
   * @returns 已收尾（无论走透传还是回退）
   */
  protected relayUpstream(
    ctx: ForwarderContext,
    statusCode: string,
    head: Buffer,
    socket: Duplex,
  ): void {
    const { responder } = ctx;
    const line = statusLineOf(head);

    this.emit(ctx, {
      type: "upstream-refused",
      statusLine: line,
    });

    if (responder.relayUpstreamResponse) {
      responder.relayUpstreamResponse({
        status: Number(statusCode),
        statusLine: line,
        head,
        socket,
      });
      return;
    }

    // 协议无透传能力（只有 SOCKS）：销毁上游并按网关失败收尾。
    // 裸 socket 通道的 `fail` 写的正是预拼状态行（`httpReplyFor(502)`），SOCKS 应答器忽略
    // 状态码一律回 FAIL —— 两种回退形态都由应答器自决，本层不拼任何入站报文
    socket.destroy();
    responder.fail(STATUS_BAD_GATEWAY);
  }

  /**
   * 建隧收尾的**协议无关**部分：成功应答 → 两侧余量回灌 → 双向桥接
   * @description
   * - 成功应答交给 `responder.establish()`：tunnel 写固定 200 行、SOCKS 回 replySuccess
   *   （BND 由 extra.local 携带）、http 是空实现、upgrade 透传上游 101 头——**本层不拼任何
   *   协议字节**。
   * - `local` 只在**成对拿到**绑定时交出（见 {@link localBinding}），缺省即让应答器回退
   *   `0.0.0.0:0` 并发 `debug` 事件，绝不因此抛错或让会话失败。
   * - 两侧余量都在 `bridge` **之前**落盘：客户端握手之后的已读首包写给上游，上游应答头
   *   之后的先发字节（server-speaks-first 协议首包）写给客户端。先桥接后写会丢字节。
   * @param ctx - 本次连接上下文
   * @param client - 客户端双工流
   * @param upstream - 已建链的上游
   * @param toUpstream - 写给上游的余量（`ctx.head`），空则不写
   * @param toClient - 写给客户端的余量（上游应答头之后的先发字节），空则不写
   */
  protected establishAndBridge(
    ctx: ForwarderContext,
    client: Duplex,
    upstream: Duplex,
    toUpstream?: Buffer,
    toClient?: Buffer,
  ): void {
    const local = localBinding(upstream);
    ctx.responder.establish(local ? { local } : undefined);

    if (toUpstream?.length) {
      upstream.write(toUpstream);
    }

    if (toClient?.length) {
      client.write(toClient);
    }

    this.dialer.bridge(client, upstream);
  }

  /**
   * Upgrade 通道的传输执行（`:upgrade` 入站）：拨号 → 写握手报文 → 回灌已读半包 → 等 101 桥接
   * @description
   * `dial` 闭包由各策略给出（直拨目标 / 拨上游端点 / 先建 SOCKS 隧道），本方法只管
   * 握手语义——它由**传输方式**决定（`plan.transport === "http-upstream"` 是
   * absolute-form + 注入 `Proxy-Authorization` 的唯一判据），与入站协议无关。
   * @param ctx - 本次连接上下文
   * @param client - 客户端双工流
   * @param dial - 拨号闭包（版本/TLS 承载由各策略的端点推导，不在本方法重复推导）
   * @param reported - 「本次拨错的成因是否已由守卫上抛」查询（避免重复 warn）
   */
  protected async upgradeOver(
    ctx: ForwarderContext,
    client: Duplex,
    dial: () => Promise<Duplex>,
    reported: () => boolean,
  ): Promise<void> {
    const { plan, request, head, responder } = ctx;
    const { host, port } = plan.target;

    if (!request) {
      // buildUpgradeReq 必须重放原始握手报文，缺 request 就是装配错误
      this.emit(ctx, {
        type: "upstream-error",
        message: `[${this.transport}] upgrade forward without inbound request`,
      });
      responder.fail(STATUS_BAD_GATEWAY);
      return;
    }

    const toUpstreamProxy = plan.transport === "http-upstream" && plan.upstream !== undefined;
    const route = `${host}:${port}`;

    try {
      const upstreamSock = await dial();

      upstreamSock.write(
        buildUpgradeReq(request, host, port, plan.target.path, {
          toUpstreamProxy,
          auth: ctx.auth,
          credentials: credentialsOf(plan.upstream),
        }),
      );

      if (head?.length) {
        upstreamSock.write(head);
      }

      await this.relayUpgrade(ctx, client, upstreamSock, route, plan.timeoutMs);
    } catch (e) {
      // 拨号失败成因必须落盘（守卫 keepClientOnFailure 留了客户端），随后按成因写状态行收尾
      if (!reported()) {
        this.emitUpstreamError(ctx, route, e);
      }

      this.refuseByCause(responder, e);
    }
  }

  /**
   * 等 101 桥接：严格解析状态行判 101；非 101 原样回透响应后按上游 EOF 语义收尾
   * @description
   * - 状态行用 RE_HTTP_STATUS_LINE 提取三位码严格比对，避免 `302` + `Content-Length: 1010`
   *   之类子串被 `includes("101")` 误判为升级成功
   * - 等待收口在 `awaitStatusLine`：定时器归其所有（预算来自 `plan.timeoutMs`），上游失败时由它销毁，
   *   超时/超限成因经 upstream-error 上抛，客户端按成因写 504/502 收尾（不再静默双毁）
   * - **非 101 不再截断**：首包交给应答器原样回透（`relayUpstreamResponse`），再由应答器按
   *   `upstream.readableEnded` 分流续传剩余 body——**该分流归应答器所有**（它才持有客户端
   *   socket），否则 `Content-Length` 大于首包时客户端挂等
   * @param ctx - 本次连接上下文
   * @param client - 客户端双工流
   * @param upstream - 已建链的上游
   * @param route - 目标地址（失败日志路由）
   * @param timeoutMs - 等状态行的超时预算（来自 `ForwardPlan.timeoutMs`）
   */
  private async relayUpgrade(
    ctx: ForwarderContext,
    client: Duplex,
    upstream: Duplex,
    route: string,
    timeoutMs: number,
  ): Promise<void> {
    const res = await awaitStatusLine(upstream, {
      timeout: timeoutMs,
      onTimeout: () => {
        this.emit(ctx, {
          type: "upstream-error",
          message: `[${this.transport}] upgrade upstream response timeout ${route}`,
        });
      },
      onOverflow: () => {
        this.emit(ctx, {
          type: "upstream-error",
          message: `[${this.transport}] upgrade upstream response overflow ${route}`,
        });
      },
    });

    if (!res.ok) {
      // 超时/超限：上游已由 awaitStatusLine 销毁、成因已落盘；客户端按成因写 504/502 后收尾
      this.refuse(
        ctx.responder,
        res.cause === "timeout" ? STATUS_GATEWAY_TIMEOUT : STATUS_BAD_GATEWAY,
      );
      return;
    }

    // 严格取状态码：仅 101 视为升级成功，杜绝 `302` + `Content-Length: 1010` 之类子串误判
    if (res.statusCode === String(STATUS_SWITCHING_PROTOCOLS)) {
      // 101 响应原样透传给客户端（应答器不拼状态行），先发字节紧随其后
      ctx.responder.establish({
        head: res.rest.length ? Buffer.concat([res.head, res.rest]) : res.head,
      });

      this.dialer.bridge(client, upstream);
      return;
    }

    // 非 101：首包（含紧随其后的已读字节）交给应答器——它负责原样回透并按上游 EOF 分流续传
    this.relayUpstream(ctx, res.statusCode, Buffer.concat([res.head, res.rest]), upstream);
  }

  /**
   * `http-request` 载荷的语义转发：出站请求 + 上游响应移交
   * @description
   * 逐字搬运自原 `core/forward/http.ts` 的 `forwardViaRequest` / `dialViaSocksAndForward` /
   * `wireClientToUpstream`，差别只有「上游响应交给谁」：
   * - 拨号/报文：直连与 http/https 上游**共用同一份**（差异仅在「拨谁」与「要不要注上游凭证」）；
   *   socks 上游多一段「先建隧道、把隧道 socket 作为 `createConnection` 交给 `http.request`」，
   *   让 Node 负责请求体分帧（chunked / Content-Length）、Expect/1xx、响应解析与头透传
   * - 出站凭证剥离：`sanitizeHeaders(req.headers, ctx.auth)` —— `ctx.auth` 与入站鉴权同源，
   *   漏剥等于把代理自己的凭证泄漏给目标站（此前本层拿不到判据，只能对 client 模式 fail-closed 断链）
   * - **上游响应绝不降级 502**：`incoming` 形态交 `responder.relayUpstreamResponse`
   *   （404/407/500 对客户端都是有效应答）
   *
   * 客户端中断（`ctx.client` 关闭）时销毁上游请求与隧道：与裸流路径的 `guardDialing`
   * （`client.on("close") → upstream.destroy()`）同形，避免客户端走了而上游还挂着。
   * @param ctx - 本次连接上下文
   * @param tunnel - 已建好的 SOCKS 隧道（`socks-upstream` 载荷）；其余传输为 undefined
   */
  protected forwardHttpRequest(ctx: ForwarderContext, tunnel?: Duplex): void {
    const { plan, request } = ctx;

    if (!request) {
      return;
    }

    // 上游端点存在 ⇔ 有效模式为 client：拨号目标是上游，报文形态与凭证注入都按 client 语义
    // （`direct-stream` 契约上必须缺省 upstream，socks-upstream 走 `tunnel` 分支）
    const upstream =
      tunnel === undefined && plan.transport !== "direct-stream" ? plan.upstream : undefined;
    const viaUpstreamProxy = upstream !== undefined;
    const host = upstream ? upstream.host : plan.target.host;
    const port = upstream ? upstream.port : plan.target.port;
    const headers = sanitizeHeaders(request.headers as never, ctx.auth);

    if (upstream) {
      // 仅端点里显式配了上游用户名才注入：防 client 头透传泄漏
      const auth = upstreamAuthValue(credentialsOf(upstream));

      if (auth) {
        (headers as Record<string, unknown>)["proxy-authorization"] = auth;
      }
    } else if (tunnel) {
      // socks 隧道直达源站（非上游代理）：重写 Host 对齐目标（IPv6 经 formatAuthority 补回方括号，
      // 避免 `::1:80` 畸形 authority）；强制 close 让源站关连接
      headers[HEADER_NAME_HOST_LOWER] = formatAuthority(plan.target.host, plan.target.port);
      headers[HEADER_NAME_CONNECTION] = HEADER_VALUE_CLOSE;
    } else {
      // RFC 7230 §5.4：absolute-form 必须忽略客户端 Host，按 request-target 的权威值回写，
      // 否则源站会收到与建链目标不一致的 Host（虚拟主机/ACL/缓存键混淆）
      const authority = absoluteFormAuthority(request.url ?? "");

      if (authority) {
        (headers as Record<string, unknown>)[HEADER_NAME_HOST_LOWER] = authority;
      }
    }

    // 与上游分流同规则：直连与 socks 隧道用解析后的 origin-form（plan.target.path 已归一），
    // 经 http 上游保留客户端原始形态
    const path = viaUpstreamProxy ? (request.url ?? "/") : plan.target.path;
    const label = tunnel
      ? `[${this.transport}] upstream error via socks ${plan.target.host}:${plan.target.port}`
      : `[${this.transport}] upstream error ${host}:${port}`;

    const opts: https.RequestOptions = {
      host,
      port,
      method: request.method,
      path,
      headers: headers as never,
      // 预算来自计划（不再是任何一层读配置）
      timeout: plan.timeoutMs,
      // TLS 专属选项只在 TLS 分支注入（servername/rejectUnauthorized/ca 三选项
      // 收敛在 upstreamTlsOptions：证书校验锚定建链目标，IP 按 RFC6066 置空 SNI）
      // **策略来自 plan.upstreamTls**（路由插件按实例现读 scope 冻结，热加载对新请求即生效）
      ...(upstream?.secure ? upstreamTlsOptions(host, plan.upstreamTls) : {}),
      // 复用已建隧道：不传 agent，由 createConnection 返回隧道 socket 作为连接
      ...(tunnel ? { createConnection: () => tunnel } : {}),
    };

    const onResponse = (upRes: http.IncomingMessage): void => {
      // 上游响应就是本通道的应答（状态码 200/404/407/500 对客户端都是有效应答）：
      // 交应答器写 `ServerResponse`，本层不认 `ServerResponse`
      if (!ctx.responder.relayUpstreamResponse) {
        // 形状守卫已保证 http-request 载荷只出现在 HTTP 通道（它实现了该钩子）；
        // 真到这里说明应答器装配异常：销毁上游并按网关失败收尾，绝不静默丢响应
        this.emit(ctx, {
          type: "upstream-error",
          message: `[${this.transport}] responder cannot relay upstream response`,
        });
        upRes.destroy();
        ctx.responder.fail(STATUS_BAD_GATEWAY);
        return;
      }

      ctx.responder.relayUpstreamResponse({
        status: upRes.statusCode ?? STATUS_BAD_GATEWAY,
        statusLine: `HTTP/${upRes.httpVersion} ${upRes.statusCode ?? STATUS_BAD_GATEWAY}`,
        incoming: upRes,
      });
    };

    const proxy =
      upstream?.secure === true
        ? https.request(opts, onResponse)
        : http.request(opts, onResponse);

    this.wireClientToUpstream(ctx, proxy, label, tunnel);
  }

  /**
   * 上游请求收尾统一下挂：error / timeout / 客户端中断 / 请求体泵送
   * @description
   * - error：上报 upstream-error（含成因）后按成因应答 —— 此前静默 502，TLS 校验失败与连接拒绝无法区分；
   *   超时（`DialTimeoutError`）回 504，其余回 502（**一刀切 502 会吃掉超时成因**）
   * - timeout：只 destroy，具体状态码由 error 兜底统一回
   * - 客户端中断：销毁上游请求避免悬挂至超时；经隧道转发时一并销毁隧道
   *   （判据是 `ctx.client` 关闭——HTTP 通道的 `res.on("close")` 曾带 `!res.writableEnded`
   *   以放过「正常完成」，而正常完成时上游响应已 `pipe` 完毕、销毁上游请求是空操作）
   * @param ctx - 本次连接上下文
   * @param proxy - 出站请求
   * @param label - 上游失败日志前缀（直连 / 经上游 / 经 socks 隧道三条文案不同）
   * @param tunnel - 经 SOCKS 隧道时的隧道 socket，客户端中断需一并销毁
   */
  private wireClientToUpstream(
    ctx: ForwarderContext,
    proxy: http.ClientRequest,
    label: string,
    tunnel?: Duplex,
  ): void {
    proxy.on("error", (err: Error) => {
      this.emit(ctx, {
        type: "upstream-error",
        message: `${label}: ${err.message}`,
        err,
      });
      this.refuseByCause(ctx.responder, err);
    });

    // timeout 只 destroy：具体状态码由 error 兜底统一回
    proxy.on("timeout", () => {
      proxy.destroy();
    });

    // 客户端中断：销毁上游请求，避免悬挂至超时
    ctx.client?.once("close", () => {
      proxy.destroy();

      if (tunnel && !tunnel.destroyed) {
        tunnel.destroy();
      }
    });

    ctx.request?.pipe(proxy);
  }
}

/**
 * `direct-stream` 传输策略 - 直拨真实目标
 * @description 跨四条入站通道复用的最纯粹一档：明文 `net.connect` 拨 `plan.target`，成功后
 * 「应答 + 回灌余量 + 桥接」。http / connect / upgrade / socks 四种入站共用它，
 * 协议差异全在 `responder` 与入站层的握手解析里。
 * @example
 * ```ts
 * const fwd = new DirectStreamForwarderPlugin();
 * await fwd.forward(ctx); // ctx.plan.transport === "direct-stream"
 * ```
 */
export class DirectStreamForwarderPlugin extends TransportForwarderBase {
  readonly transport = "direct-stream" as const;

  /**
   * 直拨真实目标（三种载荷形态各自收尾）
   * @description 失败成因由 `dialDirect` 的守卫（`socksUpstreamGuard`：空 reply + 保客户端）
   * 上抛到 `ctx.emit`，本方法只负责按成因给状态码——**守卫与 catch 不同时写应答**
   * （守卫保客户端正是为了让应答写得出去）。
   * @param ctx - 计划之外的本次连接上下文
   */
  protected async execute(ctx: ForwarderContext): Promise<void> {
    const shape = this.gateShape(ctx);

    if (!shape) {
      return;
    }

    const { plan } = ctx;
    const { host, port } = plan.target;
    const route = `${host}:${port}`;

    if (plan.payload === "http-request") {
      this.forwardHttpRequest(ctx);
      return;
    }

    const client = shape.client;

    if (!client) {
      return;
    }

    const dial = this.dialReporter(ctx);
    const dialTarget = (): Promise<Duplex> =>
      this.dialer.dialDirect(client, host, port, {
        timeoutMs: plan.timeoutMs,
        tls: plan.upstreamTls,
        target: route,
        guard: socksUpstreamGuard(this.transport, dial.onEvent),
      });

    if (plan.inbound === "upgrade") {
      await this.upgradeOver(ctx, client, dialTarget, dial.reported);
      return;
    }

    try {
      this.establishAndBridge(ctx, client, await dialTarget(), ctx.head);
    } catch (e) {
      if (!dial.reported()) {
        this.emitUpstreamError(ctx, route, e);
      }

      this.refuseByCause(ctx.responder, e);
    }
  }
}

/**
 * `http-upstream` 传输策略 - 经 http/https 上游转发
 * @description 一条策略同时服务三种载荷形态：
 * - `raw-stream` + `connect`：`dialViaHttpUpstream`（拨上游 → 发 CONNECT → 等状态行）；
 *   200 建隧桥接，**非 200 原样透传不断链**（CONNECT 客户端因此重新拿得到 `Proxy-Authenticate`）
 * - `raw-stream` + `upgrade`：**不**用 CONNECT——上游代理自己处理 Upgrade，形态是
 *   「拨上游端点 + 发 absolute-form 握手 + 等 101」（上游代理收到 origin-form 的 `GET /ws`
 *   会当成「发给代理自身的请求」而不会转发升级）
 * - `http-request`：`http(s).request` 打到上游，保留客户端原始 request-target 并注入上游凭证
 * @example
 * ```ts
 * const fwd = new HttpUpstreamForwarderPlugin();
 * await fwd.forward(ctx); // ctx.plan.transport === "http-upstream"
 * ```
 */
export class HttpUpstreamForwarderPlugin extends TransportForwarderBase {
  readonly transport = "http-upstream" as const;

  /**
   * 经 http/https 上游转发
   * @param ctx - 计划之外的本次连接上下文
   */
  protected async execute(ctx: ForwarderContext): Promise<void> {
    const shape = this.gateShape(ctx);

    if (!shape) {
      return;
    }

    const upstream = this.gateUpstream(ctx);

    if (!upstream) {
      return;
    }

    const { plan, head } = ctx;
    const { host, port } = plan.target;
    const route = `${host}:${port} via ${upstream.host}:${upstream.port}`;
    const dial = this.dialReporter(ctx);

    if (plan.payload === "http-request") {
      this.forwardHttpRequest(ctx);
      return;
    }

    const client = shape.client;

    if (!client) {
      return;
    }

    if (plan.inbound === "upgrade") {
      // Upgrade 走「直接拨上游端点」：上游自己终结握手，不经 CONNECT 隧道
      await this.upgradeOver(
        ctx,
        client,
        () =>
          this.dialer.choose(client, upstream.host, upstream.port, upstream.secure, {
            timeoutMs: plan.timeoutMs,
            tls: plan.upstreamTls,
            guard: socksUpstreamGuard(this.transport, dial.onEvent),
            target: `${upstream.host}:${upstream.port}`,
          }),
        dial.reported,
      );
      return;
    }

    try {
      const dialed = await this.dialer.dialViaHttpUpstream(client, host, port, route, {
        upstream,
        timeoutMs: plan.timeoutMs,
        tls: plan.upstreamTls,
        // 守卫自己不回报文（成败应答在本方法），但成因必须上抛到日志
        onEvent: dial.onEvent,
        logPrefix: this.transport,
      });

      if (dialed.statusCode !== String(STATUS_OK)) {
        this.relayUpstream(
          ctx,
          dialed.statusCode,
          Buffer.concat([dialed.head, dialed.rest]),
          dialed.sock,
        );
        return;
      }

      // rest 属上游发往客户端方向（服务端先说话的协议首包），回写 client 而非 upstream
      this.establishAndBridge(ctx, client, dialed.sock, head, dialed.rest);
    } catch (e) {
      if (!dial.reported()) {
        this.emitUpstreamError(ctx, route, e);
      }

      this.refuseByCause(ctx.responder, e);
    }
  }
}

/**
 * `socks-upstream` 传输策略 - 经 SOCKS4/5 上游二次握手到真实目标
 * @description 跨入站复用的最纯粹一档：握手版本与 TLS 承载由 `Dialer.dialSocks` 依端点
 * `protocol`/`secure` 推导（**同一个事实只有一处来源**，调用点不重复推导），本类只在
 * 日志路由串里用一次 `socksVersionOf`。
 * @example
 * ```ts
 * const fwd = new SocksUpstreamForwarderPlugin();
 * await fwd.forward(ctx); // ctx.plan.transport === "socks-upstream"
 * ```
 */
export class SocksUpstreamForwarderPlugin extends TransportForwarderBase {
  readonly transport = "socks-upstream" as const;

  /**
   * 经 SOCKS 上游转发
   * @param ctx - 计划之外的本次连接上下文
   */
  protected async execute(ctx: ForwarderContext): Promise<void> {
    const shape = this.gateShape(ctx);

    if (!shape) {
      return;
    }

    const upstream = this.gateUpstream(ctx);

    if (!upstream) {
      return;
    }

    const { plan } = ctx;
    const { host, port } = plan.target;
    // 版本号只用于日志文案：握手版本由 dialSocks 内部按端点 protocol 推导（不重复推导）
    const version = socksVersionOf(upstream.protocol);
    const route = `${host}:${port} via socks${version} ${upstream.host}:${upstream.port}`;
    const dial = this.dialReporter(ctx);
    // SOCKS 隧道的两端之一恒是客户端双工流（三种载荷形态都要），故在这里收口到一处拨号
    const client = ctx.client;

    if (!client) {
      return;
    }

    const dialTunnel = (): Promise<Duplex> =>
      this.dialer.dialSocks(client, host, port, {
        upstream,
        timeoutMs: plan.timeoutMs,
        tls: plan.upstreamTls,
        target: route,
        // 失败统一由下方 catch 按成因回 504/502：守卫经 socksUpstreamGuard 收口
        // （空 reply + 保客户端，成因经 onEvent 上抛到日志）
        guard: socksUpstreamGuard(this.transport, dial.onEvent),
      });

    if (plan.payload === "http-request") {
      // 先建隧道，再把隧道 socket 作为 `createConnection` 交给 `http.request`：
      // 让 Node 负责请求体分帧与响应解析，隧道只承担字节搬运
      try {
        this.forwardHttpRequest(ctx, await dialTunnel());
      } catch (e) {
        if (!dial.reported()) {
          this.emitUpstreamError(ctx, route, e);
        }

        this.refuseByCause(ctx.responder, e);
      }

      return;
    }

    if (plan.inbound === "upgrade") {
      await this.upgradeOver(ctx, client, dialTunnel, dial.reported);
      return;
    }

    try {
      this.establishAndBridge(ctx, client, await dialTunnel(), ctx.head);
    } catch (e) {
      if (!dial.reported()) {
        this.emitUpstreamError(ctx, route, e);
      }

      this.refuseByCause(ctx.responder, e);
    }
  }
}

/**
 * 创建传输策略注册表（默认装配）
 *
 * @description 三个实现都是**无状态**的（只持有一个 `Dialer`），因此注册表可以被多个
 * 实例共享；每次调用仍产出一份新表，便于某个实例整表替换（例如只挂 `direct-stream` 禁掉
 * 上游串联）。**不做兜底实现**：未注册的传输键由 `require()` fail-fast 抛错，装配错误必须
 * 早于运行暴露（静默回落直连会让本该走企业上游的流量直连出去）。
 *
 * @returns 键为 `ForwardTransport`、值为 `ForwarderProvider` 的注册表
 * @example
 * ```ts
 * const forwarders = createForwarderRegistry();
 * forwarders.keys(); // ["direct-stream", "http-upstream", "socks-upstream"]
 * await forwarders.require(plan.transport).forward(ctx);
 * ```
 */
export function createForwarderRegistry(): PluginRegistry<ForwardTransport, ForwarderProvider> {
  return createPluginRegistry<ForwardTransport, ForwarderProvider>([
    ["direct-stream", new DirectStreamForwarderPlugin()],
    ["http-upstream", new HttpUpstreamForwarderPlugin()],
    ["socks-upstream", new SocksUpstreamForwarderPlugin()],
  ]);
}
