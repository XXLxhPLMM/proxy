import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import { isSelfLoop } from "@/core/proxy-helpers.js";
import {
  CRLF,
  DOUBLE_CRLF,
  HEADER_NAME_PROXY_AUTHORIZATION,
  SOCKS4_NULL,
  SOCKS4_REPLY_FAILURE,
  SOCKS4_REPLY_SUCCESS,
  SOCKS4_VERSION,
  SOCKS5_ATYP_DOMAIN,
  SOCKS5_ATYP_IPV4,
  SOCKS5_ATYP_IPV6,
  SOCKS5_NO_AUTH,
  SOCKS5_REPLY_FAILURE,
  SOCKS5_REPLY_SUCCESS,
  SOCKS5_VERSION,
  SOCKS_CMD_CONNECT,
  STATUS_OK,
  buildProxyAuthValue,
} from "@/utils/constants.js";
import type { PipeEventSink } from "@/core/types/proxy.js";
import { Dialer } from "./dial.js";
import { encodeBasicCredentials, buildConnectRequest } from "@/core/proxy-helpers.js";

/**
 * 上游鉴权头：仅当显式配置 upstreamUsername 时携带
 */
function upstreamAuth(): string | undefined {
  const user = get("upstreamUsername");

  if (!user) {
    return undefined;
  }

  return `${HEADER_NAME_PROXY_AUTHORIZATION}: ${buildProxyAuthValue(
    encodeBasicCredentials(user, get("upstreamPassword")),
  )}`;
}

/**
 * SOCKS 转发器
 * - 下游：socks4 / socks5 明文（TLS 由 server 层承载）
 * - 上游：按 proxyMode 与 upstreamProtocol 串联 http/https/socks
 */
export class SocksForwarder {
  private dialer = new Dialer();

  constructor(private sink?: PipeEventSink) {}

  private emit(e: unknown): void {
    try {
      this.sink?.(e as never);
    } catch {}
  }

  /**
   * 入口：首字节即版本号，不符直接断链防协议混淆
   */
  handle(socket: Duplex, version: 4 | 5): void {
    socket.once("data", (first: Buffer) => {
      if (first[0] !== version) {
        socket.destroy();
        return;
      }

      if (version === 5) {
        this.handleSocks5(socket, first);
      } else {
        this.handleSocks4(socket, first);
      }
    });
  }

  /**
   * SOCKS5 无鉴权握手：仅支持 CONNECT，IPv6 直接拒链（鉴权已由 server 层完成）
   */
  private handleSocks5(socket: Duplex, _first: Buffer): void {
    void _first;
    socket.write(SOCKS5_NO_AUTH);

    socket.once("data", (req: Buffer) => {
      if (req.length < 10 || req[0] !== SOCKS5_VERSION || req[1] !== SOCKS_CMD_CONNECT) {
        this.emit({ type: "bad-request", message: `[socks] invalid socks5 req len=${req.length}` });
        socket.destroy();
        return;
      }
      const host = this.parseSocks5Host(req);
      if (!host) {
        this.emit({ type: "bad-request", message: "[socks] cannot parse socks5 host" });
        socket.destroy();
        return;
      }
      const client = (socket as unknown as { remoteAddress?: string }).remoteAddress ?? "unknown";
      this.emit({ type: "socks", message: `[socks] ${client} -> ${host.host}:${host.port} CONNECT (socks5)` } as never);
      this.connect(socket, host.host, host.port, 5);
    });
  }

  /**
   * SOCKS5 已鉴权后的 CONNECT 处理（供 server 层鉴权成功后调用）
   */
  handleSocks5Connect(socket: Duplex): void {
    socket.once("data", (req: Buffer) => {
      if (req.length < 10 || req[0] !== SOCKS5_VERSION || req[1] !== SOCKS_CMD_CONNECT) {
        this.emit({ type: "bad-request", message: `[socks] invalid socks5 req len=${req.length}` });
        socket.destroy();
        return;
      }
      const host = this.parseSocks5Host(req);
      if (!host) {
        this.emit({ type: "bad-request", message: "[socks] cannot parse socks5 host" });
        socket.destroy();
        return;
      }
      const client = (socket as unknown as { remoteAddress?: string }).remoteAddress ?? "unknown";
      this.emit({ type: "socks", message: `[socks] ${client} -> ${host.host}:${host.port} CONNECT (socks5)` } as never);
      this.connect(socket, host.host, host.port, 5);
    });
  }

