/**
 * TLS/mTLS 透传代理 - 原生 tls 实现
 * 文件职责：
 * - 继承 BaseProxy，协议 tls，onBeforeStart 从 store 加载 key/cert/ca（TLS_CA 可选），doStart 以 tls.createServer({requestCert,ca,rejectUnauthorized:false}) 监听
 * - 握手层不直接拒绝，handleConnection 按 TLSSocket.authorized 日志 mTLS 结果，首包缓冲解析 CONNECT authority 后走 BaseProxy.authorize 鉴权，再 dialTunnel 透传
 * - dialTunnel 与 HttpProxy 隧道一致：net.connect、粘包透传、双向 pipe、upstreamTimeout 504、error/close 双端 destroy
 * - 日志前缀 TlsProxy，状态机与常量均复用 utils/constants
 * 关联：store tlsKey/tlsCert/tlsCa、constants、BaseProxy
 */

import tls from "node:tls";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";
import { BaseProxy } from "./base.js";
import type { ProxyOptions } from "./types.js";
import { get } from "../config/store.js";
import { getLogger } from "../utils/logger.js";
import {
  BODY_BAD_GATEWAY,
  BODY_BAD_REQUEST,
  BODY_GATEWAY_TIMEOUT,
  BODY_PROXY_AUTH_REQUIRED,
  BODY_PROXY_ERROR,
  HEADER_PROXY_AUTHENTICATE,
  HTTP_200_CONNECTION_ESTABLISHED,
  HTTP_400_BAD_REQUEST,
  HTTP_407_PROXY_AUTH_REQUIRED,
  HTTP_504_GATEWAY_TIMEOUT,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_GATEWAY_TIMEOUT,
  STATUS_INTERNAL_ERROR,
  STATUS_PROXY_AUTH_REQUIRED,
} from "../utils/constants.js";

export class TlsProxy extends BaseProxy {
  private server: tls.Server | null = null;
  private readonly log = getLogger("TlsProxy");

  constructor(options: ProxyOptions = {}) {
    super("tls", options);
  }

  private certs?: { key: Buffer; cert: Buffer; ca?: Buffer };

  async onBeforeStart(): Promise<void> {
    this.log.info(`[lifecycle] tls loading certs key=${get("tlsKey")} cert=${get("tlsCert")} ca=${get("tlsCa")}`);
    this.certs = this.loadCerts();
  }

  async onStarted(): Promise<void> {
    this.log.info(`[lifecycle] tls started ${this.options.host}:${this.options.port} state=${this.state}`);
  }

  protected async doStart(): Promise<void> {
    if (!this.certs) this.certs = this.loadCerts();
    const { key, cert, ca } = this.certs;
    const passphrase = (get("tlsPassphrase") as string) || undefined;
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

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    server.on("error", (err) => {
      this.setState("error");
      this.log.error(`server error (${this.options.host}:${this.options.port}):`, err);
    });
    server.on("tlsClientError", (err, socket) => {
      this.log.warn("tlsClientError:", (err as Error).message);
      try {
        (socket as Duplex).destroy();
      } catch {}
    });

    this.server = server;
  }

  protected async doStop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  isRunning(): boolean {
    return !!this.server?.listening;
  }

  /**
   * 加载证书 - 优先从 store 读取（支持 CLI/ENV/默认值），回退为 process.cwd 相对路径
   * @returns key/cert/ca 的 Buffer
   */
  private loadCerts(): { key: Buffer; cert: Buffer; ca?: Buffer } {
    const resolvePath = (p: string): string => (path.isAbsolute(p) ? p : path.join(process.cwd(), p));
    const keyPath = resolvePath(get("tlsKey") as unknown as string);
    const certPath = resolvePath(get("tlsCert") as unknown as string);
    const caPath = resolvePath(get("tlsCa") as unknown as string);
    try {
      const key = fs.readFileSync(keyPath);
      const cert = fs.readFileSync(certPath);
      let ca: Buffer | undefined;
      try {
        ca = fs.readFileSync(caPath);
      } catch {
        // CA 可选：仅 mTLS 强校验时需要，缺失时允许握手但日志告警
      }
      return { key, cert, ca };
    } catch (e) {
      this.log.error(`TLS 证书加载失败 key=${keyPath} cert=${certPath} ca=${caPath}`, e);
      throw e;
    }
  }

