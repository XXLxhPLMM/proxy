/**
 * @fileoverview 入站准入：两阶段（握手前 / 握手后）+ `RequestScope` 组装的**唯一一处**
 * @module core/server/admission
 * @description
 * 「谁可以进来」这件事此前在两处各做一遍：`server/http.ts:handleForward`（HTTP 三通道共用，
 * 已是���处）与 `server/socks-base.ts:onConn`（SOCKS 自己一套）。两边逐字重复的是
 * 「客户端地址 → connectionId/requestId → 终态守卫 → 名单判定 → `ip-denied` 事件 → 鉴权 →
 * 造 `RequestScope`」这条链，而真正**不该**统一的是应答形态与握手位置：
 *
 * | | 阶段 A（握手前） | 阶段 B（握手后） |
 * |---|---|---|
 * | HTTP | `clientIp` 名单 | 鉴权（Proxy-Authorization） → scope → 派发 |
 * | SOCKS | `clientIp` 名单 | **握手**（greeting / RFC1929 / SOCKS4 目标） → 鉴权 → scope → 派发 |
 *
 * SOCKS 的握手**夹在**阶段 A 与鉴权之间，所以这里刻意**不做**「一函数走完三关」的形状——
 * 那会把「连接内的字节状态机」硬塞进通用流程。本模块因此只提供**两个阶段各自的构件**，
 * 由两条路径按自己的时序调用；SOCKS 的握手仍住在 `socks-session.ts`。
 *
 * **两个构件**：
 * 1. {@link InboundAdmission.admitClientIp} —— 阶段 A。判定与应答**分离**：
 *    判定只回答「准不准」，`pipe: ip-denied` 事件与 `access` 终态由本构件结算，
 *    而**协议应答形态**由调用方以 `respond` 回调给出（HTTP 走 `res.writeHead`、SOCKS 走断流）。
 * 2. {@link InboundAdmission.authenticate} —— 阶段 B 的鉴权半段。凭证侧事实由调用方给
 *    （HTTP 是真的 `Proxy-Authorization` 头、SOCKS 是 RFC1929/SOCKS4 USERID 合成出来的），
 *    关联 id 由本构件注入，`auth` 终态由本构件结算。
 *
 * 加上 {@link InboundAdmission.scopeFor}（阶段 B 的 scope 半段），本模块是
 * `createRequestScope` 在 `src/**` 里的**唯一调用点**——身份维度（注进 `PipeEvent` 载荷与
 * `EventContext`）只在那一处发生一次。
 *
 * 依赖方向：`server/admission → {access-control, request-scope, request-terminal, scope-ids}`，
 * 全部 core 内兄弟模块，无 `@/server/*` 反向依赖。
 */

import type { Duplex } from "node:stream";
import type { CoreContext } from "@/core/context.js";
import { checkClientIp } from "@/core/access-control.js";
import type { EventContext } from "@/core/events/types.js";
import { connectionIdFor } from "@/core/scope-ids.js";
import { createRequestScope } from "@/core/request-scope.js";
import type { RequestScope } from "@/core/request-scope.js";
import { createRequestTerminal } from "@/core/request-terminal.js";
import type { RequestTerminal } from "@/core/request-terminal.js";
import type { AuthContext, AuthResult, ProxyProtocol } from "@/core/types/proxy.js";
import { getSocketAddress } from "@/utils/ip.js";

/**
 * 阶段 A 的判定结果：**只回答「准不准」**，不带任何协议应答
 *
 * @description 判定与应答刻意分离：HTTP 被拒要回 403 状态行、SOCKS 被禁则直接断流
 * （握手尚未开始，无可回报文）。让判定函数去写字节就得给两个分支塞一个 `isSocks` 标志位。
 */
export type ClientIpAdmission = { readonly allowed: true } | { readonly allowed: false };

/** 阶段 A 被拒的判定结果：名单理由（`whitelist` / `blacklist`） */
export type ClientIpDenial = { readonly reason: string };

