/**
 * @fileoverview 入站适配器基类 - 路由决策、前置守卫、路由事件、策略分派
 * @module core/forward/inbound/base
 * @description
 * `inbound/{http,tunnel,websocket,socks}.ts` 四个入站协议插件共有的**入站侧编排**收在一处。
 * 与 `../base.ts:ForwarderBase` 的分工：本类是「入站侧编排」，那边是「入站侧胶水」。
 *
 * ```
 *   解析入站报文（本入站自己的事）
 *        ↓
 *   planRoute      ← 路由决策的唯一入口，拒绝时按 rejection.status 原样应答（403/502 绝不合并）
 *        ↓
 *   preDial        ← 拨号前置守卫（自环看 dial、名单看 dest）的接线
 *        ↓
 *   emitRoute      ← 路由事实（过 preDial 每请求恰一条；server 模式短路零条）
 *        ↓
 *   dispatch       ← 按 plan.transport 从注册表取传输策略并 forward(ctx)
 * ```
 *
 * **「传输策略」与「入站协议」是两个正交维度**：本类的 `dispatch` 是二者唯一的接缝，
 * 入站插件对 `ForwardTransport` 的三个实现一无所知，反之传输策略也完全不认识
 * HTTP 报文 / SOCKS 字节序（应答一律经 `ctx.responder`）。于是：
 * - 加一种入站协议 = 实现一个本类的子类（不碰任何传输策略）
 * - 换一种传输方式 = 往注册表加一项（不碰任何入站协议）
 *
 * 两条不可动的红线（逐字保持，破坏任一条都是行为回归）：
 * - **状态码绝不合并**：`rejection.status` 原样交给应答器，名单拒绝恒 403、自环恒 502，
 *   只有「目标解析失败」才回 400
 * - **自环优先于名单**：`preDial` 内 `guardPreDial` 的判定顺序不可调换
 *
 * core 零日志：路由事实经 `emitRoute` 发事件，落盘归 `src/server`。
 */

import { guardPreDial, isSelfLoop, type PreDialOptions } from "@/core/proxy-helpers.js";
import type {
  ForwarderContext,
  ForwardPlan,
  ProtocolResponder,
  RoutingInput,
} from "@/core/types/plan.js";
import type { Duplex } from "node:stream";
import type http from "node:http";
import { STATUS_BAD_GATEWAY } from "@/utils/protocol/http.js";
import { ForwarderBase } from "../base.js";

/**
 * 路由拒绝事件的定位信息（随事件带给日志，与 `guardPreDial` 的既有形态一致）
 * @param user - 已鉴权用户名（SOCKS 每会话身份）
 * @param req - 原始请求（HTTP/CONNECT/Upgrade 通道）
 * @param client - 客户端对端地址（SOCKS 等无 req 的场景）
 */
interface RouteRejectionExtra {
  user?: string;
  req?: unknown;
  client?: string;
}

/**
 * 入站适配器基类
 * @description 只编排，**不拨号、不搬字节**——那是传输策略（`plugins/forwarders.ts`）的活。
 */
export abstract class InboundForwarderBase extends ForwarderBase {
  /**
   * 路由决策：**四个入站共用的唯一入口**，返回计划或 null（已拒绝并完成协议应答）
   * @description
   * 契约收口在 `RoutingProvider.plan()`：输入「已解析的目标 + 原始 request-target」，输出**自包含**的
   * `ForwardPlan` 或带状态码的拒绝。本方法穷尽 `RoutingOutcome` 两条分支：
   * - `ok: true` → 返回计划，调用方据此按 `plan.transport` 分流；
   * - `ok: false` → 发一条 `type = rejection.reason` 的事实事件（`loop-detected` / `target-denied` 等
   *   稳定 grep 契约，与原 `guardPreDial` / `denyUpstreamLoop` 的事件形态逐字一致），
   *   然后 `responder.fail(rejection.status, rejection.detail)`。
   *
   * **状态码绝不合并**：`rejection.status` 原样传给应答器，名单拒绝恒 403、自环恒 502，
   * 只有「目标解析失败」才回 400（解析发生在进本方法之前）。此前 `resolveForwardTargets()` 把两者
   * 一起折叠成 null，调用方只能一刀切 400——本方法是那个信息损失的修复点。
   *
   * 事件字段映射（server 层落盘时按此对齐）：`rejection.reason` 进 `type`（`loop-detected` /
   * `target-denied` 等稳定 grep 契约），`rejection.detail` 进 `detail`（如 target-denied 的名单原因
   * `blacklist`/`whitelist`）。
   * @param input - 路由输入（入站通道、目标、原始 request-target、审计用的客户端地址/用户名/入站请求）
   * @param responder - 协议应答器（拒绝时由它决定报文形态：HTTP 状态行 / SOCKS FAIL / 裸 socket 状态行）
   * @param extra - 拒绝事件附带的定位信息（`req` / `client` / `user`）
   * @returns 计划；已拒绝并应答完毕返回 null，调用方应立即 return
   */
  protected planRoute(
    input: RoutingInput,
    responder: ProtocolResponder,
    extra?: RouteRejectionExtra,
  ): ForwardPlan | null {
    const outcome = this.deps.routing.plan(input);

    if (!outcome.ok) {
      const { reason, status, detail } = outcome.rejection;

      this.emitWithUser(
        {
          type: reason,
          target: `${input.target.host}:${input.target.port}`,
          ...(extra?.req ? { req: extra.req } : {}),
          ...(extra?.client ? { client: extra.client } : {}),
          ...(detail ? { detail } : {}),
        },
        extra?.user,
      );
      responder.fail(status, detail);
      return null;
    }

    return outcome.plan;
  }

