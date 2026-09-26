import type { Duplex } from "node:stream";
import http from "node:http";
import { get } from "@/config/store.js";
import {
  isSocksProto,
  isTlsUpstreamProto,
  parseAuthority,
  resolveRoute,
  socksVersionOf,
} from "@/core/proxy-helpers.js";
import { socksUpstreamGuard } from "@/core/guard.js";
import {
  HTTP_200_CONNECTION_ESTABLISHED,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_OK,
} from "@/utils/protocol/http.js";
import type { PipeEventSink } from "@/core/types/proxy.js";
import { ForwarderBase } from "./base.js";

/**
 * 隧道转发器（CONNECT）
 * - server 直连目标（client 配置命中 upstream 路由名单同样回落直连）
 * - client 按 upstreamProtocol 选 http/https/socks 串联（判据 = resolveRoute 的有效模式）
 * - 拨号器与事件槽（dialer/emit）继承自 {@link ForwarderBase}
 */
export class TunnelForwarder extends ForwarderBase {
  /**
   * 入口：解析 authority（非法回 400） → 自环/名单前置守卫 → 路由判定 → 按有效模式与上游协议分发
   */
  handle(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const authority = req.url ?? "";
    const parsed = parseAuthority(authority);

    if (!parsed) {
      // 客户端 CONNECT 请求行非法（如 ":443"、裸 IPv6）属请求报文错误回 400，
      // 与 http/websocket 的解析失败语义一致（此前误回 502 把客户端错误算成网关错误）
      this.refuse(socket, STATUS_BAD_REQUEST);
      return;
    }

    const { hostname, port } = parsed;
    const target = { host: hostname, port };

    // 自环 + 目标名单在拨号前共用前置守卫：被禁目标直接 403 收尾（不消耗上游拨号资源）
    if (
      this.preDial({
        req,
        dial: target,
        dest: target,
        deny: (status) => this.refuse(socket, status),
      })
    ) {
      return;
    }

    // preDial 已过：client 配置恰发一条路由事件（server 配置在 emitRoute 内短路）
    const route = resolveRoute(target);
    this.emitRoute(target, route);

    // 有效模式：配置 server 或 client 命中路由名单回落 → 直连
    if (route.mode !== "client") {
      this.direct(socket, hostname, port, head);
      return;
    }

    const proto = get("upstreamProtocol");

    if (proto === "http") {
      this.viaHttp(socket, hostname, port, head, false);
      return;
    }

    if (proto === "https") {
      this.viaHttp(socket, hostname, port, head, true);
      return;
    }

    // SOCKS 系（socks4/socks5 与 TLS 承载的 sockss4/sockss5）：版本与 TLS 承载统一由共享映射推导
    if (isSocksProto(proto)) {
      this.viaSocks(socket, hostname, port, head, socksVersionOf(proto), isTlsUpstreamProto(proto));
      return;
    }

    // 未知协议降级 direct：防御兜底保连通，配置错不炸链
    this.direct(socket, hostname, port, head);
  }

  /**
   * 建隧收尾：回 200 Connection Established → 回灌余量 + 双向桥接（协议无关半边见基类 `bridgeWithBuffered`）
   * @description direct / viaHttp / viaSocks 三条成功路径共用（命名对齐 socks.establish）：
   * 两侧余量方向不同——`head` 是客户端发来已读的首包（写给上游），`rest` 是上游先发字节（写给客户端）
   * @param client - 客户端双工流
   * @param upstream - 已建链的上游
   * @param opts.head - 客户端首包（CONNECT 请求行之后的字节），空则不写
   * @param opts.rest - 上游响应头之后的先发字节（server-speaks-first），空则不写
   */
  private establishTunnel(client: Duplex, upstream: Duplex, opts: { head?: Buffer; rest?: Buffer } = {}): void {
    client.write(HTTP_200_CONNECTION_ESTABLISHED);
    this.bridgeWithBuffered(client, upstream, opts.head, opts.rest);
  }

