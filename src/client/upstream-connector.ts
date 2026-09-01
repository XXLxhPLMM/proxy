/**
 * UpstreamConnector - 统一上游代理连接器
 * 职责：按 protocol 选择 HTTP CONNECT / SOCKS5 / TLS 握手，返回已建立的 net.Socket
 * 设计：协议无关的抽象层，ClientForwardProxy 只管转发，不关心上游协议细节
 * 关联：client/http、client/socks、utils/logger、utils/constants
 */

import http from "node:http";
import tls from "node:tls";
import net from "node:net";
import { getLogger } from "../utils/logger.js";
import { CRLF, DOUBLE_CRLF } from "../utils/constants.js";

export interface UpstreamConnectorOptions {
  /** 上游代理地址，默认 127.0.0.1 */
  host?: string;
  /** 上游代理端口，默认 3000 */
  port?: number;
  /** 上游协议类型 */
  protocol: "http" | "https" | "socks" | "tls";
  /** 是否 TLS（对 http/https/socks 协议有效），默认 false */
  secure?: boolean;
  /** Basic 用户名（Proxy-Authorization） */
  username?: string;
  /** Basic 密码 */
  password?: string;
  /** TLS 时 CA 证书路径内容或 Buffer */
  ca?: string | Buffer;
  /** 是否忽略证书校验（自签场景，默认 false） */
  insecure?: boolean;
  /** 超时 ms，默认 10000 */
  timeout?: number;
}

export class UpstreamConnector {
  private readonly log = getLogger("UpstreamConnector");
  private readonly opts: Required<UpstreamConnectorOptions>;

  constructor(options: UpstreamConnectorOptions) {
    this.opts = {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 3000,
      protocol: options.protocol,
      secure: options.secure ?? false,
      username: options.username ?? "",
      password: options.password ?? "",
      ca: (options.ca as string) ?? "",
      insecure: options.insecure ?? false,
      timeout: options.timeout ?? 10000,
    } as Required<UpstreamConnectorOptions>;
  }

  /**
   * 建立到上游代理的连接，返回已握手的 net.Socket
   * @param targetHost - 目标主机
   * @param targetPort - 目标端口
   * @returns 已建立的 socket，可直接 pipe 或写 HTTP
   */
  async connect(targetHost: string, targetPort: number): Promise<net.Socket> {
    switch (this.opts.protocol) {
      case "http":
      case "https":
        return this.connectViaHttpConnect(targetHost, targetPort);
      case "socks":
        return this.connectViaSocks5(targetHost, targetPort);
      case "tls":
        return this.connectViaTls(targetHost, targetPort);
      default:
        throw new Error(`unsupported upstream protocol: ${this.opts.protocol}`);
    }
  }

