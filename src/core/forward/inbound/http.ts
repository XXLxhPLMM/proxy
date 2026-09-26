/**
 * @fileoverview HTTP 入站适配器 - `request` 通道（普通 HTTP 请求）
 * @module core/forward/inbound/http
 * @description
 * 普通 HTTP 请求（`request` 事件）的**协议适配**部分：解析客户端请求目标 → 交给路由插件决策
 * → 前置守卫 → 路由事件 → 按 `plan.transport` 取传输策略执行 → 用 `ServerResponse` 应答。
 *
 * 职责边界（**入站维度**的全部内容都在本文件，传输维度一律不在**）：
 * - 解析目标（absolute-form 走 URL 解析、origin-form 走 Host 头）
 * - 构造 `ProtocolResponder`：**本通道的应答载体是 `ServerResponse`**
 * - 摘出 `auth`（经 `../base.ts:context` 注入）供传输策略做**出站凭证剥离**
 * - 发事实事件（`target-unresolved` / 路由拒绝 / `route`）
 *
 * **本文件不做**（全在 `plugins/forwarders.ts`）：`http.request` / `https.request` 语义转发、
 * Host 回写、出站 TLS 三选项、SOCKS 隧道上的请求分帧、拨号与失败成因分流。
 *
 * 三条不变量：
 * - **零配置读取**：目标、上游、传输方式、超时预算、出站 TLS 策略全在 `ForwardPlan` 里冻结
 * - **状态码不合并**：目标解析失败回 400；名单拒绝 403 与自环 502 由路由插件给出的
 *   `rejection.status` 原样落到应答器（见 `../base.ts:planRoute`）
 * - **应答形态归本类**：其它三条通道是裸 socket / SOCKS 二进制，本条要操作 `ServerResponse`
 *   （`writeHead` + `end`），且**已开始流式响应后绝不能再写错误正文**（协议污染）
 *
 * 分流（由传输策略按 `plan.transport` 决定，本类不判）：
 * - `direct-stream`：直连真实目标，策略先把 absolute-form 归一成 origin-form 并按 RFC 7230 §5.4 重写 Host
 * - `http-upstream`：把请求原样交给上游代理（保留客户端原始 request-target 形态 + 注入上游凭证）
 * - `socks-upstream`：先建 SOCKS 隧道到真实目标，再在隧道上发请求（Host 重写 + 强制 close）
 */

import http from "node:http";
import type { Duplex } from "node:stream";
import { parseTargetParts } from "@/core/proxy-helpers.js";
import type { MeterSource } from "@/core/forward/meter.js";
import { getSocketAddress } from "@/utils/net/socket.js";
import {
  CRLF,
  DOUBLE_CRLF_BUF,
  REASON_BAD_GATEWAY,
  REASON_BAD_REQUEST,
  REASON_FORBIDDEN,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_FORBIDDEN,
} from "@/utils/protocol/http.js";
import type { PipeEventSink } from "@/core/types/proxy.js";
import type { ForwarderDeps } from "../base.js";
import type { ProtocolResponder } from "@/core/types/plan.js";
import { InboundForwarderBase } from "./base.js";

/**
 * failEarly 状态码 → 响应正文：正文由状态码派生，杜绝「400 状态行 + 502 正文」错配。
 * 注意值是纯正文（REASON_*），不是预拼报文（HTTP_*）——res.writeHead 已发状态行，
 * 再 end 整份报文会把状态行重复写进 body。
 * 504 的原因短语 `Gateway Timeout` 在 `utils/protocol/http.ts` 里刻意不导出（无预拼报文用到它），
 * 因此 504 与任何未登记状态码共用缺省正文 `Bad Gateway`——与 `httpReplyFor` 对未知状态码回 502 的保守默认同向。
 */
const EARLY_FAIL_BODY: Record<number, string> = {
  [STATUS_BAD_REQUEST]: REASON_BAD_REQUEST,
  [STATUS_FORBIDDEN]: REASON_FORBIDDEN,
  [STATUS_BAD_GATEWAY]: REASON_BAD_GATEWAY,
};

/**
 * 裸应答首包 → 响应头字典（供 `relayUpstreamResponse` 的首包形态用）
 * @description 只在「自定义传输策略把上游的拒绝响应以裸首包形态交上来」时走到：
 * 内置三条策略的 `http-request` 路径一律交 `incoming`（Node 已解析好的 `IncomingMessage`），
 * 走不到这里。逐行切 `name: value`，跳过首行状态行；缺 `CRLFCRLF` 时按整块解析（容忍半包）。
 * @param head - 上游应答首包（状态行 + 响应头 [+ 已读字节]）
 * @returns 响应头字典（同名头以最后一次出现为准，与 HTTP 语义一致）
 */
