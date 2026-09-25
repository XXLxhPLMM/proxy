/**
 * @fileoverview 转发器公共基类
 * @module core/forward/base
 * @description
 * 四个转发器（http/tunnel/websocket/socks）共享的拨号器、事件槽与重复胶水收敛到一处：
 * - `dialer`：共享 `Dialer` 实例（无状态，按请求拨号/桥接）
 * - `emit`：同时承载本层 `PipeEvent`（route/upstream-*）与拨号守卫的 `HelperEvent`（onEvent 透传），
 *   server 层按 `type` 统一分派
 * - `emitWithUser`：附带已鉴权用户名发事件（socks 的每会话身份经参数逐次传入）
 * - `preDial`：拨号前置守卫（自环 + 目标名单）接线——自动挂本类事件槽，`user` 置位时经 `emitWithUser` 带上
 * - `emitRoute`：client 模式路由事件（`route` → server 层落 `[route]` info 行）——preDial 通过后的路由分支处每请求恰发一条，server 模式短路不发
 * - `denyUpstreamLoop`：上游地址自环预检（client 模式下拨的是上游，三处逐字重复的预检收口于此）
 * - `refuse` / `refuseByCause`：裸 socket 状态行拒绝收尾（tunnel/websocket 共用），
 *   后者按拨号成因分流 `DialTimeoutError` → 504、其余 → 502
 * - `bridgeWithBuffered`：建隧收尾的**协议无关半边**——回灌两侧余量（toUpstream/toClient）后 `dialer.bridge`，
 *   tunnel 与 socks 共用（各自把 HTTP 200 / SOCKS 二进制 replySuccess 留在调用方）
 *
 * 设计要点：
 * - 事件统一为 `PipeEvent`：守卫 `HelperEvent`（type/message/err）结构兼容，
 *   同一事件槽透传，server 层按 `type` 统一分派
 * - 依赖方向：`base → guard/dial/proxy-helpers/constants/types` 单向，四个转发器只 `extends` 本类、不再各写一份字段与构造器
 *   （core 零日志禁区：只抛不记，路由经 `emitRoute` 发事件、落盘归 `src/server` 的 `bindProxyEventLogs`，收在本类保证四条路径一致）
 * - **刻意不收的**：各协议的应答形态（HTTP `ServerResponse` 早失败、SOCKS 二进制失败/成功应答、
 *   tunnel 回 200、websocket 等 101）——协议语义本质不同，强行模板化只会得到参数爆炸的假抽象；
 *   建隧收尾里协议无关的「回灌余量 + 桥接」已由 `bridgeWithBuffered` 收口
 */

import type { Duplex } from "node:stream";
import { globalConfigAccessor, type ConfigAccessor } from "@/core/config-access.js";
import { createEventEmitter } from "@/core/guard.js";
import {
  guardPreDial,
  httpReplyFor,
  isSelfLoop,
  type PreDialOptions,
  type RouteDecision,
} from "@/core/proxy-helpers.js";
import type { PipeEvent, PipeEventSink } from "@/core/types/proxy.js";
import { STATUS_BAD_GATEWAY, STATUS_GATEWAY_TIMEOUT } from "@/utils/constants.js";
import { Dialer, DialTimeoutError } from "./dial.js";

/**
 * 转发器公共基类（事件统一为 `PipeEvent`）
 */
export abstract class ForwarderBase {
  /** 共享拨号器（稳态无状态，可跨连接复用）；构造期注入与本类同一个访问器 */
  protected readonly dialer: Dialer;

  /** 事件槽（容错包装：回调异常被吞，不反噬主流程） */
  protected readonly emit: (e: PipeEvent) => void;

  /**
   * 配置访问器：四个转发器读上游地址/协议/凭证/超时的**唯一**通道
   * @description 缺省 `globalConfigAccessor`（读全局单例，行为与改造前逐字一致）；
   * 库模式多实例时由 `BaseProxy` 把 `ProxyOptions.config` 透传进来，各实例配置互不串号。
   */
  protected readonly config: ConfigAccessor;

  /**
   * @param sink - 事件汇（server 层注入；守卫事件与管道事件结构兼容，同一槽透传）
   * @param config - 配置访问器；缺省 `globalConfigAccessor`（读全局单例），
   *   同时透传给本类持有的 `Dialer`，保证转发器与拨号器读同一份配置
   */
  constructor(sink?: PipeEventSink, config: ConfigAccessor = globalConfigAccessor) {
    // 守卫事件与管道事件结构兼容（type/message/err），server 层按 type 统一分派
    this.emit = createEventEmitter(sink);
    this.config = config;
    this.dialer = new Dialer(config);
  }

  /**
   * 发事件并附带已鉴权用户名
   * @description 身份是**每会话状态**：只能经参数逐次传入，绝不存进本类字段
   * （四个 SOCKS server 共享同一个转发器实例，存字段会让并发会话互相串号）
   * @param e - 待发事件
   * @param user - 已鉴权用户名，无则原样发出
   */
  protected emitWithUser(e: PipeEvent, user?: string): void {
    this.emit(user ? { ...e, user } : e);
  }

