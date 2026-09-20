import type { Duplex } from "node:stream";
import http from "node:http";
import net from "node:net";
import { get } from "@/config/store.js";
import {
  isSelfLoop,
  parseAuthority,
  buildConnectRequest,
  encodeBasicCredentials,
} from "@/core/proxy-helpers.js";
import {
  buildProxyAuthValue,
  DOUBLE_CRLF_BUF,
  HEADER_NAME_PROXY_AUTHORIZATION,
  HTTP_200_CONNECTION_ESTABLISHED,
  HTTP_502_BAD_GATEWAY,
  HTTP_504_GATEWAY_TIMEOUT,
  MAX_STATUS_LINE_BYTES,
  RE_HTTP_STATUS_LINE,
  STATUS_OK,
} from "@/utils/constants.js";
import type { PipeEventSink } from "@/core/types/proxy.js";
import { Dialer } from "./dial.js";

/**
 * 上游鉴权头：仅当显式配置 upstreamUsername 时携带
 */
function upstreamAuthHeader(): string | undefined {
  const user = get("upstreamUsername");

  if (!user) {
    return undefined;
  }

  return `${HEADER_NAME_PROXY_AUTHORIZATION}: ${buildProxyAuthValue(
    encodeBasicCredentials(user, get("upstreamPassword")),
  )}`;
}

/**
 * 隧道转发器（CONNECT）
 * - server 直连目标
 * - client 按 upstreamProtocol 选 http/https/socks 串联
 */
export class TunnelForwarder {
  private dialer = new Dialer();

  constructor(private sink?: PipeEventSink) {}

  private emit(event: unknown): void {
    try {
      this.sink?.(event as never);
    } catch {}
  }

  /**
   * 入口：解析 authority → 自环防护 → 按模式与上游协议分发
   */
  handle(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const authority = req.url ?? "";
    const parsed = parseAuthority(authority);

    if (!parsed) {
      socket.end(HTTP_502_BAD_GATEWAY);
      return;
    }

    const { hostname, port } = parsed;
    const mode = get("proxyMode");

    if (isSelfLoop(hostname, port)) {
      socket.end(HTTP_502_BAD_GATEWAY);
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

    // sockss* 先 TLS 再同版本握手
    if (proto === "socks4") {
      this.viaSocks(socket, hostname, port, head, 4, false);
      return;
    }

    if (proto === "socks5") {
      this.viaSocks(socket, hostname, port, head, 5, false);
      return;
    }

    if (proto === "sockss4") {
      this.viaSocks(socket, hostname, port, head, 4, true);
      return;
    }

    if (proto === "sockss5") {
      this.viaSocks(socket, hostname, port, head, 5, true);
      return;
    }

    // 未知协议降级 direct：防御兜底保连通，配置错不炸链
    this.direct(socket, hostname, port, head);
  }

  /**
   * 直连：建链成功才回 200，超时/错误由 guard 接管
   */
  private direct(client: Duplex, host: string, port: number, head: Buffer): void {
    const upstream = net.connect(port, host, () => {
      client.write(HTTP_200_CONNECTION_ESTABLISHED);

      if (head.length) {
        upstream.write(head);
      }

      this.dialer.bridge(client, upstream);
    });

    this.guard(client, upstream, `${host}:${port}`);
  }

  /**
   * 经 HTTP/HTTPS 上游发 CONNECT
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

    try {
      const upstream = await this.dialer.choose(client, upstreamHost, upstreamPort, secure, {
        target: `${host}:${port} via ${upstreamHost}:${upstreamPort}`,
      });

      const auth = upstreamAuthHeader();
      upstream.write(buildConnectRequest(host, port, auth));

      this.wait200(client, upstream, head);
    } catch {
      if (!client.destroyed) {
        client.end(HTTP_502_BAD_GATEWAY);
      }
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

    try {
      const upstream = await this.dialer.dialSocks(client, host, port, version, secure, {
        target: `${host}:${port} via socks${version} ` + `${upstreamHost}:${upstreamPort}`,
      });

      client.write(HTTP_200_CONNECTION_ESTABLISHED);

      if (head.length) {
        upstream.write(head);
      }

      this.dialer.bridge(client, upstream);
    } catch {
      if (!client.destroyed) {
        client.end(HTTP_502_BAD_GATEWAY);
      }
    }
  }

  /**
   * 等上游首包：非 200 原样透传不断链，200 才桥接并落定守卫
   * - 200 头之后的 `remain` 是上游先发的字节，方向为 client；`head` 是客户端半包，方向为 upstream
   * - 200 建链后显式 `established()` 清掉守卫定时器，隧道存活再久也不会被误写 504
   */
  private wait200(client: Duplex, upstream: Duplex, head: Buffer): void {
    let buf = Buffer.alloc(0);

    // choose 已 resolve（connect/secureConnect 早已触发），connect 监听器不会再来清定时器，
    // 只能持有句柄，收到 200 后显式 established()
    const guard = this.guard(client, upstream, "upstream");

    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);

      // 上游只发数据不回状态行时按字节封顶：upstreamTimeout 只兜时间不兜内存
      if (buf.length > MAX_STATUS_LINE_BYTES) {
        upstream.off("data", onData);
        client.destroy();
        upstream.destroy();
        return;
      }

      const idx = buf.indexOf(DOUBLE_CRLF_BUF);

      if (idx === -1) {
        return;
      }

      const header = buf.subarray(0, idx).toString();

      // 非 200（如后级 407）：原样回透上游响应（含 Proxy-Authenticate），不断链语义
      // 严格取状态行三位码比对：响应头里出现 "200" 子串（如 realm="200"）不得误判为建链成功
      const statusCode = RE_HTTP_STATUS_LINE.exec(header)?.[1];

      if (statusCode !== String(STATUS_OK)) {
        client.write(buf);
        client.end();
        upstream.destroy();
        return;
      }

      upstream.off("data", onData);

      client.write(HTTP_200_CONNECTION_ESTABLISHED);

      const remain = buf.subarray(idx + DOUBLE_CRLF_BUF.length);

      // remain 属上游发往客户端方向（如服务端先说话的协议首包），回写 client 而非 upstream
      if (remain.length) {
        client.write(remain);
      }

      if (head.length) {
        upstream.write(head);
      }

      // 建链成功：清守卫定时器并落定，之后上游 error 只双关、不再回写 HTTP 报文
      guard.established();

      this.dialer.bridge(client, upstream);
    };