  /**
   * 拨号前置守卫接线（自环 → 目标名单）：四个入站共用，事件槽与本会话用户名在此挂好
   * @description 语义与判定顺序见 `proxy-helpers:guardPreDial`：自环看 `dial`（经上游时即上游）、
   * 名单看 `dest`（客户端请求的目标），命中发事件后交协议自理的拒绝收尾。
   * `acl` 由基类从 `deps` 注入、`listen` 由调用方从 `plan.listen` 传入——两者都是**实例事实**，
   * 不再从任何全局读取（此前 `guardPreDial` 内部 `get("host")` / 直读全局 ACL）。
   *
   * 与 {@link planRoute} 是**纵深防御**关系而非重复：路由插件已做同样的判定并在命中时给出状态码，
   * 本守卫再判一次是为了让「拨号前必过自环 + 名单」不依赖任何单个插件的实现质量。
   * @param opts - `guardPreDial` 选项去掉 `emit`/`acl`/`deny`（三者由本类注入），另可带 `listen`/`responder`/`user`
   * @returns true 表示已拒绝，调用方应立即 return
   */
  protected preDial(
    opts: Omit<PreDialOptions, "emit" | "acl" | "deny"> & {
      responder: ProtocolResponder;
      user?: string;
    },
  ): boolean {
    const { responder, user, ...rest } = opts;

    return guardPreDial({
      ...rest,
      acl: this.deps.acl,
      deny: (status) => this.refuse(responder, status),
      emit: (e) => this.emitWithUser(e, user),
    });
  }

  /**
   * 上游端点自环预检：经上游转发时拨的就是上游，上游指回自身监听地址会成环
   * @description 真实目标的自环/名单已由 {@link preDial} 判过；**名单不判上游**（上游只受自环守卫），
   * 故本方法只查自环，不走 `guardPreDial`。监听地址取自 `plan.listen`（本实例的监听事实随计划走），
   * **不再从配置单例读**——同进程多实例时那必然读错实例。
   * @param host - 上游主机（来自 `plan.upstream`）
   * @param port - 上游端口（来自 `plan.upstream`）
   * @param listen - 本实例监听地址（`plan.listen`）
   * @param deny - 拒绝收尾（发完 `loop-detected` 后执行；HTTP 入站写状态行，SOCKS 回失败应答）
   * @param extra - `user` 随事件带用户名（socks 每会话身份）、`req` 随事件带原请求（websocket）
   * @returns true 表示已拒绝（事件已发、`deny` 已执行），调用方应立即 return
   */
  protected denyUpstreamLoop(
    host: string,
    port: number,
    listen: { host: string; port: number },
    deny: () => void,
    extra?: { user?: string; req?: unknown },
  ): boolean {
    if (!isSelfLoop(host, port, listen)) {
      return false;
    }

    this.emitWithUser(
      {
        type: "loop-detected",
        target: `${host}:${port}`,
        ...(extra?.req ? { req: extra.req } : {}),
      },
      extra?.user,
    );

    deny();
    return true;
  }

  /**
   * 路由事件：preDial 通过后、进入传输分支前调用，名单参与判定时每请求恰发一条（拒绝路径到不了这里）
   * @description core 零日志：事实经 `route` 事件上抛，server 层 `bindProxyEventLogs` 落 `[route]` info 行（1:1）；
   * 判定依据是**计划的 `routeReason`**：直连且无回落原因（server 模式短路，零信息量）不发，
   * 其余（经上游、或命中 upstream 路由名单回落直连）发一条
   * @param plan - 本次转发计划
   */
  protected emitRoute(plan: ForwardPlan): void {
    if (plan.transport === "direct-stream" && !plan.routeReason) {
      return;
    }

    this.emit({
      type: "route",
      target: `${plan.target.host}:${plan.target.port}`,
      mode: plan.transport === "direct-stream" ? "server" : "client",
      route: plan.transport === "direct-stream" ? "direct" : "upstream",
      ...(plan.routeReason ? { reason: plan.routeReason } : {}),
    });
  }

  /**
   * 按 `plan.transport` 从注册表取传输策略并执行（入站与传输两个维度的**唯一接缝**）
   * @description
   * `require()` 对未注册键 fail-fast 抛错，那是**装配错误**（配置写了不存在的传输方式），
   * 静默回落直连会让本该走企业上游的流量直连出去。本方法把它就地收敛成
   * 「`upstream-error` 事实 + 502」，与本层其余拒绝路径同形，**不向数据面抛异常**。
   * @param plan - 已批准的转发计划
   * @param responder - 协议应答器（由入站侧构造，持有本协议的应答形态）
   * @param extras - 本次连接的活对象（客户端双工流 / 入站请求 / 已读首包余量）
   */
  protected dispatch(
    plan: ForwardPlan,
    responder: ProtocolResponder,
    extras: { client?: Duplex; request?: http.IncomingMessage; head?: Buffer } = {},
  ): void {
    let ctx: ForwarderContext;

    try {
      ctx = this.context(plan, responder, extras);
      const forwarder = this.deps.forwarders.require(plan.transport);
      void forwarder.forward(ctx);
    } catch (e) {
      this.emit({
        type: "upstream-error",
        message: `[${plan.transport}] transport dispatch failed: ${e instanceof Error ? e.message : String(e)}`,
        err: e,
      });
      responder.fail(STATUS_BAD_GATEWAY);
    }
  }
}