  /**
   * 解析 SOCKS4 首包，返回 USERID/host/port/isSocks4a，失败返回 null 并已 emit/destroy
   */
  parseSocks4First(first: Buffer, socket: Duplex): { userid: string; host: string; port: number; isSocks4a: boolean } | null {
    if (first.length < 9 || first[0] !== SOCKS4_VERSION) {
      this.emit({ type: "bad-request", message: `[socks] invalid socks4 first len=${first.length}` });
      socket.destroy();
      return null;
    }
    const port = first.readUInt16BE(2);
    const ip = `${first[4]}.${first[5]}.${first[6]}.${first[7]}`;
    const isSocks4a = first[4] === 0 && first[5] === 0 && first[6] === 0 && first[7] !== 0;
    const useridEnd = first.indexOf(SOCKS4_NULL, 8);
    if (useridEnd === -1) {
      this.emit({ type: "bad-request", message: "[socks] socks4 missing USERID NUL" });
      socket.destroy();
      return null;
    }
    const userid = first.subarray(8, useridEnd).toString();
    let host = ip;
    if (isSocks4a) {
      const domainStart = useridEnd + 1;
      const domainEnd = first.indexOf(SOCKS4_NULL, domainStart);
      if (domainEnd === -1) {
        this.emit({ type: "bad-request", message: "[socks] socks4a missing DOMAIN NUL" });
        socket.destroy();
        return null;
      }
      host = first.subarray(domainStart, domainEnd).toString();
      if (!host) {
        this.emit({ type: "bad-request", message: "[socks] socks4a empty domain" });
        socket.destroy();
        return null;
      }
    }
    return { userid, host, port, isSocks4a };
  }

  /**
   * SOCKS4 / SOCKS4a：VN 0x04 + CD + PORT + IP + USERID(0x00) [+ DOMAIN(0x00) for 4a]
   * 4a 判定：DSTIP = 0.0.0.x (x!=0) 时域名在 USERID 之后，见 https://www.openssh.com/txt/socks4a.protocol
   */
  private handleSocks4(socket: Duplex, first: Buffer): void {
    const parsed = this.parseSocks4First(first, socket);
    if (!parsed) return;
    const client = (socket as unknown as { remoteAddress?: string }).remoteAddress ?? "unknown";
    this.emit({ type: "socks", message: `[socks] ${client} -> ${parsed.host}:${parsed.port} CONNECT (socks4${parsed.isSocks4a ? "a" : ""})` } as never);
    this.connect(socket, parsed.host, parsed.port, 4);
  }

  /** 供 server 层已做 USERID 鉴权后直接建隧，避免二次解析 USERID */
  handleSocks4Parsed(socket: Duplex, parsed: { host: string; port: number; isSocks4a: boolean }): void {
    const client = (socket as unknown as { remoteAddress?: string }).remoteAddress ?? "unknown";
    this.emit({ type: "socks", message: `[socks] ${client} -> ${parsed.host}:${parsed.port} CONNECT (socks4${parsed.isSocks4a ? "a" : ""})` } as never);
    this.connect(socket, parsed.host, parsed.port, 4);
  }

  /**
   * 解析 S5 目标：ATYP 0x01=IPv4 / 0x03=域名，0x04 不支持；端口均为大端
   */
  private parseSocks5Host(buf: Buffer): { host: string; port: number } | null {
    const atyp = buf[3];

    if (atyp === SOCKS5_ATYP_IPV4) {
      const host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
      const port = buf.readUInt16BE(8);
      return { host, port };
    }

    if (atyp === SOCKS5_ATYP_DOMAIN) {
      const len = buf[4];
      const host = buf.subarray(5, 5 + len).toString();
      const port = buf.readUInt16BE(5 + len);
      return { host, port };
    }

    // IPv6 暂不支持
    if (atyp === SOCKS5_ATYP_IPV6) {
      return null;
    }

    return null;
  }