function responseHeadersFromHead(head: Buffer | undefined): Record<string, string> {
  const out: Record<string, string> = {};

  if (!head || head.length === 0) {
    return out;
  }

  const end = head.indexOf(DOUBLE_CRLF_BUF);
  const block = head.subarray(0, end === -1 ? head.length : end).toString();
  const lines = block.split(CRLF);

  // 第 0 行是状态行（`HTTP/1.1 407 ...`），不参与头解析
  for (let i = 1; i < lines.length; i += 1) {
    const colon = lines[i].indexOf(":");

    if (colon <= 0) {
      continue;
    }

    out[lines[i].slice(0, colon).trim()] = lines[i].slice(colon + 1).trim();
  }

  return out;
}

/**
 * HTTP 入站适配器
 * - 分支判据一律是 `plan.transport`（路由插件冻结，由传输策略消费），不裸读 `proxyMode` / `upstreamProtocol`
 * - 路由入口、前置守卫与策略分派继承自 {@link InboundForwarderBase}
 */
export class HttpInbound extends InboundForwarderBase {
  /**
   * 入口：解析客户端请求目标 → 路由决策 → 自环/名单前置守卫 → 路由事件 → 按 `plan.transport` 分派
   * @description 任意协议的 client 都可转发到任意上游：http/https 上游走 `http(s).request`，
   * SOCKS 上游走 SOCKS 隧道；client 配置但 upstream 路由名单命中 → 计划即 `direct-stream`（直连）
   * @param clientReq - 入站请求
   * @param clientRes - 入站响应（本适配器的协议应答载体，也是本次会话字节计量的终结挂载点）
   * @param user - 已鉴权用户名（**逐请求参数**；账号级名单与配额的身份输入，无鉴权为 undefined）
   */
  handle(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    user?: string,
  ): void {
    // 客户端请求的目标：absolute-form 走 URL 解析，origin-form 走 Host 头（与模式无关，名单判的也是它）
    const dest = parseTargetParts(clientReq.url ?? "", clientReq.headers.host as string);

    if (!dest) {
      // 目标解析失败 = 客户端请求报文非法，回 400（这是全链路**唯一**回 400 的地方：
      // 名单拒绝 403 与自环 502 由路由插件给出，绝不与之合并）
      this.emit({ type: "target-unresolved", url: clientReq.url });
      this.responder(clientRes, user).fail(STATUS_BAD_REQUEST);
      return;
    }

    const responder = this.responder(clientRes, user);

    const plan = this.planRoute(
      {
        inbound: "http",
        target: dest,
        // 原始 request-target 整串交路由插件：client 串联给上游代理时必须是 absolute-form
        requestPath: clientReq.url ?? "/",
        clientAddress: getSocketAddress(clientReq.socket),
        username: user,
        incoming: clientReq,
      },
      responder,
      { req: clientReq, user },
    );

    if (!plan) {
      return;
    }

    // 自环看有效拨号地址（经上游时即上游端点），名单看客户端请求的目标——
    // 语义与事件/拒绝收尾收敛在基类 preDial（内部走 guardPreDial，见其 JSDoc）
    if (
      this.preDial({
        req: clientReq,
        dial: this.dialTarget(plan),
        dest: plan.target,
        listen: plan.listen,
        responder,
        user,
      })
    ) {
      return;
    }

    // preDial 已过：名单参与判定的请求每请求恰发一条路由事件（server 模式在 emitRoute 内短路）
    this.emitRoute(plan);

    // SOCKS 上游额外补判**真实目标**的自环：入口判的 `dial` 此时是上游端点，
    // 而 SOCKS 隧道直达真实目标（两者是不同值）。名单已在入口判过，此处不重复发事件。
    // 顺序保持原样：先确认上游端点存在（fail-closed），再补判真实目标自环。
    if (plan.transport === "socks-upstream" && plan.upstream) {
      if (
        this.preDial({
          req: clientReq,
          dial: plan.target,
          dest: plan.target,
          listen: plan.listen,
          responder,
          user,
        })
      ) {
        return;
      }
    }

    // 拨号前最后一道闸门：流量配额准入（额度用尽回 429）+ 建本次会话的字节计量桶。
    // 计量挂在 `res` 的 close 上 —— `http-request` 载荷下 `incoming.pipe(res)` 还在流式跑，
    // `forward()` resolve 时字节根本没传完（口径与 keep-alive 不串号的原理见 core/forward/meter.ts）
    const meter = this.admit(responder, {
      user,
      stream: clientRes,
      source: clientReq.socket as unknown as MeterSource,
      target: plan.target,
      req: clientReq,
    });

    if (!meter) {
      return;
    }

    // 传输维度正交于入站维度：唯一起点是 plan.transport（缺失上游端点由传输策略 fail-closed）
    // `client` 传原始 socket：传输策略靠它把「客户端中断」联动到上游请求/隧道
    this.dispatch(plan, responder, {
      request: clientReq,
      client: clientReq.socket as unknown as Duplex,
    });
  }

