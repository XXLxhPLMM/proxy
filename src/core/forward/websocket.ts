import http from "node:http";
import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import {
  isSelfLoop,
  parseTargetParts,
} from "@/core/proxy-helpers.js";
import {
  CRLF,
  DOUBLE_CRLF,
  DOUBLE_CRLF_BUF,
  STATUS_SWITCHING_PROTOCOLS,
} from "@/utils/constants.js";
import type { PipeEventSink } from "@/core/types/proxy.js";
import { Dialer } from "./dial.js";

/**
 * 构建 Upgrade 请求（剔除 proxy-* 头，重写 Host）
 */
function buildUpgradeReq(
  req: http.IncomingMessage,
  host: string,
  port: number,
  path: string,
): string
{
  const requestLine =
    `${req.method} ${path} HTTP/${req.httpVersion}${CRLF}`;

  const headerLines: string[] = [];

  const raw = req.rawHeaders ?? [];

  for (let i = 0; i + 1 < raw.length; i += 2)
  {
    const name = raw[i];
    const value = raw[i + 1];

    // 过滤代理头
    if (name.toLowerCase().startsWith("proxy-"))
    {
      continue;
    }

    if (name.toLowerCase() === "host")
    {
      headerLines.push(`Host: ${host}:${port}`);
    }
    else
    {
      headerLines.push(`${name}: ${value}`);
    }
  }

  return `${requestLine}${headerLines.join(CRLF)}${DOUBLE_CRLF}`;
}

/**
 * WebSocket/Upgrade 转发器
 * Upgrade 语义与 HTTP 类似，但需等 101 才桥接
 */
export class WsForwarder
{
  private dialer = new Dialer();

  constructor(private sink?: PipeEventSink)
  {
  }

  handle(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void
  {
    const mode = get("proxyMode");
    const proto = get("upstreamProtocol");

    // client + socks 上游：先向真实目标解析，再经 SOCKS 隧道发 Upgrade
    if (
      mode === "client"
      && (
        proto === "socks4"
        || proto === "socks5"
        || proto === "sockss4"
        || proto === "sockss5"
      )
    )
    {
      this.viaSocks(req, socket, head, proto);
      return;
    }

    const target =
      mode === "client"
        ? {
          host: get("upstreamHost"),
          port: get("upstreamPort"),
          path: req.url ?? "/",
        }
        : parseTargetParts(
          req.url ?? "",
          req.headers.host as string,
        );

    if (!target)
    {
      socket.destroy();
      return;
    }

    if (isSelfLoop(target.host, target.port))
    {
      socket.destroy();
      return;
    }

    const secure =
      mode === "client"
      && (
        proto === "https"
        || proto.startsWith("sockss")
      );

    this.dialer
      .choose(socket, target.host, target.port, secure, {
        logPrefix: "upgrade",
        timeoutReply: "",
        errorReply: "",
      })
      .then((upstream) =>
      {
        upstream.write(
          buildUpgradeReq(
            req,
            target.host,
            target.port,
            target.path,
          ),
        );

        if (head.length)
        {
          upstream.write(head);
        }

        this.relay(socket, upstream);
      })
      .catch(() =>
      {
        socket.destroy();
      });
  }

  /**
   * 经 SOCKS 上游的 Upgrade：解析真实目标 → dialSocks 建隧道 → 发 Upgrade 等 101
   */
  private viaSocks(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    proto: string,
  ): void
  {
    const real = parseTargetParts(
      req.url ?? "",
      req.headers.host as string,
    );

    if (!real)
    {
      socket.destroy();
      return;
    }

    if (isSelfLoop(real.host, real.port))
    {
      socket.destroy();
      return;
    }

    const version: 4 | 5 = (
      proto === "socks4" || proto === "sockss4"
    ) ? 4 : 5;

    this.dialer
      .dialSocks(socket, real.host, real.port, version, undefined, {
        logPrefix: "upgrade",
        timeoutReply: "",
        errorReply: "",
      })
      .then((upstream) =>
      {
        upstream.write(
          buildUpgradeReq(
            req,
            real.host,
            real.port,
            real.path,
          ),
        );

        if (head.length)
        {
          upstream.write(head);
        }

        this.relay(socket, upstream);
      })
      .catch(() =>
      {
        socket.destroy();
      });
  }

  /**
   * 等 101：成功则桥接，失败回源
   */
  private relay(
    client: Duplex,
    upstream: Duplex,
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

      upstream.off("data", onData);

      const header = buf.subarray(
        0,
        idx + DOUBLE_CRLF_BUF.length,
      );
      const rest = buf.subarray(
        idx + DOUBLE_CRLF_BUF.length,
      );

      if (
        header
          .toString()
          .includes(String(STATUS_SWITCHING_PROTOCOLS))
      )
      {
        client.write(header);

        if (rest.length)
        {
          client.write(rest);
        }

        this.dialer.bridge(client, upstream);
      }
      else
      {
        client.write(Buffer.concat([header, rest]));
        upstream.destroy();
        client.destroy();
      }
    };

    upstream.on("data", onData);
  }
}

export function forwardUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  sink?: PipeEventSink,
): void
{
  new WsForwarder(sink).handle(req, socket, head);
}