  private handleConnection(clientSocket: Duplex): void {
    const tlsSocket = clientSocket as unknown as tls.TLSSocket;
    const clientAddr = (tlsSocket.remoteAddress ?? "unknown") as string;
    const authorized = (tlsSocket as unknown as { authorized?: boolean }).authorized;

    // mTLS 可选校验：有 CA 时记录是否通过，未通过仍允许透传但告警（按需可改为 destroy）
    if (authorized === false) {
      this.log.warn(`[mTLS] client cert not authorized ${clientAddr}`);
    } else if (authorized === true) {
      this.log.info(`[mTLS] client cert authorized ${clientAddr}`);
    }

    // 首包缓冲：mTLS 握手后首包为 CONNECT 明文，需完整接收后再解析
    let head = Buffer.alloc(0); // 累积首包，避免 TCP 分片导致半包
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]); // 追加本次分片
      const idx = head.indexOf("\r\n\r\n"); // 查找 HTTP 头结束标记
      if (idx === -1) return; // 头未收全，继续等待

      clientSocket.off("data", onData); // 头已完整，移除监听避免重复触发
      const header = head.subarray(0, idx).toString();
      const rest = head.subarray(idx + 4);
      const lines = header.split("\r\n");
      const firstLine = lines[0] ?? "";
      const connectMatch = firstLine.match(/^CONNECT\s+(\S+)\s+HTTP\/\d/);
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
      // 明文 HTTP over TLS：如 GET http://example.com/ （与 https 的 forwardHttp 一致，此前仅支持 CONNECT 导致 400）
      const httpMatch = firstLine.match(/^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|TRACE)\s+(\S+)\s+HTTP\/\d/);
      if (httpMatch) {
        const method = httpMatch[1];
        const rawUrl = httpMatch[2];
        const fakeReq = { method, url: rawUrl, headers, socket: clientSocket } as unknown as import("node:http").IncomingMessage;
        const authority = (headers["host"] as string) ?? rawUrl;
        this.authorize({ protocol: this.protocol, req: fakeReq, socket: clientSocket, authority }).then((passed) => {
          if (!passed) {
            clientSocket.write(
              `HTTP/1.1 ${STATUS_PROXY_AUTH_REQUIRED} Proxy Authentication Required\r\nProxy-Authenticate: ${HEADER_PROXY_AUTHENTICATE}\r\nContent-Length: ${Buffer.byteLength(BODY_PROXY_AUTH_REQUIRED)}\r\n\r\n${BODY_PROXY_AUTH_REQUIRED}`,
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
    clientSocket.on("data", onData); // 挂载首包监听

    // 单连接超时兜底：Duplex 无 setTimeout，需按 Socket 实际类型调度
    const timeout = get("upstreamTimeout") as number;
    if (timeout > 0) {
      (clientSocket as unknown as net.Socket).setTimeout(timeout, () => {
        this.log.warn(`[tls] client timeout ${clientAddr} after ${timeout}ms`);
        clientSocket.destroy();
      });
    }
  }

  private forwardHttpOverTls(clientSocket: Duplex, method: string, rawUrl: string, headers: Record<string, string>, head: Buffer): void {
    const clientAddr = (clientSocket as unknown as net.Socket).remoteAddress ?? "unknown";
    const targetUrl = this.resolveTargetUrl(rawUrl, headers);
    if (!targetUrl) {
      this.log.warn(`[tls-http] bad url ${clientAddr} -> ${rawUrl}`);
      clientSocket.write(`HTTP/1.1 ${STATUS_BAD_REQUEST} Bad Request\r\nContent-Length: ${Buffer.byteLength(BODY_BAD_REQUEST)}\r\n\r\n${BODY_BAD_REQUEST}`);
      clientSocket.destroy();
      return;
    }
    this.log.info(`[tls-http] ${clientAddr} -> ${targetUrl.host} ${method} ${targetUrl.pathname}${targetUrl.search}`);
    const fwdHeaders = { ...headers };
    delete fwdHeaders["proxy-connection"];
    delete fwdHeaders["proxy-authorization"];
    fwdHeaders["connection"] = "close";
    const proxyReq = http.request(
      { hostname: targetUrl.hostname, port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80), method, path: targetUrl.pathname + targetUrl.search, headers: fwdHeaders },
      (proxyRes) => {
        const statusLine = `HTTP/1.1 ${proxyRes.statusCode ?? 502} ${proxyRes.statusMessage ?? ""}\r\n`;
        let headerBlock = "";
        for (const [k, v] of Object.entries(proxyRes.headers)) headerBlock += `${k}: ${Array.isArray(v) ? v.join(", ") : v}\r\n`;
        clientSocket.write(statusLine + headerBlock + "\r\n");
        proxyRes.pipe(clientSocket as unknown as NodeJS.WritableStream as never);
      },
    );
    const timeout = get("upstreamTimeout") as number;
    if (timeout > 0) proxyReq.setTimeout(timeout, () => {
      this.log.warn(`[tls-http] upstream timeout ${clientAddr} -> ${targetUrl.host}`);
      proxyReq.destroy();
      try { clientSocket.write(`HTTP/1.1 ${STATUS_GATEWAY_TIMEOUT} Gateway Timeout\r\nContent-Length: ${Buffer.byteLength(BODY_GATEWAY_TIMEOUT)}\r\n\r\n${BODY_GATEWAY_TIMEOUT}`); } catch {}
      clientSocket.destroy();
    });
    proxyReq.on("error", (err) => {
      if ((clientSocket as unknown as { destroyed: boolean }).destroyed) return;
      if ((err as Error).message.includes("timeout")) return;
      this.log.warn(`[tls-http] upstream error ${clientAddr} -> ${targetUrl.host}:`, (err as Error).message);
      try { clientSocket.write(`HTTP/1.1 ${STATUS_BAD_GATEWAY} Bad Gateway\r\nContent-Length: ${Buffer.byteLength(BODY_BAD_GATEWAY)}\r\n\r\n${BODY_BAD_GATEWAY}`); } catch {}
      clientSocket.destroy();
    });
    if (head.length) proxyReq.write(head);
    clientSocket.on("data", (chunk: Buffer) => proxyReq.write(chunk));
    clientSocket.on("close", () => proxyReq.destroy());
    clientSocket.on("error", () => proxyReq.destroy());
    proxyReq.on("close", () => { try { clientSocket.destroy(); } catch {} });
  }

  private resolveTargetUrl(raw: string, headers: Record<string, string>): URL | null {
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
    const clientAddr = (clientSocket as unknown as net.Socket).remoteAddress ?? "unknown"; // 取客户端 IP 用于审计
    const [hostname, portRaw] = authority.split(":"); // 解析目标 host:port
    const port = Number(portRaw ?? 443); // 缺省 443
    if (!hostname || Number.isNaN(port)) {
      this.log.warn(`[tls] bad authority ${clientAddr} -> ${authority}`); // 非法 authority 防御
      clientSocket.write(HTTP_400_BAD_REQUEST);
      clientSocket.destroy();
      return;
    }
    this.log.info(`[tunnel] dial ${clientAddr} -> ${hostname}:${port}`); // 拨号前日志
    const serverSocket = net.connect(port, hostname, () => {
      serverSocket.setTimeout(0); // 建连成功清除超时
      this.log.info(`[tunnel] established ${clientAddr} -> ${hostname}:${port}`);
      clientSocket.write(HTTP_200_CONNECTION_ESTABLISHED); // 告知客户端隧道就绪
      if (head.length) serverSocket.write(head); // 透传粘包
      clientSocket.pipe(serverSocket); // 双向 pipe 透传
      serverSocket.pipe(clientSocket);
    });

    const timeout = get("upstreamTimeout") as number;
    let timedOut = false;
    if (timeout > 0) {
      serverSocket.setTimeout(timeout, () => {
        if (serverSocket.destroyed) return;
        timedOut = true;
        this.log.warn(`[tunnel] upstream timeout ${clientAddr} -> ${hostname}:${port} after ${timeout}ms`);
        try {
          if (!(clientSocket as unknown as { destroyed: boolean }).destroyed) {
            clientSocket.write(HTTP_504_GATEWAY_TIMEOUT);
            clientSocket.destroy();
          }
        } catch {}
        serverSocket.destroy();
      });
    }
    const destroyBoth = (): void => {
      clientSocket.destroy();
      serverSocket.destroy();
    };
    const onErr = (side: string) => (err: Error) => {
      if (timedOut) return;
      this.log.warn(`[tunnel] ${side} error ${clientAddr} -> ${hostname}:${port}:`, err.message);
      destroyBoth();
    };
    clientSocket.on("error", onErr("client"));
    serverSocket.on("error", onErr("upstream"));
    clientSocket.on("close", () => serverSocket.destroy());
    serverSocket.on("close", () => clientSocket.destroy());
  }
}

export function createTlsProxy(options?: ProxyOptions): TlsProxy {
  return new TlsProxy(options);
}
