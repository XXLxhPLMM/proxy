/**
 * HTTP 代理客户端 - 通过 http/https 代理访问目标
 * 职责：
 * - 封装 http/https 代理的 CONNECT 与 GET 两种语义，复用 Basic 鉴权头（Proxy-Authorization）
 * - 支持明文 http 代理与 TLS https 代理（tls 需 ca/ insecure 选项）
 * 关联：store auth*、utils/logger
 */

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import { getLogger } from "../utils/logger.js";
import { CRLF, DOUBLE_CRLF } from "../utils/constants.js";

export interface HttpProxyClientOptions {
  /** 代理地址，默认 127.0.0.1 */
  host?: string;
  /** 代理端口，默认 3000 */
  port?: number;
  /** 代理是否 TLS（https），默认 false（http） */
  secure?: boolean;
  /** Basic 用户名（对应 AUTH_USERNAME） */
  username?: string;
  /** Basic 密码（对应 AUTH_PASSWORD） */
  password?: string;
  /** TLS 时 CA 证书路径内容或 Buffer，传 ca 则校验，配合 insecure 忽略自签 */
  ca?: string | Buffer;
  /** 是否忽略证书校验（自签场景，默认 false） */
  insecure?: boolean;
  /** 超时 ms，默认 10000 */
  timeout?: number;
}

export class HttpProxyClient {
  private readonly log = getLogger("HttpClient");
  private readonly opts: Required<HttpProxyClientOptions>;

  constructor(options: HttpProxyClientOptions = {}) {
    this.opts = {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 3000,
      secure: options.secure ?? false,
      username: options.username ?? "",
      password: options.password ?? "",
      ca: (options.ca as string) ?? "",
      insecure: options.insecure ?? false,
      timeout: options.timeout ?? 10000,
    } as Required<HttpProxyClientOptions>;
  }

  private proxyAuthHeader(): string | undefined {
    if (!this.opts.username) return undefined;
    return `Basic ${Buffer.from(`${this.opts.username}:${this.opts.password}`).toString("base64")}`;
  }

  /**
   * 通过 http 代理 GET 目标（明文代理语义）
   * @param targetUrl - 目标完整 URL，如 http://example.com/
   * @returns 响应状态码与体
   */
  async get(targetUrl: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    const url = new URL(targetUrl);
    const isHttpsTarget = url.protocol === "https:";
    // https 目标建议走 CONNECT，此处仅演示 http 明文 GET
    const headers: Record<string, string> = { Host: url.host };
    const auth = this.proxyAuthHeader();
    if (auth) headers["Proxy-Authorization"] = auth;
    headers["Proxy-Connection"] = "keep-alive";

    const requestFn = this.opts.secure ? https.request : http.request;
    const reqOpts: http.RequestOptions = {
      host: this.opts.host,
      port: this.opts.port,
      method: "GET",
      path: targetUrl, // 代理需完整 URL
      headers,
      ca: this.opts.ca || undefined,
      rejectUnauthorized: !this.opts.insecure,
    } as http.RequestOptions;

    return new Promise((resolve, reject) => {
      const req = requestFn(reqOpts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      if (this.opts.timeout) req.setTimeout(this.opts.timeout, () => { req.destroy(new Error("timeout")); reject(new Error("timeout")); });
      req.end();
    });
  }

  /**
   * 通过代理建立 CONNECT 隧道后请求目标（https 代理语义，适用于 https 目标）
   * @param targetHost - 目标主机，如 example.com
   * @param targetPort - 目标端口，如 443
   */
  async connect(targetHost: string, targetPort: number): Promise<net.Socket> {
    const auth = this.proxyAuthHeader();
    const headers = auth ? `Proxy-Authorization: ${auth}${CRLF}` : "";
    const connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1${CRLF}Host: ${targetHost}:${targetPort}${CRLF}${headers}Proxy-Connection: keep-alive${DOUBLE_CRLF}`;

    const socket: net.Socket = await new Promise((resolve, reject) => {
      const raw = this.opts.secure
        ? tls.connect({ host: this.opts.host, port: this.opts.port, ca: this.opts.ca as string | undefined, rejectUnauthorized: !this.opts.insecure })
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
}

export function createHttpProxyClient(opts?: HttpProxyClientOptions): HttpProxyClient {
  return new HttpProxyClient(opts);
}
