/**
 * TLS/mTLS 透传代理 - 原生 tls 实现
 * 文件职责：
 * - 继承 BaseProxy，协议 tls，onBeforeStart 从 store 加载 key/cert/ca（TLS_CA 可选），doStart 以 tls.createServer({requestCert,ca,rejectUnauthorized:false}) 监听
 * - 握手层不直接拒绝，handleConnection 按 TLSSocket.authorized 日志 mTLS 结果，首包缓冲解析 CONNECT authority 后走 BaseProxy.authorize 鉴权，再 dialTunnel 透传
 * - dialTunnel 复用公共 tunnelConnect 函数
 * 关联：store tlsKey/tlsCert/tlsCa、constants、BaseProxy、proxy-helpers
 */

import tls from "node:tls";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { BaseProxy } from "./base.js";
import type { ProxyOptions } from "./types.js";
import { getLogger } from "../utils/logger.js";
import { loadCerts, extractTlsPaths } from "../utils/cert.js";
import {
  BODY_BAD_GATEWAY,
  BODY_BAD_REQUEST,
  BODY_GATEWAY_TIMEOUT,
  BODY_PROXY_AUTH_REQUIRED,
  CRLF,
  DOUBLE_CRLF,
  HEADER_PROXY_AUTHENTICATE,
  HTTP_400_BAD_REQUEST,
  HTTP_407_PROXY_AUTH_REQUIRED,
  RE_CONNECT,
  RE_HTTP_METHOD,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_GATEWAY_TIMEOUT,
  STATUS_PROXY_AUTH_REQUIRED,
} from "../utils/constants.js";
import {
  parseAuthority,
  sanitizeHeaders,
  tunnelConnect,
} from "../utils/proxy-helpers.js";

export class TlsProxy extends BaseProxy {
  protected readonly log = getLogger("TlsProxy");

  constructor(options: ProxyOptions = {}) {
    super("tls", options);
  }

  private certs?: { key: Buffer; cert: Buffer; ca?: Buffer };

  async onBeforeStart(): Promise<void> {
    this.log.info(`[lifecycle] tls loading certs key=${this.options.tls?.key} cert=${this.options.tls?.cert} ca=${this.options.tls?.ca}`);
    this.certs = loadCerts(extractTlsPaths(this.options.tls), this.log, "TLS");
  }

  async onStarted(): Promise<void> {
    this.log.info(`[lifecycle] tls started ${this.options.host}:${this.options.port} state=${this.state}`);
  }

  protected async doStart(): Promise<void> {
    if (!this.certs) this.certs = loadCerts(extractTlsPaths(this.options.tls), this.log, "TLS");
    const { key, cert, ca } = this.certs;
    const passphrase = (this.options.tls?.passphrase as string) || undefined;
    const server = tls.createServer(
      {
        key,
        cert,
        passphrase,
        ca: ca ? [ca] : undefined,
        requestCert: true,
        rejectUnauthorized: false,
      },
      (socket) => {
        this.handleConnection(socket as unknown as Duplex);
      },
    );

    await this.startListening(server, this.options.port, this.options.host);
    this.attachErrorHandlers(server, "tlsClientError");
    this.server = server;
  }

  protected async doStop(): Promise<void> {
    await this.stopServer();
  }

  isRunning(): boolean {
    return !!this.server?.listening;
  }