/**
 * 阶段 B 鉴权的**凭证侧**事实
 *
 * @description 刻意不含 `requestId` / `connectionId`：关联 id 是准入层的关联事实，
 * 由 {@link InboundAdmission.authenticate} 逐次注入（两条路径同源，少一处可能传错的入口）。
 * 剩下的字段全是**协议特有**的——HTTP 给真的 `IncomingMessage` 与 authority，
 * SOCKS 给握手状态机合成的 `{ headers, socket }` 与 `socks5 host:port` 形态的 authority。
 */
export type InboundCredentials = Omit<AuthContext, "requestId" | "connectionId">;

/** {@link createInboundAdmission} 的构造选项 */
export interface InboundAdmissionOptions {
  /** 依赖上下文（事件总线的唯一来源 + 配置访问器），必须显式注入 */
  ctx: CoreContext;
  /** 本次入站所属的代理协议（进事件 context 与鉴权 tag） */
  protocol: ProxyProtocol;
  /**
   * 客户端底层双工流
   *
   * @description **TCP 对端地址与 `connectionId` 都从它取**（`connectionId` 按连接对象缓存复用，
   * keep-alive 下同一 TCP 连接共享）。名单判定只认 TCP 对端，不看可伪造的 XFF。
   */
  socket: Duplex;
  /**
   * 本次请求标识
   *
   * @description HTTP 侧每请求新建（keep-alive 下同一 socket 共享 connectionId、各请求独立
   * requestId）；SOCKS 侧**与 `connectionId` 同值**（一连接一会话一请求，会话即请求）。
   */
  requestId: string;
  /**
   * 逐请求关联上下文，原样进 {@link createRequestScope} 的 `context`
   *
   * @description **它同时决定哪些关联 id 进入 scope 的身份维度**（`createRequestScope` 把
   * `identity` 合并进发布的 context，所以「在 context 里却不算身份」是自相矛盾的形状）。
   * 两条路径的内容**刻意不同**、但形状一致：
   * - HTTP：`{ protocol, client: getClientAddress(req), target?, requestId, connectionId }`
   *   （`client` 是展示/审计口径，与名单判定的 TCP 对端**不是同一个事实**，不合并）
   * - SOCKS：`{ protocol }` —— 历史上 SOCKS 的 pipe 事件只挂 `protocol`、不带 id
   *   （改造前是一条跨会话共享的 sink）。**补 id 就是改事件载荷**，故刻意不补；
   *   需要按 id 串联时读 `terminal.snapshotContext()`。
   */
  scopeContext: Partial<EventContext>;
  /**
   * 鉴权端口（桥接 `BaseProxy.authorize`：转抛 `auth.decided` + 异常转 deny）
   * @description 收**完整** `AuthContext`（含 `requestId`/`connectionId`）——那两个 id 由本模块注入，
   * 调用方给的 {@link InboundCredentials} 里没有它们。由 `BaseProxy` 的 protected 方法闭包桥接，
   * 故本模块不必继承 `ContextualBase`。
   */
  authorize(context: AuthContext): Promise<AuthResult>;
}

/**
 * 一次入站请求/连接的准入：阶段 A + 阶段 B
 *
 * @description 只装**跨请求恒定之外**的东西——没有 `user`（逐次传给 `scopeFor`），
 * 也没有任何协议应答形态（由调用方的 `respond` 回调给出）。
 */
export interface InboundAdmission {
  /** TCP 对端地址：客户端名单判定与 `ip-denied` 的 `client` 恒为它（只认 TCP 对端） */
  readonly client: string;
  /** 连接标识（keep-alive 下同一 TCP 连接共享；SOCKS 与 requestId 同值） */
  readonly connectionId: string;
  /** 请求标识 */
  readonly requestId: string;
  /** 本次请求的终态守卫：阶段 A / 阶段 B 任一关拒绝时由本对象结算 */
  readonly terminal: RequestTerminal;

  /**
   * 阶段 A：客户端名单判定（**握手之前**）
   *
   * @description 被拒时**本方法已**发完 `pipe: ip-denied` 事件并结算 `access` 终态；
   * 协议应答由 `respond` 在这两步**之间**执行（顺序是契约，见 {@link ClientIpAdmission}）。
   * @param rejectedStatus - 拒绝时记进终态的 HTTP 状态码；**SOCKS 无状态码协议传 `undefined`**
   *   （它的应答是 8 字节二进制，没有可记的状态码——不是「忘了传」）
   * @param respond - 被拒时由**本路径**按自己的协议形态写应答
   * @returns `true` = 放行，可继续阶段 B
   */
  admitClientIp(rejectedStatus: number | undefined, respond: (denial: ClientIpDenial) => void): boolean;

