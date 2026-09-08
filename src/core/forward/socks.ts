import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import { isSelfLoop } from "@/core/proxy-helpers.js";
import {
  DOUBLE_CRLF,
  SOCKS5_NO_AUTH,
  SOCKS5_REPLY_FAILURE,
  SOCKS5_REPLY_SUCCESS,
  SOCKS4_REPLY_FAILURE,
  SOCKS4_REPLY_SUCCESS,
  buildProxyAuthValue,
} from "@/utils/constants.js";
import type { PipeEventSink } from "@/core/types/proxy.js";
import { Dialer } from "./dial.js";
import {
  encodeBasicCredentials,
  buildConnectRequest,
} from "@/core/proxy-helpers.js";

/**
 * 上游鉴权头：仅当显式配置 upstreamUsername 时携带
 */
function upstreamAuth(): string | undefined
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
 * SOCKS 转发器
 * - 下游：socks4 / socks5 明文（TLS 由 server 层承载）
 * - 上游：按 proxyMode 与 upstreamProtocol 串联 http/https/socks
 */
export class SocksForwarder
{
  private dialer = new Dialer();

  constructor(private sink?: PipeEventSink)
  {
  }

  /**
   * 入口：按版本分发
   */
  handle(socket: Duplex, version: 4 | 5): void
  {
    socket.once("data", (first: Buffer) =>
    {
      if (first[0] !== version)
      {
        socket.destroy();
        return;
      }

      if (version === 5)
      {
        this.handleSocks5(socket, first);
      }
      else
      {
        this.handleSocks4(socket, first);
      }
    });
  }

  /**
   * SOCKS5：无鉴权握手 → 解析域名/IPv4 → 建链
   */
  private handleSocks5(
    socket: Duplex,
    _first: Buffer,
  ): void
  {
    socket.write(SOCKS5_NO_AUTH);

    socket.once("data", (req: Buffer) =>
    {
      if (
        req.length < 10
        || req[0] !== 0x05
        || req[1] !== 0x01
      )
      {
        socket.destroy();
        return;
      }

      const host = this.parseSocks5Host(req);

      if (!host)
      {
        socket.destroy();
        return;
      }

      this.connect(socket, host.host, host.port, 5);
    });
  }

  /**
   * SOCKS4：直接解析 IP/域名 → 建链
   */
  private handleSocks4(
    socket: Duplex,
    first: Buffer,
  ): void
  {
    if (first.length < 8)
    {
      socket.destroy();
      return;
    }

    const port = first.readUInt16BE(2);
    const ip =
      `${first[4]}.${first[5]}.${first[6]}.${first[7]}`;

    let host = ip;
    const offset = 8;

    // SOCKS4a：0.0.0.x 表示域名在尾部
    if (ip.startsWith("0.0.0."))
    {
      const end = first.indexOf(0x00, offset);

      if (end !== -1)
      {
        host = first.subarray(offset, end).toString();
      }
    }

    this.connect(socket, host, port, 4);
  }

  private parseSocks5Host(
    buf: Buffer,
  ): { host: string; port: number } | null
  {
    const atyp = buf[3];

    if (atyp === 0x01)
    {
      const host =
        `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
      const port = buf.readUInt16BE(8);
      return { host, port };
    }

    if (atyp === 0x03)
    {
      const len = buf[4];
      const host = buf.subarray(5, 5 + len).toString();
      const port = buf.readUInt16BE(5 + len);
      return { host, port };
    }

    // IPv6 暂不支持
    if (atyp === 0x04)
    {
      return null;
    }

    return null;
  }

  private async connect(
    client: Duplex,
    host: string,
    port: number,
    ver: 4 | 5,
  ): Promise<void>
  {
    if (isSelfLoop(host, port))
    {
      this.replyFail(client, ver);
      return;
    }

    const mode = get("proxyMode");

    // server 直连
    if (mode !== "client")
    {
      try
      {
        const upstream = await this.dialer.dialDirect(
          client,
          host,
          port,
        );
        this.replySuccess(client, ver);
        this.dialer.bridge(client, upstream);
      }
      catch
      {
        this.replyFail(client, ver);
      }

      return;
    }

    // client 串联
    const proto = get("upstreamProtocol");
    const upstreamHost = get("upstreamHost");
    const upstreamPort = get("upstreamPort");
    const secure =
      proto === "sockss4"
      || proto === "sockss5"
      || proto === "https";

    // 上游为 HTTP(S)：发 CONNECT 等 200
    if (
      proto === "http"
      || proto === "https"
    )
    {
      try
      {
        const upstream = await this.dialer.choose(
          client,
          upstreamHost,
          upstreamPort,
          secure,
        );

        const auth = upstreamAuth();
        upstream.write(
          buildConnectRequest(host, port, auth),
        );

        let buf = Buffer.alloc(0);

        const onData = (chunk: Buffer): void =>
        {
          buf = Buffer.concat([buf, chunk]);

          if (!buf.includes(DOUBLE_CRLF))
          {
            return;
          }

          if (!buf.toString().includes("200"))
          {
            this.replyFail(client, ver);
            upstream.destroy();
            return;
          }

          upstream.off("data", onData);
          this.replySuccess(client, ver);
          this.dialer.bridge(client, upstream);
        };

        upstream.on("data", onData);
      }
      catch
      {
        this.replyFail(client, ver);
      }

      return;
    }

    // 上游为 SOCKS：经上游向真实目标做第二段 SOCKS 握手
    // 版本按 upstreamProtocol 推导：socks4/sockss4 → 4，其余 → 5
    const version: 4 | 5 = (
      proto === "socks4" || proto === "sockss4"
    ) ? 4 : 5;

    try
    {
      const upstream = await this.dialer.dialSocks(
        client,
        host,
        port,
        version,
      );
      this.replySuccess(client, ver);
      this.dialer.bridge(client, upstream);
    }
    catch
    {
      this.replyFail(client, ver);
    }
  }

  private replySuccess(
    socket: Duplex,
    ver: number,
  ): void
  {
    if (ver === 5)
    {
      socket.write(SOCKS5_REPLY_SUCCESS);
    }
    else
    {
      socket.write(SOCKS4_REPLY_SUCCESS);
    }
  }

  private replyFail(
    socket: Duplex,
    ver: number,
  ): void
  {
    if (ver === 5)
    {
      socket.write(SOCKS5_REPLY_FAILURE);
    }
    else
    {
      socket.write(SOCKS4_REPLY_FAILURE);
    }

    setTimeout(() =>
    {
      socket.destroy();
    }, 100);
  }
}