  /**
   * 拨号前置守卫接线（自环 → 目标名单）：四个转发器共用，事件槽与本会话用户名在此挂好
   * @description 语义与判定顺序见 `proxy-helpers:guardPreDial`：自环看 `dial`（client 模式即上游）、
   * 名单看 `dest`（客户端请求的目标），命中发事件后以状态码调 `deny` 收尾——报文形态由协议自理
   * @param opts - `guardPreDial` 选项去掉 `emit`（由本类注入），另可带 `user` 随事件交予日志
   * @returns true 表示已拒绝，调用方应立即 return
   */
  protected preDial(opts: Omit<PreDialOptions, "emit"> & { user?: string }): boolean {
    const { user, ...rest } = opts;

    return guardPreDial({
      ...rest,
      // 本转发器持有的访问器兜底：调用方未显式给 config 时也按实例配置判自环/名单
      config: rest.config ?? this.config,
      emit: (e) => this.emitWithUser(e, user),
    });
  }

  /**
   * 上游地址自环预检：client 模式下拨的是上游，上游指回自身监听地址会成环
   * @description 真实目标的自环/名单已由 {@link preDial} 判过；**名单不判上游**（上游只受自环守卫），
   * 故本方法只查自环，不走 `guardPreDial`
   * @param host - 上游主机
   * @param port - 上游端口
   * @param deny - 拒绝收尾（发完 `loop-detected` 后执行；HTTP 调用方写状态行，SOCKS 回失败应答）
   * @param extra - `user` 随事件带用户名（socks 每会话身份）、`req` 随事件带原请求（websocket）
   * @returns true 表示已拒绝（事件已发、`deny` 已执行），调用方应立即 return
   */
  protected denyUpstreamLoop(
    host: string,
    port: number,
    deny: () => void,
    extra?: { user?: string; req?: unknown },
  ): boolean {
    if (!isSelfLoop(host, port, this.config)) {
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
   * 上游地址自环预检（自动读 `UPSTREAM_HOST`/`UPSTREAM_PORT`）：client 模式下拨的是上游，
   * 上游指回自身监听地址会成环；tunnel 两处（viaHttp/viaSocks）与 websocket 一处（viaSocks）共用
   * @description `denyUpstreamLoop` 的调用点收口——此前三处逐字重复「读配置 → 调 denyUpstreamLoop」；
   * 真实目标的自环/名单仍由 {@link preDial} 判，本方法只查上游自环
   * @param deny - 拒绝收尾（发完 `loop-detected` 后执行）
   * @param extra - `user` 随事件带用户名、`req` 随事件带原请求（websocket）
   * @returns true 表示已拒绝，调用方应立即 return
   */
  protected denyUpstreamLoopAuto(
    deny: () => void,
    extra?: { user?: string; req?: unknown },
  ): boolean {
    return this.denyUpstreamLoop(
      this.config.get("upstreamHost"),
      this.config.get("upstreamPort"),
      deny,
      extra,
    );
  }

  /**
   * client 模式路由事件：preDial 通过后的路由分支处调用，名单参与判定时每请求恰发一条（拒绝路径到不了这里）
   * @description core 零日志：事实经 `route` 事件上抛，server 层 `bindProxyEventLogs` 落 `[route]` info 行（1:1）；
   * server 模式短路不发——该判定恒为 `{mode:"server", route:"direct"}` 且未查 upstream 组（零信息量），
   * 而 client 命中回落必带 reason（`acl:checkUpstreamRoute` 两个 direct 分支都返回 reason），据此区分
   * @param dest - 客户端请求的目标（名单判定对象，事件 target 按它拼）
   * @param decision - `resolveRoute` 的判定结果
   */
  protected emitRoute(dest: { host: string; port: number }, decision: RouteDecision): void {
    if (decision.mode === "server" && !decision.reason) {
      return;
    }

    this.emit({
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
    this.refuse(socket, e instanceof DialTimeoutError ? STATUS_GATEWAY_TIMEOUT : STATUS_BAD_GATEWAY);
  }

  /**
   * 建隧收尾的协议无关半边：回灌两侧余量后双向桥接（**不写任何协议应答**）
   * @description tunnel 的 `establishTunnel` 与 socks 的 `establish` 共用——两者除协议应答
   * （HTTP 200 / SOCKS 二进制 replySuccess，留在各自调用方）外完全对称；
   * 两个方向写的是不同 socket，跨流先后无可观测差异
   * @param client - 客户端双工流
   * @param upstream - 已建链的上游
   * @param toUpstream - 写给上游的余量（如客户端 CONNECT/SOCKS 请求后的首包），空则不写
   * @param toClient - 写给客户端的余量（如上游响应头之后的先发字节），空则不写
   */
  protected bridgeWithBuffered(client: Duplex, upstream: Duplex, toUpstream?: Buffer, toClient?: Buffer): void {
    if (toUpstream?.length) {
      upstream.write(toUpstream);
    }

    if (toClient?.length) {
      client.write(toClient);
    }

    this.dialer.bridge(client, upstream);
  }
}