  /**
   * 阶段 B 第一半：鉴权
   *
   * @description 关联 id 由本对象注入。不通过时**本方法已**调 `respond` 并结算
   * `auth` 终态（`"proxy-auth-required"`），调用方只需 `if (!auth.passed) return`。
   * 握手解析失败那类**不是凭证判定**的拒绝（非法 SOCKS4 报文、非法 RFC1929 帧）
   * 仍归 `socks-session.ts` 的状态机，不经本方法。
   * @param credentials - 凭证侧事实（协议特有）
   * @param rejectedStatus - 同 {@link admitClientIp}：拒绝时记进终态的状态码
   * @param respond - 被拒时由**本路径**按自己的协议形态写应答
   * @returns 鉴权结果；`passed === false` 表示已就地回绝并结算终态
   */
  authenticate(
    credentials: InboundCredentials,
    rejectedStatus: number | undefined,
    respond: () => void,
  ): Promise<AuthResult>;

  /**
   * 阶段 B 第二半：请求作用域组装（**全仓唯一的 `createRequestScope` 调用点**）
   *
   * @description 逐会话/逐请求现造，绝不缓存：转发器是构造期建一次、跨请求复用的单例，
   * 把 `user` 挂上去就是串号雷。`user` 逐次传入（握手解析阶段还没有身份 → 省略）。
   * @param user - 已鉴权用户名；省略即不带（**不写 `undefined` 键**）
   */
  scopeFor(user?: string): RequestScope;
}

/**
 * 造一次入站准入：客户端地址 / 关联 id / 终态守卫三者一次性建好，两个阶段方法随之绑定
 *
 * @description `terminal` 的初始关联上下文只有 `{ client, connectionId, requestId, target? }`：
 * `client` **恒为 TCP 对端**（两条路径一致，名单判定与 `ip-denied` 用的就是它），
 * `target` 取自 `scopeContext.target`——HTTP 侧准入入口已能从 `getAuthority(req)` 读到，
 * SOCKS 侧此刻还不知道目标（握手后才解析出来，由会话处理器 `setContext` 补，故那里不带）。
 * 终态**不含** `scopeContext.client`：那是展示/审计口径（XFF → X-Real-IP → Forwarded → socket），
 * 与名单判定认的 TCP 对端**不是同一个事实**，两者刻意不合并。
 */
export function createInboundAdmission(options: InboundAdmissionOptions): InboundAdmission {
  const { ctx, protocol, socket, requestId, scopeContext, authorize } = options;
  const client = getSocketAddress(socket);
  const connectionId = connectionIdFor(socket);
  const terminal = createRequestTerminal(ctx.config, protocol, {
    client,
    connectionId,
    requestId,
    ...(scopeContext.target !== undefined ? { target: scopeContext.target } : {}),
  });

  return {
    client,
    connectionId,
    requestId,
    terminal,
    admitClientIp(rejectedStatus, respond) {
      // 客户端名单最先判定：被禁来源不该消耗鉴权与转发资源
      const ip = checkClientIp(client, ctx.config);

      if (ip.allowed) {
        return true;
      }

      ctx.events.publish(
        "pipe",
        { type: "ip-denied", client, reason: ip.reason, protocol },
        { protocol, client, requestId, connectionId },
      );
      respond({ reason: ip.reason ?? "client-denied" });
      terminal.reject(ip.reason ?? "client-denied", "access", rejectedStatus);
      return false;
    },
    async authenticate(credentials, rejectedStatus, respond) {
      const result = await authorize({ ...credentials, requestId, connectionId });

      if (!result.passed) {
        respond();
        terminal.reject("proxy-auth-required", "auth", rejectedStatus);
      }

      return result;
    },
    scopeFor(user) {
      return createRequestScope({ ctx, terminal, context: scopeContext, user });
    },
  };
}
