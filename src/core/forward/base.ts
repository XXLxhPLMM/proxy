/**
 * @fileoverview 入站转发公共基类 - 依赖、事件槽、拒绝收尾
 * @module core/forward/base
 * @description
 * 四个**入站适配器**（`inbound/{http,tunnel,websocket,socks}.ts`）共享的那部分
 * 逐字重复胶水收敛到一处。入站适配器的职责被刻意收窄为**协议适配**：
 *
 * ```
 * 解析入站报文 → routing.plan() → 取 forwarders[plan.transport] → forward(ctx) → 自己答协议
 * ```
 *
 * 本类收的全是「与协议无关、与实例有关」的东西：
 * - `deps`：本实例的四个能力插件（日志/鉴权/访问控制/路由）+ **传输策略注册表**，
 *   由组合根一次性注入。**没有 `config`**——出站 TLS 校验策略已冻结进 `ForwardPlan.upstreamTls`，
 *   「转发器零配置读取」不再有例外（此前 `tlsPolicy()` 是唯一一处 `deps.config.scope` 现读）
 * - `emit`：同时承载本层 `PipeEvent`（route/target-unresolved 等）与入站侧的 `debug` 事实，
 *   server 层按 `type` 统一分派
 * - `emitWithUser`：附带已鉴权用户名发事件（SOCKS 的每会话身份经参数逐次传入）
 * - `context`：把「计划 + 应答器 + 活对象 + 事件汇 + `auth`」装配成传输策略唯一的入参
 *   （`auth` 是**出站凭证剥离的唯一判据**，由本类从 `deps` 统一注入，各入站不必各写一遍）
 * - `dialTarget`：拨号目标（自环守卫的判定对象）——`direct-stream` 即客户端请求的目标，
 *   其余取计划里冻结的上游端点
 * - `requireUpstream`：**fail-closed** 地取计划里冻结的上游端点
 * - `refuse`：拒绝收尾，把状态码交给协议应答器
 *
 * 刻意**不在**本类的东西（它们各归其位，见 `inbound/base.ts` 与 `plugins/forwarders.ts`）：
 * - 路由决策（`planRoute`）、前置守卫接线（`preDial`）、路由事件（`emitRoute`）：
 *   `inbound/base.ts:InboundForwarderBase`（入站侧编排）
 * - **一切拨号与字节搬运**（`Dialer`、CONNECT/Upgrade 报文、http-request 语义转发、
 *   出站凭证剥离、拨号成因分流）：`plugins/forwarders.ts` 的传输策略。
 *   入站适配器**不再持有 `Dialer`**——它不拨号，只决定「按哪个传输策略搬」
 *
 * core 零日志禁区：本类不打印任何东西，事实一律经 `emit` 上抛，落盘归
 * `src/server/index.ts:bindProxyEventLogs`。
 */

import type { Duplex } from "node:stream";
import type http from "node:http";
import { createEventEmitter } from "@/core/guard.js";
import type { PipeEvent, PipeEventSink } from "@/core/types/proxy.js";
import type {
  ForwarderContext,
  ForwardFact,
  ForwardPlan,
  ForwardTransport,
  ProtocolResponder,
  UpstreamEndpoint,
} from "@/core/types/plan.js";
import { STATUS_BAD_GATEWAY } from "@/utils/protocol/http.js";
import type {
  AccessControlProvider,
  AuthProvider,
  ForwarderProvider,
  LoggerProvider,
  PluginRegistry,
  RoutingProvider,
} from "@/plugins/contracts.js";

/**
 * 入站适配器公共依赖 - 每实例一份，由组合根注入
 * @description
 * 四个字段刻意**显式列出**而不是塞一个 service locator：入站适配器是唯一需要
 * 「判定所需全部能力」的层，它理应知道这些依赖。
 *
 * **刻意不含 `ConfigProvider`**：出站 TLS 校验策略（`upstreamInsecure` / `upstreamCa`）
 * 已进 `ForwardPlan.upstreamTls`（热加载能力不丢：路由插件每次 `plan()` 现读 scope），
 * 于是入站侧与传输策略两侧都不再需要配置面。
 * @param logger - 本实例日志器（core 零日志，转发器不直接打印，仅随依赖注入备用）
 * @param auth - 鉴权插件（**出站凭证剥离的凭证形态判据**，经 `ForwarderContext.auth` 交给传输策略）
 * @param acl - 访问控制插件（目标名单判定）
 * @param routing - 路由插件（`plan()` 决策直连还是走上游）
 * @param forwarders - 传输策略注册表（按 `plan.transport` 取实现；**入站维度对它是透明的**）
 */
export interface ForwarderDeps {
  readonly logger: LoggerProvider;
  readonly auth: AuthProvider;
  readonly acl: AccessControlProvider;
  readonly routing: RoutingProvider;
  readonly forwarders: PluginRegistry<ForwardTransport, ForwarderProvider>;
}

/**
 * 转发器公共基类（入站侧）：事件槽 + 拒绝收尾 + 上下文装配
 */
export abstract class ForwarderBase {
  /**
   * 事件槽（容错包装：回调异常被吞，不反噬主流程）
   * @description 同时承载入站侧 `PipeEvent` 与传输策略上抛的 `ForwardFact`
   * （后者是本文件的结构化子集），server 层按 `type` 统一分派
   */
  protected readonly emit: (e: PipeEvent) => void;

