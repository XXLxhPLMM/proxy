/**
 * @fileoverview Upgrade（WebSocket）入站适配器 - `upgrade` 通道
 * @module core/forward/inbound/websocket
 * @description
 * `upgrade` 通道的**协议适配**部分：解析目标 → 路由决策 → 自环/名单前置守卫 → 路由事件
 * → 按 `plan.transport` 取传输策略执行 → 用裸 socket 应答。
 *
 * 职责边界：
 * - 解析目标（与 http 通道同用 `parseTargetParts`）
 * - 构造 `ProtocolResponder`：
 *   - `establish({ head })` **原样透传上游 101 响应头**（不自己拼 101——`http.Response` 形态各异）
 *   - `fail` 写预拼状态行（`httpReplyFor` 派生）
 *   - `relayUpstreamResponse` 处理**非 101** 的上游应答：先原样写首包，再按
 *     `upstream.readableEnded` 分流续传剩余 body（见下）
 * - 补判 socks 上游的自环（真实目标的自环已由前置守卫判过；**名单不判上游**）
 * - 摘出 `auth` 供传输策略做**出站凭证剥离**与 Upgrade 报文的 proxy-* 头剔除
 *
 * **本文件不做**（全在 `plugins/forwarders.ts`）：拨号、Upgrade 握手报文的重放
 * （`buildUpgradeReq` 与 absolute-form/origin-form 分流）、等 101、拨号失败成因分流。
 *
 * 两条不变量（红线）：
 * - **报文形态与上游凭证的唯一分流依据是 `plan.transport`**：
 *   `http-upstream` 保留客户端原始 absolute-form request-target 并注入 `Proxy-Authorization`
 *   （上游代理收到 origin-form 的 `GET /ws` 会当成「发给代理自身的请求」而不会转发升级）；
 *   `direct-stream` 与 `socks-upstream` 已直达真实目标，用 origin-form 且**绝不**带上游凭证
 * - **`relayUpstreamResponse` 非 101 必须按 `upstream.readableEnded` 分流**：已 EOF 则 `client.end()`，
 *   否则 `upstream.pipe(client)` 续传剩余 body（`Content-Length` 大于首包时客户端不挂等）；
 *   `'end'` 可能早于续体挂 pipe 前发出，直接 pipe 会漏掉 end 让客户端挂死
 */

import http from "node:http";
import type { Duplex } from "node:stream";
import { httpReplyFor, parseTargetParts } from "@/core/proxy-helpers.js";
import type { MeterSource } from "@/core/forward/meter.js";
import { getSocketAddress } from "@/utils/net/socket.js";
import { STATUS_BAD_GATEWAY, STATUS_BAD_REQUEST } from "@/utils/protocol/http.js";
import type { PipeEventSink } from "@/core/types/proxy.js";
import type { ForwarderDeps } from "../base.js";
import type { ProtocolResponder } from "@/core/types/plan.js";
import { InboundForwarderBase } from "./base.js";

/**
 * Upgrade（WebSocket）入站适配器
 * - 拨号、握手报文重放与 101 等待全在传输策略（`plugins/forwarders.ts`）
 * - 路由入口、前置守卫与策略分派继承自 {@link InboundForwarderBase}
 * - 拒绝收尾统一走协议应答器写原始状态行报文（407/403 同款形态），
 *   不再「名单拒绝写 403、拨号失败静默 destroy」两套语义并存
 */