  private async connect(client: Duplex, host: string, port: number, ver: 4 | 5): Promise<void> {
    if (isSelfLoop(host, port)) {
      this.emit({ type: "loop-detected", target: `${host}:${port}` } as never);
      this.replyFail(client, ver);
      return;
    }

    const mode = get("proxyMode");

    if (mode !== "client") {
      try {
        const upstream = await this.dialer.dialDirect(client, host, port);
        this.replySuccess(client, ver);
        this.emit({ type: "socks", message: `[socks] tunnel established ${host}:${port} (socks${ver})` } as never);
        this.dialer.bridge(client, upstream);
      } catch (e) {
        this.emit({ type: "upstream-error", message: `[socks] upstream error ${host}:${port}: ${(e as Error).message}` } as never);
        this.replyFail(client, ver);
      }

      return;
    }

    const proto = get("upstreamProtocol");
    const upstreamHost = get("upstreamHost");
    const upstreamPort = get("upstreamPort");
    const secure = proto === "sockss4" || proto === "sockss5" || proto === "https";

    // http(s) 上游载 CONNECT：等 200 才回成功
    if (proto === "http" || proto === "https") {
      try {
        const upstream = await this.dialer.choose(client, upstreamHost, upstreamPort, secure);

        const auth = upstreamAuth();
        upstream.write(buildConnectRequest(host, port, auth));

        let buf = Buffer.alloc(0);

        const onData = (chunk: Buffer): void => {
          buf = Buffer.concat([buf, chunk]);

          if (!buf.includes(DOUBLE_CRLF)) {
            return;
          }

          if (!buf.toString().includes(String(STATUS_OK))) {
            this.emit({ type: "upstream-refused", statusLine: buf.toString().split(CRLF)[0] } as never);
            this.replyFail(client, ver);
            upstream.destroy();
            return;
          }

          upstream.off("data", onData);
          this.replySuccess(client, ver);
          this.emit({ type: "socks", message: `[socks] tunnel via upstream ${upstreamHost}:${upstreamPort} -> ${host}:${port}` } as never);
          this.dialer.bridge(client, upstream);
        };

        upstream.on("data", onData);
      } catch (e) {
        this.emit({ type: "upstream-error", message: `[socks] upstream error ${host}:${port}: ${(e as Error).message}` } as never);
        this.replyFail(client, ver);
      }

      return;
    }

    // socks 上游做第二段握手到真实目标
    const version: 4 | 5 = proto === "socks4" || proto === "sockss4" ? 4 : 5;

    try {
      const upstream = await this.dialer.dialSocks(client, host, port, version);
      this.replySuccess(client, ver);
      this.emit({ type: "socks", message: `[socks] tunnel via socks upstream ${host}:${port} (socks${ver}->socks${version})` } as never);
      this.dialer.bridge(client, upstream);
    } catch (e) {
      this.emit({ type: "upstream-error", message: `[socks] socks upstream error ${host}:${port}: ${(e as Error).message}` } as never);
      this.replyFail(client, ver);
    }
  }

  private replySuccess(socket: Duplex, ver: number): void {
    if (ver === 5) {
      socket.write(SOCKS5_REPLY_SUCCESS);
    } else {
      socket.write(SOCKS4_REPLY_SUCCESS);
    }
  }

  private replyFail(socket: Duplex, ver: number): void {
    if (ver === 5) {
      socket.write(SOCKS5_REPLY_FAILURE);
    } else {
      socket.write(SOCKS4_REPLY_FAILURE);
    }

    // 延时 100：确保 FAIL 字节先发出再 destroy，防下游收不到回包
    setTimeout(() => {
      socket.destroy();
    }, 100);
  }
}
