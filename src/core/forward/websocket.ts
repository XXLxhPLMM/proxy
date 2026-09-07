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
        get("upstreamProtocol") === "https"
        || get("upstreamProtocol").startsWith("sockss")
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