    upstream.on("data", onData);
  }

  /**
   * 建链守卫：返回句柄，成功桥接后须调用 `established()` 落定
   * - settled 前：超时回 504、错误回 502（均归属 upstreamTimeout），并销毁上游
   * - settled 后：仅双向销毁，不再回写 HTTP 报文（对齐 proxy-helpers.guardDialing 的 live 语义）
   * 兼容 net/tls：connect/secureConnect 任一触发即清定时器并落定。
   * direct() 在 connect 前同步注册，两个事件必触发；wait200 在 choose resolve 后注册已错过，
   * 故由 wait200 收到 200 后显式 established()。
   */
  private guard(client: Duplex, upstream: Duplex, target: string): { established: () => void } {
    void target;
    const timeout = get("upstreamTimeout");
    let settled = false;

    const timer = setTimeout(() => {
      if (!client.destroyed) {
        client.end(HTTP_504_GATEWAY_TIMEOUT);
      }

      upstream.destroy();
    }, timeout);

    const established = (): void => {
      settled = true;
      clearTimeout(timer);
    };

    upstream.once("connect", established);

    (
      upstream as unknown as {
        once(e: string, cb: () => void): void;
      }
    ).once("secureConnect", established);

    upstream.once("error", () => {
      clearTimeout(timer);

      if (settled) {
        // 已建链：上游 RST 属隧道态噪声，只做双向销毁，杜绝把 502 文本灌进隧道
        if (!upstream.destroyed) {
          upstream.destroy();
        }

        if (!client.destroyed) {
          client.destroy();
        }

        return;
      }

      if (!client.destroyed) {
        client.end(HTTP_502_BAD_GATEWAY);
      }
    });

    client.once("close", () => {
      clearTimeout(timer);

      if (!upstream.destroyed) {
        upstream.destroy();
      }
    });

    upstream.once("close", () => {
      clearTimeout(timer);

      if (!client.destroyed) {
        client.destroy();
      }
    });

    return { established };
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