  /**
   * 便捷 GET：通过上游代理请求 http 目标
   * @param targetUrl - 完整 URL，如 http://example.com/
   * @returns 响应状态码与体
   */
  async get(targetUrl: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    const url = new URL(targetUrl);
    const socket = await this.connect(url.hostname, Number(url.port || 80));
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      socket.on("data", (d) => chunks.push(d));
      socket.on("error", reject);
      socket.on("close", () => {
        const data = Buffer.concat(chunks);
        const headEnd = data.indexOf(DOUBLE_CRLF);
        const headStr = headEnd !== -1 ? data.subarray(0, headEnd).toString() : "";
        const lines = headStr.split(CRLF);
        const statusLine = lines[0] ?? "";
        const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)/);
        const code = m ? Number(m[1]) : 0;
        const headers: http.IncomingHttpHeaders = {};
        for (let i = 1; i < lines.length; i++) {
          const idx = lines[i].indexOf(":");
          if (idx === -1) continue;
          headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
        }
        resolve({
          statusCode: code,
          headers,
          body: headEnd !== -1 ? data.subarray(headEnd + DOUBLE_CRLF.length) : data,
        });
      });
      socket.write(`GET ${url.pathname}${url.search} HTTP/1.1${CRLF}Host: ${url.host}${CRLF}Connection: close${DOUBLE_CRLF}`);
      setTimeout(() => socket.destroy(), this.opts.timeout);
    });
  }

  // ─── HTTP CONNECT 握手 ───

  private async connectViaHttpConnect(targetHost: string, targetPort: number): Promise<net.Socket> {
    const auth = this.proxyAuthHeader();
    const headers = auth ? `Proxy-Authorization: ${auth}${CRLF}` : "";
    const connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1${CRLF}Host: ${targetHost}:${targetPort}${CRLF}${headers}Proxy-Connection: keep-alive${DOUBLE_CRLF}`;

    const socket: net.Socket = await new Promise((resolve, reject) => {
      const raw = this.opts.secure
        ? tls.connect({ host: this.opts.host, port: this.opts.port, ca: this.opts.ca || undefined, rejectUnauthorized: !this.opts.insecure })
        : net.connect(this.opts.port, this.opts.host);
      raw.once("error", reject);
      raw.once(this.opts.secure ? "secureConnect" : "connect", () => resolve(raw as unknown as net.Socket));
      if (this.opts.timeout) raw.setTimeout(this.opts.timeout, () => { raw.destroy(); reject(new Error("timeout")); });
    });

    await new Promise<void>((resolve, reject) => {
      const onData = (data: Buffer) => {
        const head = data.toString();
        if (!head.includes("200")) { socket.off("data", onData); reject(new Error(`proxy CONNECT failed: ${head.split(CRLF)[0]}`)); socket.destroy(); return; }
        const idx = data.indexOf(DOUBLE_CRLF);
        if (idx !== -1) { socket.off("data", onData); if (data.length > idx + DOUBLE_CRLF.length) socket.unshift(data.subarray(idx + DOUBLE_CRLF.length)); resolve(); }
      };
      socket.on("data", onData);
      socket.on("error", reject);
      socket.write(connectReq);
    });
    return socket;
  }

  // ─── SOCKS5 握手 ───

  private async connectViaSocks5(targetHost: string, targetPort: number): Promise<net.Socket> {
    const socket = await this.connectTransport();
    await this.handshakeSocks5(socket);
    await this.requestSocks5Connect(socket, targetHost, targetPort);
    return socket;
  }

  private async connectTransport(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = this.opts.secure
        ? tls.connect({ host: this.opts.host, port: this.opts.port, ca: this.opts.ca || undefined, rejectUnauthorized: !this.opts.insecure })
        : net.connect(this.opts.port, this.opts.host);
      s.once("error", reject);
      s.once(this.opts.secure ? "secureConnect" : "connect", () => resolve(s as unknown as net.Socket));
      if (this.opts.timeout) s.setTimeout(this.opts.timeout, () => { s.destroy(); reject(new Error("timeout")); });
    });
  }

  private async handshakeSocks5(socket: net.Socket): Promise<void> {
    const hasAuth = !!this.opts.username;
    const methods = hasAuth ? Buffer.from([0x02]) : Buffer.from([0x00]);
    socket.write(Buffer.from([0x05, methods.length, ...methods]));
    const resp = await this.readExact(socket, 2);
    if (resp[0] !== 0x05) throw new Error(`socks5 bad ver ${resp[0]}`);
    if (resp[1] === 0xff) throw new Error("socks5 no acceptable methods");
    if (resp[1] === 0x02) {
      const u = Buffer.from(this.opts.username), p = Buffer.from(this.opts.password);
      socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      const authResp = await this.readExact(socket, 2);
      if (authResp[1] !== 0x00) throw new Error("socks5 auth failed");
    } else if (resp[1] !== 0x00) throw new Error(`socks5 unknown method ${resp[1]}`);
  }

  private async requestSocks5Connect(socket: net.Socket, host: string, port: number): Promise<void> {
    const hostBuf = Buffer.from(host);
    const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, Buffer.from([(port >> 8) & 0xff, port & 0xff])]);
    socket.write(req);
    const resp = await this.readExact(socket, 10);
    if (resp[1] !== 0x00) throw new Error(`socks5 connect failed rep=${resp[1]}`);
  }

  private readExact(socket: net.Socket, n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalLen = 0;
      const onData = (d: Buffer) => {
        chunks.push(d);
        totalLen += d.length;
        if (totalLen >= n) {
          socket.off("data", onData);
          const buf = Buffer.concat(chunks);
          resolve(buf.subarray(0, n));
          if (buf.length > n) socket.unshift(buf.subarray(n));
        }
      };
      socket.on("data", onData);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("closed")));
    });
  }

  // ─── TLS 直连（mTLS）───

  private async connectViaTls(targetHost: string, targetPort: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = tls.connect({
        host: this.opts.host,
        port: this.opts.port,
        ca: this.opts.ca || undefined,
        rejectUnauthorized: !this.opts.insecure,
      });
      s.once("error", reject);
      s.once("secureConnect", () => {
        // TLS 直连后发送目标信息，由服务端路由
        s.write(JSON.stringify({ host: targetHost, port: targetPort }) + CRLF);
        resolve(s as unknown as net.Socket);
      });
      if (this.opts.timeout) s.setTimeout(this.opts.timeout, () => { s.destroy(); reject(new Error("timeout")); });
    });
  }

  // ─── 工具方法 ───

  private proxyAuthHeader(): string | undefined {
    if (!this.opts.username) return undefined;
    return `Basic ${Buffer.from(`${this.opts.username}:${this.opts.password}`).toString("base64")}`;
  }
}

export function createUpstreamConnector(opts: UpstreamConnectorOptions): UpstreamConnector {
  return new UpstreamConnector(opts);
}
