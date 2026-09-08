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
  HTTP_200_CONNECTION_ESTABLISHED,
  HTTP_502_BAD_GATEWAY,
  HTTP_504_GATEWAY_TIMEOUT,
} from "@/utils/constants.js";
import type { PipeEventSink } from "@/core/types/proxy.js";
import { Dialer } from "./dial.js";

/**
 * 上游鉴权头：仅当显式配置 upstreamUsername 时携带
 */
function upstreamAuthHeader(): string | undefined
{
  const user = get("upstreamUsername");

  if (!user)
  {
    return undefined;
  }

  return `${"Proxy-Authorization"}: ${buildProxyAuthValue(
    encodeBasicCredentials(
      user,
      get("upstreamPassword"),
    ),
  )}`;
}

/**
 * 隧道转发器（CONNECT）
 * - server 直连目标
 * - client 按 upstreamProtocol 选 http/https/socks 串联
 */
export class TunnelForwarder
{
  private dialer = new Dialer();

  constructor(private sink?: PipeEventSink)
  {
  }

  private emit(event: unknown): void
  {
    try
    {
      this.sink?.(event as never);
    }
    catch
    {
    }
  }

  /**
   * 入口：解析 authority → 自环防护 → 按模式与上游协议分发
   */
  handle(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void
  {
    const authority = req.url ?? "";
    const parsed = parseAuthority(authority);

    if (!parsed)
    {
      socket.end(HTTP_502_BAD_GATEWAY);
      return;
    }

    const { hostname, port } = parsed;
    const mode = get("proxyMode");

    if (isSelfLoop(hostname, port))
    {
      socket.end(HTTP_502_BAD_GATEWAY);
      return;
    }

    this.emit({
      type: "route",
      target: `${hostname}:${port}`,
      mode,
    });

    // server 直连
    if (mode !== "client")
    {
      this.direct(socket, hostname, port, head);
      return;
    }

    // client 串联：按上游协议选载体
    const proto = get("upstreamProtocol");

    if (proto === "http")
    {
      this.viaHttp(socket, hostname, port, head, false);
      return;
    }

    if (proto === "https")
    {
      this.viaHttp(socket, hostname, port, head, true);
      return;
    }

    // SOCKS 上游：v4/v5 握手差异大，sockss* = TLS + 同版本握手
    if (proto === "socks4")
    {
      this.viaSocks(socket, hostname, port, head, 4, false);
      return;
    }

    if (proto === "socks5")
    {
      this.viaSocks(socket, hostname, port, head, 5, false);
      return;
    }

    if (proto === "sockss4")
    {
      this.viaSocks(socket, hostname, port, head, 4, true);
      return;
    }

    if (proto === "sockss5")
    {
      this.viaSocks(socket, hostname, port, head, 5, true);
      return;
    }

    this.direct(socket, hostname, port, head);
  }

  /**
   * 直连目标
   */
  private direct(
    client: Duplex,
    host: string,
    port: number,
    head: Buffer,
  ): void
  {
    const upstream = net.connect(port, host, () =>
    {
      client.write(HTTP_200_CONNECTION_ESTABLISHED);

      if (head.length)
      {
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
  ): Promise<void>
  {
    const upstreamHost = get("upstreamHost");
    const upstreamPort = get("upstreamPort");

    try
    {
      const upstream = await this.dialer.choose(
        client,
        upstreamHost,
        upstreamPort,
        secure,
        {
          target:
            `${host}:${port} via ${upstreamHost}:${upstreamPort}`,
        },
      );

      const auth = upstreamAuthHeader();
      upstream.write(
        buildConnectRequest(host, port, auth),
      );

      this.wait200(client, upstream, head);
    }
    catch
    {
      if (!client.destroyed)
      {
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
  ): Promise<void>
  {
    const upstreamHost = get("upstreamHost");
    const upstreamPort = get("upstreamPort");

    try
    {
      const upstream = await this.dialer.dialSocks(
        client,
        host,
        port,
        version,
        secure,
        {
          target:
            `${host}:${port} via socks${version} `
            + `${upstreamHost}:${upstreamPort}`,
        },
      );

      client.write(
        HTTP_200_CONNECTION_ESTABLISHED,
      );

      if (head.length)
      {
        upstream.write(head);
      }

      this.dialer.bridge(client, upstream);
    }
    catch
    {
      if (!client.destroyed)
      {
        client.end(HTTP_502_BAD_GATEWAY);
      }
    }
  }

  /**
   * 等上游 200：成功则桥接，失败回 502
   */
  private wait200(
    client: Duplex,
    upstream: Duplex,
    head: Buffer,
  ): void
  {
    let buf = Buffer.alloc(0);

    const onData = (chunk: Buffer): void =>
    {
      buf = Buffer.concat([buf, chunk]);

      const idx = buf.indexOf(DOUBLE_CRLF_BUF);

      if (idx === -1)
      {
        return;
      }

      const header = buf.subarray(0, idx).toString();

      // 非 200（如后级 407）：原样回透上游响应（含 Proxy-Authenticate），不断链语义
      if (!header.includes("200"))
      {
        client.write(buf);
        client.end();
        upstream.destroy();
        return;
      }

      upstream.off("data", onData);

      client.write(HTTP_200_CONNECTION_ESTABLISHED);

      const remain = buf.subarray(
        idx + DOUBLE_CRLF_BUF.length,
      );

      if (remain.length)
      {
        upstream.write(remain);
      }

      if (head.length)
      {
        upstream.write(head);
      }

      this.dialer.bridge(client, upstream);
    };

    upstream.on("data", onData);
    this.guard(client, upstream, "upstream");
  }

  /**
   * 建链守卫：超时/错误兜底
   */
  private guard(
    client: Duplex,
    upstream: Duplex,
    target: string,
  ): void
  {
    const timeout = get("upstreamTimeout");

    const timer = setTimeout(() =>
    {
      if (!client.destroyed)
      {
        client.end(HTTP_504_GATEWAY_TIMEOUT);
      }

      upstream.destroy();
    }, timeout);

    upstream.once("connect", () =>
    {
      clearTimeout(timer);
    });

    (
      upstream as unknown as {
        once(e: string, cb: () => void): void;
      }
    ).once("secureConnect", () =>
    {
      clearTimeout(timer);
    });

    upstream.once("error", () =>
    {
      clearTimeout(timer);

      if (!client.destroyed)
      {
        client.end(HTTP_502_BAD_GATEWAY);
      }
    });

    client.once("close", () =>
    {
      clearTimeout(timer);

      if (!upstream.destroyed)
      {
        upstream.destroy();
      }
    });

    upstream.once("close", () =>
    {
      clearTimeout(timer);

      if (!client.destroyed)
      {
        client.destroy();
      }
    });
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
): void
{
  new TunnelForwarder(sink).handle(
    req,
    socket,
    head,
  );
}