  private handleConnection(clientSocket: Duplex): void {
    const tlsSocket = clientSocket as unknown as tls.TLSSocket;
    const clientAddr = (tlsSocket.remoteAddress ?? "unknown") as string;
    const authorized = (tlsSocket as unknown as { authorized?: boolean }).authorized;

    if (authorized === false) {
      this.log.warn(`[mTLS] client cert not authorized ${clientAddr}`);
    } else if (authorized === true) {
      this.log.info(`[mTLS] client cert authorized ${clientAddr}`);
    }

    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const head = Buffer.concat(chunks);
      const idx = head.indexOf(DOUBLE_CRLF);
      if (idx === -1) return;

      clientSocket.off("data", onData);
      const header = head.subarray(0, idx).toString();
      const rest = head.subarray(idx + DOUBLE_CRLF.length);
      const lines = header.split(CRLF);
      const firstLine = lines[0] ?? "";
      const connectMatch = firstLine.match(RE_CONNECT);
      const headers: Record<string, string> = {};
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const sep = line.indexOf(":");
        if (sep === -1) continue;
        const k = line.slice(0, sep).trim().toLowerCase();
        const v = line.slice(sep + 1).trim();
        if (k) headers[k] = v;
      }
      this.log.debug(`[tls] headers ${clientAddr} -> ${firstLine} ${JSON.stringify(headers)}`);
      if (connectMatch) {
        const authority = connectMatch[1];
        this.log.info(`[tunnel-tls] ${clientAddr} -> ${authority} CONNECT`);
        const fakeReq = { url: authority, headers, socket: clientSocket } as unknown as import("node:http").IncomingMessage;
        this.authorize({ protocol: this.protocol, req: fakeReq, socket: clientSocket, authority }).then((passed) => {
          if (!passed) {
            clientSocket.write(HTTP_407_PROXY_AUTH_REQUIRED);
            clientSocket.destroy();
            return;
          }
          this.dialTunnel(clientSocket, authority, rest);
        });
        return;
      }
      const httpMatch = firstLine.match(RE_HTTP_METHOD);
      if (httpMatch) {
        const method = httpMatch[1];
        const rawUrl = httpMatch[2];
        const fakeReq = { method, url: rawUrl, headers, socket: clientSocket } as unknown as import("node:http").IncomingMessage;
        const authority = (headers["host"] as string) ?? rawUrl;
        this.authorize({ protocol: this.protocol, req: fakeReq, socket: clientSocket, authority }).then((passed) => {
          if (!passed) {
            clientSocket.write(
              `HTTP/1.1 ${STATUS_PROXY_AUTH_REQUIRED} Proxy Authentication Required${CRLF}Proxy-Authenticate: ${HEADER_PROXY_AUTHENTICATE}${CRLF}Content-Length: ${Buffer.byteLength(BODY_PROXY_AUTH_REQUIRED)}${DOUBLE_CRLF}${BODY_PROXY_AUTH_REQUIRED}`,
            );
            clientSocket.destroy();
            return;
          }
          this.forwardHttpOverTls(clientSocket, method, rawUrl, headers, rest);
        });
        return;
      }
      this.log.warn(`[tls] bad header ${clientAddr} -> ${firstLine}`);
      clientSocket.write(HTTP_400_BAD_REQUEST);
      clientSocket.destroy();
      return;
    };
    clientSocket.on("data", onData);

    const timeout = this.options.upstreamTimeout as number;
    if (timeout > 0) {
      (clientSocket as unknown as net.Socket).setTimeout(timeout, () => {
        this.log.warn(`[tls] client timeout ${clientAddr} after ${timeout}ms`);
        clientSocket.destroy();
      });
    }
  }

  private forwardHttpOverTls(clientSocket: Duplex, method: string, rawUrl: string, headers: Record<string, string>, head: Buffer): void {
    const clientAddr = (clientSocket as unknown as net.Socket).remoteAddress ?? "unknown";

    const targetUrl = this.resolveTargetUrlFromParts(rawUrl, headers);
    if (!targetUrl) {
      this.log.warn(`[tls-http] bad url ${clientAddr} -> ${rawUrl}`);
      clientSocket.write(`HTTP/1.1 ${STATUS_BAD_REQUEST} Bad Request${CRLF}Content-Length: ${Buffer.byteLength(BODY_BAD_REQUEST)}${DOUBLE_CRLF}${BODY_BAD_REQUEST}`);
      clientSocket.destroy();
      return;
    }
    this.log.info(`[tls-http] ${clientAddr} -> ${targetUrl.host} ${method} ${targetUrl.pathname}${targetUrl.search}`);

    const fwdHeaders = sanitizeHeaders(headers);
    const proxyReq = http.request(
      { hostname: targetUrl.hostname, port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80), method, path: targetUrl.pathname + targetUrl.search, headers: fwdHeaders },
      (proxyRes) => {
        const statusLine = `HTTP/1.1 ${proxyRes.statusCode ?? 502} ${proxyRes.statusMessage ?? ""}${CRLF}`;
        let headerBlock = "";
        for (const [k, v] of Object.entries(proxyRes.headers)) headerBlock += `${k}: ${Array.isArray(v) ? v.join(", ") : v}${CRLF}`;
        clientSocket.write(statusLine + headerBlock + CRLF);
        proxyRes.pipe(clientSocket as unknown as NodeJS.WritableStream as never);
      },
    );
    const timeout = this.options.upstreamTimeout as number;
    if (timeout > 0) proxyReq.setTimeout(timeout, () => {
      this.log.warn(`[tls-http] upstream timeout ${clientAddr} -> ${targetUrl.host}`);
      proxyReq.destroy();
      try { clientSocket.write(`HTTP/1.1 ${STATUS_GATEWAY_TIMEOUT} Gateway Timeout${CRLF}Content-Length: ${Buffer.byteLength(BODY_GATEWAY_TIMEOUT)}${DOUBLE_CRLF}${BODY_GATEWAY_TIMEOUT}`); } catch { void 0; }
      clientSocket.destroy();
    });
    proxyReq.on("error", (err) => {
      if ((clientSocket as unknown as { destroyed: boolean }).destroyed) return;
      if ((err as Error).message.includes("timeout")) return;
      this.log.warn(`[tls-http] upstream error ${clientAddr} -> ${targetUrl.host}:`, (err as Error).message);
      try { clientSocket.write(`HTTP/1.1 ${STATUS_BAD_GATEWAY} Bad Gateway${CRLF}Content-Length: ${Buffer.byteLength(BODY_BAD_GATEWAY)}${DOUBLE_CRLF}${BODY_BAD_GATEWAY}`); } catch { void 0; }
      clientSocket.destroy();
    });
    if (head.length) proxyReq.write(head);
    clientSocket.on("data", (chunk: Buffer) => proxyReq.write(chunk));
    clientSocket.on("close", () => proxyReq.destroy());
    clientSocket.on("error", () => proxyReq.destroy());
    proxyReq.on("close", () => { try { clientSocket.destroy(); } catch {} });
  }

  private resolveTargetUrlFromParts(raw: string, headers: Record<string, string>): URL | null {
    try {
      if (/^https?:\/\//i.test(raw)) return new URL(raw);
      const host = headers["host"];
      if (!host) return null;
      const proto = (headers["x-forwarded-proto"] as string) || "http:";
      const prefix = proto.endsWith(":") ? proto : `${proto}:`;
      return new URL(`${prefix}//${host}${raw.startsWith("/") ? raw : `/${raw}`}`);
    } catch { return null; }
  }

  private dialTunnel(clientSocket: Duplex, authority: string, head: Buffer): void {
    const parsed = parseAuthority(authority);
    if (!parsed) {
      const clientAddr = (clientSocket as unknown as net.Socket).remoteAddress ?? "unknown";
      this.log.warn(`[tls] bad authority ${clientAddr} -> ${authority}`);
      clientSocket.write(HTTP_400_BAD_REQUEST);
      clientSocket.destroy();
      return;
    }

    const timeout = this.options.upstreamTimeout as number;
    tunnelConnect({
      clientSocket,
      hostname: parsed.hostname,
      port: parsed.port,
      head,
      timeout,
      log: this.log,
      logPrefix: "tunnel",
    });
  }
}

export function createTlsProxy(options?: ProxyOptions): TlsProxy {
  return new TlsProxy(options);
}
