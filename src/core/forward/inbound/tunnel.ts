/**
 * @fileoverview CONNECT 隧道入站适配器 - `connect` 通道
 * @module core/forward/inbound/tunnel
 * @description
 * `CONNECT` 通道的**协议适配**部分：解析 authority → 路由决策 → 自环/名单前置守卫
 * → 路由事件 → 按 `plan.transport` 取传输策略执行 → 用裸 socket 写状态行应答。
 *
 * 职责边界：
 * - 解析 authority（`":443"`、裸 IPv6 一律判非法）
 * - 构造 `ProtocolResponder`：`establish` 写固定 200 行、`fail` 写预拼状态行
 *   （`httpReplyFor` 派生）、`relayUpstreamResponse` 把上游非 200 响应**原样写回客户端**（不断链）
 * - 摘出 `auth` 供传输策略做**出站凭证剥离**
 * - 发事实事件
 *
 * **本文件不做**（全在 `plugins/forwarders.ts`）：拨号、CONNECT 报文、上游状态行等待、
 * 拨号失败成因分流、余量回灌与桥接。
 *
 * - 解析失败（`":443"`、裸 IPv6）回 **400**（客户端请求报文非法，与 http/upgrade 解析失败语义一致）；
 *   502 只留给网关侧失败
 * - 上游自环在上游分支内判（真实目标的自环已由前置守卫判过；**名单不判上游**）
 * - 成功应答只有一行 `HTTP/1.1 200 Connection Established`，由协议应答器发出
 */

import http from "node:http";
import type { Duplex } from "node:stream";
import { httpReplyFor, parseAuthority } from "@/core/proxy-helpers.js";
import { getSocketAddress } from "@/utils/net/socket.js";
import { HTTP_200_CONNECTION_ESTABLISHED, STATUS_BAD_REQUEST } from "@/utils/protocol/http.js";
import type { PipeEventSink } from "@/core/types/proxy.js";
import type { ForwarderDeps } from "../base.js";
import type { ProtocolResponder } from "@/core/types/plan.js";
import { InboundForwarderBase } from "./base.js";

/**
 * CONNECT 入站适配器
 * - 分支判据一律是 `plan.transport`（路由插件冻结，由传输策略消费），不裸读 `proxyMode` / `upstreamProtocol`
 * - 路由入口、前置守卫与策略分派继承自 {@link InboundForwarderBase}
 */
export class TunnelInbound extends InboundForwarderBase {
  /**
   * 入口：解析 authority（非法回 400） → 路由决策 → 自环/名单前置守卫 → 路由事件 → 按 `plan.transport` 分派
   * @param req - CONNECT 请求（`req.url` 即 authority）
   * @param socket - 已从 http.Server 连接表摘出的裸双工流（应答与桥接都在它上面）
   * @param head - CONNECT 请求行之后已读到的首包余量（传输策略建隧后回灌给上游）
   */
  handle(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const responder = this.responder(socket);
    const parsed = parseAuthority(req.url ?? "");

    if (!parsed) {
      // 客户端 CONNECT 请求行非法（如 ":443"、裸 IPv6）属请求报文错误回 400，
      // 与 http/websocket 的解析失败语义一致（此前误回 502 把客户端错误算成网关错误）
      this.refuse(responder, STATUS_BAD_REQUEST);
      return;
    }

    const plan = this.planRoute(
      {
        inbound: "connect",
        // CONNECT 通道没有请求路径：隧道内是裸字节流
        target: { host: parsed.hostname, port: parsed.port, path: "" },
        requestPath: req.url ?? "",
        clientAddress: getSocketAddress(socket),
        username: responder.username,
        incoming: req,
      },
      responder,
      { req },
    );

    if (!plan) {
      return;
    }

    // 自环 + 目标名单在拨号前共用前置守卫：被禁目标直接按状态码收尾（不消耗上游拨号资源）
    if (
      this.preDial({
        req,
        dial: this.dialTarget(plan),
        dest: plan.target,
        listen: plan.listen,
        responder,
      })
    ) {
      return;
    }

    // preDial 已过：名单参与判定的请求恰发一条路由事件（server 模式在 emitRoute 内短路）
    this.emitRoute(plan);

    this.dispatch(plan, responder, { client: socket, head });
  }

  /**
   * 协议应答器：裸 socket 上的状态行应答（CONNECT 通道无 `ServerResponse`）
   * @description
   * - `establish` 写固定的 `200 Connection Established`
   * - `fail` 写预拼状态行报文（`httpReplyFor` 派生，400/403/502/504 各自映射），已销毁则跳过
   * - `relayUpstreamResponse` 把上游的**非 200** 应答（典型是后级 `407 Proxy-Authenticate`，
   *   客户端要靠它重新鉴权）**原样回透后收尾**，不断链、不降级成 502；
   *   未实现该钩子的入站（见 SOCKS）由传输策略回退到预拼状态行
   * @param socket - 客户端裸双工流
   */
  private responder(socket: Duplex): ProtocolResponder {
    return {
      establish: () => {
        socket.write(HTTP_200_CONNECTION_ESTABLISHED);
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

        if (!socket.destroyed) {
          socket.end();
        }

        info.socket?.destroy();
      },
      // 身份由 server 层逐请求的 sink 闭包携带，适配器构造期无从得知（契约要求非空串）
      username: "",
    };
  }
}

/**
 * server → 入站适配器的委托入口：每次请求新建适配器并注入逐请求 sink。
 * 与 handleHttp/handleUpgrade 同形，不是为兼容旧路径保留的转发层
 * @param deps - 本实例能力插件 + 传输策略注册表（由协议插件持有并透传）
 * @param req - CONNECT 请求
 * @param socket - 客户端裸双工流
 * @param head - 已读首包余量
 * @param sink - 逐请求事件槽（server 层注入）
 */
export function handleConnect(
  deps: ForwarderDeps,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  sink?: PipeEventSink,
): void {
  new TunnelInbound(deps, sink).handle(req, socket, head);
}