  /**
   * 直连：建链成功才回 200，超时/错误由 dialDirect 的守卫接管成因上抛，失败统一由 catch 收尾
   */
  private direct(client: Duplex, host: string, port: number, head: Buffer): void {
    this.dialer
      .dialDirect(client, host, port, {
        // 守卫不写报文、且保客户端：由下方 catch 统一回 504/502（避免守卫与 catch 双写竞态）
        ...socksUpstreamGuard("tunnel", (e) => this.emit(e)),
        target: `${host}:${port}`,
      })
      .then((upstream) => {
        this.establishTunnel(client, upstream, { head });
      })
      .catch((e: unknown) => {
        this.refuseByCause(client, e);
      });
  }

  /**
   * 经 HTTP/HTTPS 上游发 CONNECT：拨号/报文/等状态行收口在 Dialer.dialViaHttpUpstream，
   * 成败应答在此分流——非 200 原样透传不断链，200 回 200 并桥接，失败回 504（超时）/502
   */
  private async viaHttp(
    client: Duplex,
    host: string,
    port: number,
    head: Buffer,
    secure: boolean,
  ): Promise<void> {
    const upstreamHost = get("upstreamHost");
    const upstreamPort = get("upstreamPort");

    if (this.denyUpstreamLoopAuto(() => this.refuse(client, STATUS_BAD_GATEWAY))) {
      return;
    }

    const target = `${host}:${port} via ${upstreamHost}:${upstreamPort}`;

    try {
      const { sock: upstream, statusCode, head: resHead, rest } =
        await this.dialer.dialViaHttpUpstream(client, host, port, target, {
          secure,
          // 守卫自己不回报文（成败应答在本函数），但成因必须上抛到日志
          onEvent: (e) => this.emit(e),
        });

      // 非 200（如后级 407）：原样回透上游响应（含 Proxy-Authenticate），不断链语义；
      // 状态码已由 readResponseHead 严格提取（响应头里 "200" 子串不会误判为建链成功）
      if (statusCode !== String(STATUS_OK)) {
        client.write(Buffer.concat([resHead, rest]));
        client.end();
        upstream.destroy();
        return;
      }

      // rest 属上游发往客户端方向（如服务端先说话的协议首包），回写 client 而非 upstream
      this.establishTunnel(client, upstream, { head, rest });
    } catch (e) {
      this.refuseByCause(client, e);
    }
  }

  /**
   * 经 SOCKS 上游建隧道：复用 Dialer.dialSocks（版本 + TLS 由调用方指定）
   */
  private async viaSocks(
    client: Duplex,
    host: string,
    port: number,
    head: Buffer,
    version: 4 | 5,
    secure: boolean,
  ): Promise<void> {
    const upstreamHost = get("upstreamHost");
    const upstreamPort = get("upstreamPort");

    if (this.denyUpstreamLoopAuto(() => this.refuse(client, STATUS_BAD_GATEWAY))) {
      return;
    }

    try {
      const upstream = await this.dialer.dialSocks(client, host, port, version, secure, {
        // 失败统一由下方 catch 回 504/502：守卫经 socksUpstreamGuard 收口（不写报文 + 保客户端）
        ...socksUpstreamGuard("tunnel", (e) => this.emit(e)),
        target: `${host}:${port} via socks${version} ` + `${upstreamHost}:${upstreamPort}`,
      });

      this.establishTunnel(client, upstream, { head });
    } catch (e) {
      this.refuseByCause(client, e);
    }
  }
}

/**
 * server → forwarder 的委托入口：每次请求新建 Forwarder 并注入逐请求 sink。
 * 与 forwardHttp/forwardUpgrade 同形，不是为兼容旧路径保留的转发层
 */
export function forwardTunnel(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  sink?: PipeEventSink,
): void {
  new TunnelForwarder(sink).handle(req, socket, head);
}