export class WebSocketInbound extends InboundForwarderBase {
  /**
   * Upgrade 入口：解析目标 → 路由决策 → 前置守卫 → 路由事件 → 按 `plan.transport` 分派
   * @description 此前本通道有一个「client + SOCKS 上游」的早分支，它必须先读 `proxyMode`/`upstreamProtocol`
   * 才能决定分流，理由是「目标尚未解析无法判路由」；现在目标是唯一入口（先解析再决策），
   * 那条早分支连同它自己那次 `resolveRoute` 一并消失
   * @param req 握手请求 @param socket 下游 @param head 已读半包
   * @param user 已鉴权用户名（逐请求参数；账号级名单与配额的身份输入）
   */
  handle(req: http.IncomingMessage, socket: Duplex, head: Buffer, user?: string): void {
    const responder = this.responder(socket, user);
    const real = parseTargetParts(req.url ?? "", req.headers.host as string);

    if (!real) {
      this.refuse(responder, STATUS_BAD_REQUEST);
      return;
    }

    const plan = this.planRoute(
      {
        inbound: "upgrade",
        target: real,
        requestPath: req.url ?? "/",
        clientAddress: getSocketAddress(socket),
        username: user,
        incoming: req,
      },
      responder,
      { req, user },
    );

    if (!plan) {
      return;
    }

    // 自环看有效拨号地址（经上游时即上游端点）、名单看客户端请求的目标，与 http/tunnel/socks 共用同一前置守卫
    if (
      this.preDial({
        req,
        dial: this.dialTarget(plan),
        dest: plan.target,
        listen: plan.listen,
        responder,
        user,
      })
    ) {
      return;
    }

    // preDial 已过：名单参与判定的请求恰发一条路由事件（server 模式在 emitRoute 内短路）
    this.emitRoute(plan);

    if (plan.transport !== "direct-stream") {
      // 缺失上游端点即 fail-closed（绝不静默直连真实目标）
      const upstream = this.requireUpstream(plan, responder);

      if (!upstream) {
        return;
      }

      // socks 上游：额外补判上游自环（真实目标的自环已在上方 preDial 判过；名单不判上游）。
      // http(s) 上游不需要这一步——上游自环已由 preDial 的 `dial` 判过（dial 此时即上游）
      if (
        plan.transport === "socks-upstream" &&
        this.denyUpstreamLoop(upstream.host, upstream.port, plan.listen, () =>
          this.refuse(responder, STATUS_BAD_GATEWAY),
          { req, user },
        )
      ) {
        return;
      }
    }

    // 拨号前最后一道闸门：流量配额准入（额度用尽回 429）+ 建计量桶。
    // 裸流通道的会话边界就是 socket 关闭，故 stream 与 source 是同一个对象
    const meter = this.admit(responder, {
      user,
      stream: socket,
      source: socket as unknown as MeterSource,
      target: plan.target,
      req,
    });

    if (!meter) {
      return;
    }

    this.dispatch(plan, responder, { client: socket, head, request: req });
  }

  /**
   * 协议应答器：裸 socket 上的状态行应答
   * @description `establish` **不自己拼 101**：Upgrade 的成功应答就是上游的 101 响应本身
   * （`http.Response` 形态各异，原样透传才正确），调用方把上游应答头经 `establish({ head })` 交进来；
   * `fail` 写预拼状态行报文（`httpReplyFor` 派生），已销毁则跳过
   * @param socket - 客户端裸双工流
   * @param user - 已鉴权用户名（供 `RoutingInput` 与传输策略取用；无鉴权为空串）
   */
  private responder(socket: Duplex, user: string | undefined): ProtocolResponder {
    return {
      establish: (extra) => {
        if (extra?.head?.length) {
          socket.write(extra.head);
        }
      },
      fail: (status) => {
        if (!socket.destroyed) {
          socket.end(httpReplyFor(status));
        }
      },
      relayUpstreamResponse: (info) => {
        if (!socket.destroyed && info.head?.length) {
          socket.write(info.head);
        }

        // 非 101：响应体可能超出首包（Content-Length 大于已读字节），继续 relay 剩余 body。
        // 必须保留 readableEnded 分支：上游若在同一轮读取里 push 了 EOF（响应 + Connection: close
        // 的常见形态），'end' 可能早于本续体挂 pipe 之前发出，直接 pipe 会漏掉 end → 客户端挂死。
        // 上游错误/关闭的收尾归 guardDialing 既有 handler，这里不额外 destroy
        const upstream = info.socket;

        if (!upstream || socket.destroyed) {
          if (!socket.destroyed) {
            socket.end();
          }
          return;
        }

        if (upstream.readableEnded) {
          socket.end();
        } else {
          upstream.pipe(socket);
        }
      },
      // 身份由 server 层逐请求传入（`core/server/http.ts:handleForward` 鉴权之后）：
      // 契约要求非空串，故未鉴权时置空串（不是"假装有身份"）
      username: user ?? "",
    };
  }
}

/**
 * server → 入站适配器的委托入口：每次请求新建适配器并注入逐请求 sink。
 * 与 handleHttp/handleConnect 同形，不是为兼容旧路径保留的转发层
 * @param deps - 本实例能力插件 + 传输策略注册表（由协议插件持有并透传）
 * @param req - Upgrade 握手请求
 * @param socket - 客户端裸双工流
 * @param head - 已读半包
 * @param user - 已鉴权用户名（逐请求参数；账号级名单与配额的身份输入）
 * @param sink - 逐请求事件槽（server 层注入）
 */
export function handleUpgrade(
  deps: ForwarderDeps,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  user: string | undefined,
  sink?: PipeEventSink,
): void {
  new WebSocketInbound(deps, sink).handle(req, socket, head, user);
}