  /**
   * @param deps - 本实例的四个能力插件 + 传输策略注册表
   * @param sink - 事件汇（server 层注入；守卫事件与管道事件结构兼容，同一槽透传）
   */
  constructor(
    protected readonly deps: ForwarderDeps,
    sink?: PipeEventSink,
  ) {
    // 守卫事件与管道事件结构兼容（type/message/err），server 层按 type 统一分派
    this.emit = createEventEmitter(sink);
  }

  /**
   * 发事件并附带已鉴权用户名
   * @description 身份是**每会话状态**：只能经参数逐次传入，绝不存进本类字段
   * （四个 SOCKS server 共享同一个适配器实例，存字段会让并发会话互相串号）
   * @param e - 待发事件
   * @param user - 已鉴权用户名，无则原样发出
   */
  protected emitWithUser(e: PipeEvent, user?: string): void {
    this.emit(user ? { ...e, user } : e);
  }

  /**
   * 拨号目标（自环守卫的判定对象）：`direct-stream` 即客户端请求的目标，其余取计划里冻结的上游端点
   * @description 与 `guardPreDial` 的 `dial` 语义一致：client 模式拨的是上游，
   * 上游指回自身监听地址会成环（真实目标的自环另由调用点补判，见各入站说明）
   * @param plan - 本次转发计划
   */
  protected dialTarget(plan: ForwardPlan): { host: string; port: number } {
    return plan.transport === "direct-stream" || !plan.upstream
      ? { host: plan.target.host, port: plan.target.port }
      : { host: plan.upstream.host, port: plan.upstream.port };
  }

  /**
   * 取计划里冻结的上游端点；**非 `direct-stream` 却缺 `upstream` 即 fail-closed**
   * @description
   * 契约只保证「`direct-stream` 时必须缺省 upstream」，反方向靠调用点守住。这里选择**显式判缺**而不是
   * `!` 断言或 `as` 强转：路由插件一旦给出残缺计划（装配 bug），若静默按直连处理，
   * 本该走企业上游的流量会**直连出去**——绕过出口策略的泄漏远比断链危险。
   * 故发一条 `upstream-error` 事实并按网关失败（502）收尾。
   *
   * 入站在拨号前用它做**顺序判定**（如 websocket/socks 的上游自环预检需要端点）；
   * 传输策略侧另有 `gateUpstream` 兜底（纵深防御，不依赖单个插件的实现质量）。
   * @param plan - 本次转发计划
   * @param responder - 协议应答器（缺省时只发事实、不写协议应答）
   * @returns 上游端点；直连计划恒为 undefined；经上游但残缺时已收尾并返回 undefined
   */
  protected requireUpstream(
    plan: ForwardPlan,
    responder?: ProtocolResponder,
  ): UpstreamEndpoint | undefined {
    if (plan.transport === "direct-stream") {
      return undefined;
    }

    if (plan.upstream) {
      return plan.upstream;
    }

    this.emit({
      type: "upstream-error",
      message: `[forward] plan transport=${plan.transport} without upstream endpoint`,
      target: `${plan.target.host}:${plan.target.port}`,
    });
    responder?.fail(STATUS_BAD_GATEWAY);
    return undefined;
  }

  /**
   * 拒绝收尾：把状态码交给协议应答器，由它写出**本协议形态**的拒绝报文
   * @description 解析失败（400）、名单拒绝（403）、自环/网关失败（502/504）共用本入口。
   * HTTP 入站写 `ServerResponse`、SOCKS 回 FAIL、tunnel/upgrade 写预拼状态行（`httpReplyFor`）
   * @param responder - 协议应答器
   * @param status - 应答状态码（语义状态码，映射到报文由协议自理）
   */
  protected refuse(responder: ProtocolResponder, status: number): void {
    responder.fail(status);
  }

  /**
   * 装配传输策略的执行上下文（`ForwarderContext`）
   * @description
   * **本类是 `auth` 的唯一注入点**：`sanitizeHeaders` / `isStrippableOutboundHeader` /
   * `buildUpgradeReq` 的出站凭证剥离必须用**入站鉴权同一个判据**（`auth.isOwnCredential`），
   * 漂移就会把代理自己的凭证泄漏给目标站。把它收在这里，各入站不必各写一遍，
   * 也就不可能「某个入站忘了传」。
   *
   * `emit` 直接透传给事件槽：传输策略自己按 `responder.username` 补身份
   * （SOCKS 侧身份只在应答器闭包里，http/tunnel 侧身份已由 server 的逐请求 sink 带上）。
   * @param plan - 本次转发计划
   * @param responder - 协议应答器（入站侧构造，持有本协议的应答形态）
   * @param extras - 本次连接的活对象：客户端双工流 / 入站请求 / 已读首包余量
   * @returns 传输策略的唯一入参
   */
  protected context(
    plan: ForwardPlan,
    responder: ProtocolResponder,
    extras: { client?: Duplex; request?: http.IncomingMessage; head?: Buffer } = {},
  ): ForwarderContext {
    return {
      plan,
      responder,
      ...extras,
      emit: (fact: ForwardFact) => {
        this.emit(fact);
      },
      auth: this.deps.auth,
    };
  }
}