  /**
   * 协议应答器：把「回什么状态码」映射成 `ServerResponse` 的写法
   * @description
   * - `establish` 是**空实现**：本通道的协议应答就是上游响应本身（`http.request` 回包后
   *   `writeHead(upRes.statusCode)` + `pipe`），不存在「先回个成功再搬数据」的两段式；
   *   隧道/Upgrade/SOCKS 才需要在建链瞬间先写一行成功应答
   * - `fail` 覆盖两类：拨号前拒绝（400/403/502，路由插件给出）与拨号后网关失败（502/504）；
   *   **已开始流式响应时只销毁连接**，绝不把错误正文追加进已发出的 body（协议污染）
   * - `relayUpstreamResponse` 覆盖「上游给了应答」这一类：内置三条策略的 `http-request` 路径
   *   交 `incoming`（`writeHead` + `pipe`，状态码 404/407/500 对客户端都是有效应答，
   *   **绝不可降级成 502**）；裸首包形态只在自定义策略下出现
   * @param res - 入站响应
   * @param user - 已鉴权用户名（供 `RoutingInput` 与传输策略取用；无鉴权为空串）
   */
  private responder(res: http.ServerResponse, user: string | undefined): ProtocolResponder {
    return {
      establish: () => {
        // 本通道无独立成功应答：上游响应即应答（见方法说明）
      },
      fail: (status) => this.failRes(res, status),
      relayUpstreamResponse: (info) => {
        // 已开始流式响应（或已销毁/已结束）时只销毁上游，绝不把上游报文追加进已发出的 body
        if (res.headersSent || res.destroyed || res.writableEnded) {
          info.socket?.destroy();
          return;
        }

        if (info.incoming) {
          res.writeHead(info.incoming.statusCode ?? STATUS_BAD_GATEWAY, info.incoming.headers);
          info.incoming.pipe(res);
          return;
        }

        res.writeHead(info.status, responseHeadersFromHead(info.head));
        res.end();
        info.socket?.destroy();
      },
      // 身份由 server 层逐请求传入（`core/server/http.ts:handleForward` 鉴权之后）：
      // 契约要求非空串，故未鉴权时置空串（不是"假装有身份"）
      username: user ?? "",
    };
  }

  /**
   * 早失败/网关失败回写（协议应答器 `fail` 的落点）
   * @description 拨号前拒绝（400/403/502）与拨号后网关失败（502/504）共用；
   * 响应已开始流式（或已销毁/已结束）时只销毁连接，绝不把错误正文追加进已发出的 body
   * @param res - 入站响应
   * @param status - 状态码（由路由拒绝或拨号成因决定，本类不做任何合并）
   */
  private failRes(res: http.ServerResponse, status: number): void {
    if (res.headersSent || res.destroyed || res.writableEnded) {
      res.destroy();
      return;
    }

    res.writeHead(status);
    res.end(EARLY_FAIL_BODY[status] ?? REASON_BAD_GATEWAY);
  }
}

/**
 * server → 入站适配器的委托入口：每次请求新建适配器并注入逐请求 sink。
 * 与 handleConnect/handleUpgrade 同形，不是为兼容旧路径保留的转发层
 * @param deps - 本实例能力插件 + 传输策略注册表（由协议插件持有并透传）
 * @param req - 入站请求
 * @param res - 入站响应
 * @param sink - 逐请求事件槽（server 层注入）
 */
export function handleHttp(
  deps: ForwarderDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  user: string | undefined,
  sink?: PipeEventSink,
): void {
  new HttpInbound(deps, sink).handle(req, res, user);
}
