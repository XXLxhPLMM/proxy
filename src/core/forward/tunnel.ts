import type { Duplex } from "node:stream";
import http from "node:http";
import { get } from "@/config/store.js";
import {
  isSocksProto,
  isTlsUpstreamProto,
  parseAuthority,
  socksVersionOf,
} from "@/core/proxy-helpers.js";
import { socksUpstreamGuard } from "@/core/guard.js";
import {
  HTTP_200_CONNECTION_ESTABLISHED,
  STATUS_BAD_GATEWAY,
  STATUS_OK,
} from "@/utils/constants.js";
import type { PipeEventSink } from "@/core/types/proxy.js";
import { ForwarderBase } from "./base.js";

/**
 * 隧道转发器（CONNECT）
 * - server 直连目标
 * - client 按 upstreamProtocol 选 http/https/socks 串联
 * - 拨号器与事件槽（dialer/emit）继承自 {@link ForwarderBase}
 */
export class TunnelForwarder extends ForwarderBase {
  /**
   * 入口：解析 authority → 自环/名单前置守卫 → 按模式与上游协议分发
   */
  handle(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const authority = req.url ?? "";
    const parsed = parseAuthority(authority);

    if (!parsed) {
      this.refuse(socket, STATUS_BAD_GATEWAY);
      return;
    }

    const { hostname, port } = parsed;
    const mode = get("proxyMode");
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

    this.emit({
      type: "route",
      target: `${hostname}:${port}`,
      mode,
    });

    if (mode !== "client") {
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
 * 函数式入口（保持与 server/http 兼容）
 */
export function forwardTunnel(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  sink?: PipeEventSink,
): void {
  new TunnelForwarder(sink).handle(req, socket, head);
}
