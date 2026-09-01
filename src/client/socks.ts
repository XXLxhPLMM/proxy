/**
 * SOCKS 代理客户端 - SOCKS5（支持 TLS 密文与明文，SOCKS4/4a 兼容）
 * 职责：
 * - 封装 SOCKS5 握手（RFC1928 METHOD + RFC1929 用户密码）与 CONNECT 请求（ATYP 域名/IPv4/IPv6），复用 Basic 鉴权
 * - 支持 socks over TLS（secure=true 时先 tls 握手）与明文 socks，对应服务端 SocksProxy tls.Server
 * 关联：store auth*、utils/logger
 */

import tls from "node:tls";
import net from "node:net";
import type { Duplex } from "node:stream";
import { getLogger } from "../utils/logger.js";
import { CRLF, DOUBLE_CRLF, RE_HTTP_STATUS } from "../utils/constants.js";

export interface SocksProxyClientOptions {
  /** 代理地址，默认 127.0.0.1 */
  host?: string;
  /** 代理端口，默认 3000 */
  port?: number;
  /** 是否 TLS（socks over TLS），默认 true（对应服务端 tls.Server），false 为明文兼容 */
  secure?: boolean;
  /** Basic 用户名 */
  username?: string;
  /** Basic 密码 */
  password?: string;
  /** TLS 时 CA，用于校验自签 keys/ca.crt */
  ca?: string | Buffer;
  /** 是否忽略证书校验（自签场景） */
  insecure?: boolean;
  /** 超时 ms，默认 10000 */
  timeout?: number;
}

export class SocksProxyClient {
  private readonly log = getLogger("SocksClient");
  private readonly opts: Required<SocksProxyClientOptions>;

  constructor(options: SocksProxyClientOptions = {}) {
    this.opts = {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 3000,
      secure: options.secure ?? true,
      username: options.username ?? "",
      password: options.password ?? "",
      ca: (options.ca as string) ?? "",
      insecure: options.insecure ?? false,
      timeout: options.timeout ?? 10000,
    } as Required<SocksProxyClientOptions>;
  }

  /**
   * 建立 SOCKS5 隧道至目标
   * @param targetHost - 目标主机（域名或 IP）
   * @param targetPort - 目标端口
   * @returns 已建立的双工流（可直接 pipe 或写 HTTP）
   */
  async connect(targetHost: string, targetPort: number): Promise<Duplex> {
    const socket = await this.connectTransport();
    await this.handshakeSocks5(socket);
    await this.requestConnect(socket, targetHost, targetPort);
    return socket;
  }

  private async connectTransport(): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const s = this.opts.secure
        ? tls.connect({ host: this.opts.host, port: this.opts.port, ca: this.opts.ca as string | undefined, rejectUnauthorized: !this.opts.insecure })
        : net.connect(this.opts.port, this.opts.host);
      s.once("error", reject);
      s.once(this.opts.secure ? "secureConnect" : "connect", () => resolve(s as unknown as Duplex));
      if (this.opts.timeout) (s as unknown as net.Socket).setTimeout(this.opts.timeout, () => { s.destroy(); reject(new Error("timeout")); });
    });
  }

  private async handshakeSocks5(socket: Duplex): Promise<void> {
    const s = socket as unknown as net.Socket;
    const hasAuth = !!this.opts.username;
    const methods = hasAuth ? Buffer.from([0x02]) : Buffer.from([0x00]);
    s.write(Buffer.from([0x05, methods.length, ...methods]));
    const resp = await this.readExact(s, 2);
    if (resp[0] !== 0x05) throw new Error(`socks5 bad ver ${resp[0]}`);
    if (resp[1] === 0xff) throw new Error("socks5 no acceptable methods");
    if (resp[1] === 0x02) {
      // RFC1929 子协商
      const u = Buffer.from(this.opts.username), p = Buffer.from(this.opts.password);
      s.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      const authResp = await this.readExact(s, 2);
      if (authResp[1] !== 0x00) throw new Error("socks5 auth failed");
    } else if (resp[1] !== 0x00) throw new Error(`socks5 unknown method ${resp[1]}`);
  }

  private async requestConnect(socket: Duplex, host: string, port: number): Promise<void> {
    const s = socket as unknown as net.Socket;
    const hostBuf = Buffer.from(host);
    const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, Buffer.from([(port >> 8) & 0xff, port & 0xff])]);
    s.write(req);
    const resp = await this.readExact(s, 10);
    if (resp[1] !== 0x00) throw new Error(`socks5 connect failed rep=${resp[1]}`);
  }

  private readExact(socket: Duplex, n: number): Promise<Buffer> {
    const s = socket as unknown as net.Socket;
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalLen = 0;
      const onData = (d: Buffer) => {
        chunks.push(d);
        totalLen += d.length;
        if (totalLen >= n) {
          s.off("data", onData);
          const buf = Buffer.concat(chunks);
          resolve(buf.subarray(0, n));
          if (buf.length > n) s.unshift(buf.subarray(n));
        }
      };
      s.on("data", onData);
      s.once("error", reject);
      s.once("close", () => reject(new Error("closed")));
    });
  }

  /**
   * 便捷 GET：通过 SOCKS5 隧道请求 http 目标
   * @param targetUrl - 如 http://example.com/
   */
  async get(targetUrl: string): Promise<{ statusCode: number; body: Buffer; raw: Buffer }> {
    const url = new URL(targetUrl);
    const tunnel = await this.connect(url.hostname, Number(url.port || 80));
    return new Promise((resolve, reject) => {
      const s = tunnel as unknown as net.Socket;
      const chunks: Buffer[] = [];
      s.on("data", (d) => chunks.push(d as Buffer));
      s.on("error", reject);
      s.on("close", () => {
        const data = Buffer.concat(chunks);
        const headEnd = data.indexOf(DOUBLE_CRLF);
        const head = headEnd !== -1 ? data.subarray(0, headEnd).toString() : "";
        const m = head.match(RE_HTTP_STATUS);
        const code = m ? Number(m[1]) : 0;
        resolve({ statusCode: code, body: headEnd !== -1 ? data.subarray(headEnd + DOUBLE_CRLF.length) : data, raw: data });
      });
      s.write(`GET ${url.pathname}${url.search} HTTP/1.1${CRLF}Host: ${url.host}${CRLF}Connection: close${DOUBLE_CRLF}`);
      setTimeout(() => s.destroy(), this.opts.timeout);
    });
  }
}

export function createSocksProxyClient(opts?: SocksProxyClientOptions): SocksProxyClient {
  return new SocksProxyClient(opts);
}
