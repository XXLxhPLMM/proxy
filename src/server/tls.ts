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
import { BaseProxy } from "@/core/base.js";
import type { ProxyOptions } from "@/core/types.js";
import { getLogger } from "@/utils/logger.js";
import { loadCerts, extractTlsPaths } from "@/utils/cert.js";
import {
  BODY_BAD_REQUEST,
  CRLF,
  DOUBLE_CRLF,
  HEADER_NAME_PROXY_AUTHENTICATE,
  HEADER_PROXY_AUTHENTICATE,
  HTTP_400_BAD_REQUEST,
  HTTP_407_PROXY_AUTH_REQUIRED,
  REASON_BAD_GATEWAY,
  REASON_BAD_REQUEST,
  REASON_GATEWAY_TIMEOUT,
  REASON_PROXY_AUTH_REQUIRED,
  RE_CONNECT,
  RE_HTTP_METHOD,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_GATEWAY_TIMEOUT,
  STATUS_LINE_PREFIX,
  STATUS_PROXY_AUTH_REQUIRED,
} from "@/utils/constants.js";
import {
  parseAuthority,
  sanitizeHeaders,
  tunnelConnect,
} from "@/utils/proxy-helpers.js";

/**
 * TLS/mTLS 透传代理实现
 * 监听形态：tls.createServer 直接监听端口，客户端先完成 TLS 握手（可选出示客户端证书 = mTLS）
 * 应用层语义：握手后的明文流按 HTTP 代理语法解析——CONNECT 走隧道透传，普通方法走 HTTP 转发；
 *             与 http 协议的区别仅在于「外层多了一层 TLS」，故需手写报文解析而非复用 http.Server
 */
export class TlsProxy extends BaseProxy {
  protected readonly log = getLogger("TlsProxy");

  constructor(options: ProxyOptions = {}) {
    super("tls", options);
  }

  /** 缓存的证书，onBeforeStart 预加载，doStart 兜底再加载 */
  private certs?: { key: Buffer; cert: Buffer; ca?: Buffer };

  /** 启动前置钩子：加载服务端 key/cert 与可选 CA（CA 用于校验客户端证书） */
  async onBeforeStart(): Promise<void> {
    if (!this.options.isWorker) {
      this.log.info(`[lifecycle] tls loading certs key=${this.options.tls?.key} cert=${this.options.tls?.cert} ca=${this.options.tls?.ca}`);
    }
    this.certs = loadCerts(extractTlsPaths(this.options.tls), this.log, "TLS");
  }

  /** 启动后置钩子：输出运行态日志 */
  async onStarted(): Promise<void> {
    if (!this.options.isWorker) {
      this.log.info(`[lifecycle] tls started ${this.options.host}:${this.options.port} state=${this.state}`);
    }
  }

  /**
   * 真实建服：tls.createServer 监听
   * requestCert=true + rejectUnauthorized=false 的组合 = 「软 mTLS」：
   *   要求客户端出示证书，但不因证书无效而中断握手，校验结果记在 TLSSocket.authorized，
   *   由 handleConnection 决定如何审计与放行，便于先观察再收紧策略
   */
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

  /** 真实关服：委托基类优雅 close */
  protected async doStop(): Promise<void> {
    await this.stopServer();
  }

  isRunning(): boolean {
    return !!this.server?.listening;
  }

  /**
   * 单条 TLS 连接处理
   * 1) 记录 mTLS 审计（authorized true/false）
   * 2) 缓冲首包直到出现 \r\n\r\n（HTTP 头结束），手写解析请求行与头部
   * 3) 按首行分发：CONNECT -> 鉴权 + dialTunnel 透传；GET 等方法 -> 鉴权 + forwardHttpOverTls；
   *    两者都不匹配 -> 回 400 断开
   * 注意：此处是裸 TLS 流，没有 http.Server 帮忙解析，因此请求头需逐行手工拆解
   */
  private handleConnection(clientSocket: Duplex): void {
    const tlsSocket = clientSocket as unknown as tls.TLSSocket;
    const clientAddr = (tlsSocket.remoteAddress ?? "unknown") as string;
    const authorized = (tlsSocket as unknown as { authorized?: boolean }).authorized;

    // mTLS 审计：仅记录证书校验结果，不在此处直接拒绝（策略见 doStart 的软 mTLS 说明）
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
      if (idx === -1) return; // HTTP 头未收齐，继续等待

      // 头已完整：摘掉本监听器，后续字节流交给隧道 pipe 或 HTTP 转发逻辑
      clientSocket.off("data", onData);
      const header = head.subarray(0, idx).toString();
      const rest = head.subarray(idx + DOUBLE_CRLF.length); // 头后已到达的 body / TLS 首包，需一并透传
      const lines = header.split(CRLF);
      const firstLine = lines[0] ?? "";
      const connectMatch = firstLine.match(RE_CONNECT);
      // 逐行拆解 "Key: Value" 头部，key 统一小写便于后续查找
      const headers: Record<string, string> = {};
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const sep = line.indexOf(":");
        if (sep === -1) continue;
        const k = line.slice(0, sep).trim().toLowerCase();
        const v = line.slice(sep + 1).trim();
        if (k) headers[k] = v;
      }
      this.log.debug(() => `[tls] headers ${clientAddr} -> ${firstLine} ${JSON.stringify(headers)}`);
      // CONNECT host:port HTTP/1.1 -> 隧道模式：鉴权后双向透传原始 TCP
      if (connectMatch) {
        const authority = connectMatch[1];
        this.log.info(`[tunnel-tls] ${clientAddr} -> ${authority} CONNECT`);
        // 构造伪 IncomingMessage 以复用统一 Auth（其 extractor 依赖 headers/url 字段）
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
      // GET/POST... 绝对或相对 URL -> 明文 HTTP 转发模式（在 TLS 通道内）
      const httpMatch = firstLine.match(RE_HTTP_METHOD);
      if (httpMatch) {
        const method = httpMatch[1];
        const rawUrl = httpMatch[2];
        const fakeReq = { method, url: rawUrl, headers, socket: clientSocket } as unknown as import("node:http").IncomingMessage;
        const authority = (headers["host"] as string) ?? rawUrl;
        this.authorize({ protocol: this.protocol, req: fakeReq, socket: clientSocket, authority }).then((passed) => {
          if (!passed) {
            // 手写 407 完整响应（含 Content-Length），因为此层无 ServerResponse 可用
            clientSocket.write(
              `${STATUS_LINE_PREFIX}${STATUS_PROXY_AUTH_REQUIRED} ${REASON_PROXY_AUTH_REQUIRED}${CRLF}${HEADER_NAME_PROXY_AUTHENTICATE}: ${HEADER_PROXY_AUTHENTICATE}${CRLF}Content-Length: ${Buffer.byteLength(REASON_PROXY_AUTH_REQUIRED)}${DOUBLE_CRLF}${REASON_PROXY_AUTH_REQUIRED}`,
            );
            clientSocket.destroy();
            return;
          }
          this.forwardHttpOverTls(clientSocket, method, rawUrl, headers, rest);
        });
        return;
      }
      // 既非 CONNECT 也非已知方法：非法请求行
      this.log.warn(`[tls] bad header ${clientAddr} -> ${firstLine}`);
      clientSocket.write(HTTP_400_BAD_REQUEST);
      clientSocket.destroy();
      return;
    };
    clientSocket.on("data", onData);

    // 首包超时保护：TLS 握手后迟迟不发完整 HTTP 头则断开
    const timeout = this.options.upstreamTimeout as number;
    if (timeout > 0) {
      (clientSocket as unknown as net.Socket).setTimeout(timeout, () => {
        this.log.warn(`[tls] client timeout ${clientAddr} after ${timeout}ms`);
        clientSocket.destroy();
      });
    }
  }

  /**
   * TLS 通道内的明文 HTTP 转发
   * 流程：解析目标 URL -> 清洗 hop-by-hop 头 -> http.request 上游 -> 手写状态行/响应头回写客户端 -> 流式透传 body
   * 与 core/http-pipe.ts 的 forwardHttp 等价，差别在于对端不是 ServerResponse 而是裸 socket，
   * 因此响应头需逐行拼接字符串写回，且错误/超时路径要自行构造完整 HTTP 报文
   */
  private forwardHttpOverTls(clientSocket: Duplex, method: string, rawUrl: string, headers: Record<string, string>, head: Buffer): void {
    const clientAddr = (clientSocket as unknown as net.Socket).remoteAddress ?? "unknown";

    const targetUrl = this.resolveTargetUrlFromParts(rawUrl, headers);
    if (!targetUrl) {
      this.log.warn(`[tls-http] bad url ${clientAddr} -> ${rawUrl}`);
      clientSocket.write(`${STATUS_LINE_PREFIX}${STATUS_BAD_REQUEST} ${REASON_BAD_REQUEST}${CRLF}Content-Length: ${Buffer.byteLength(BODY_BAD_REQUEST)}${DOUBLE_CRLF}${BODY_BAD_REQUEST}`);
      clientSocket.destroy();
      return;
    }
    this.log.info(`[tls-http] ${clientAddr} -> ${targetUrl.host} ${method} ${targetUrl.pathname}${targetUrl.search}`);

    // 清洗 proxy-connection/proxy-authorization 等逐跳头后向上游发起请求
    const fwdHeaders = sanitizeHeaders(headers);
    const proxyReq = http.request(
      { hostname: targetUrl.hostname, port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80), method, path: targetUrl.pathname + targetUrl.search, headers: fwdHeaders },
      (proxyRes) => {
        // 上游响应 -> 手写状态行 + 头部块 + 空行，再 pipe body（多行头以 \r\n 分隔，末尾 CRLF 即空行）
        const statusLine = `${STATUS_LINE_PREFIX}${proxyRes.statusCode ?? STATUS_BAD_GATEWAY} ${proxyRes.statusMessage ?? ""}${CRLF}`;
        let headerBlock = "";
        for (const [k, v] of Object.entries(proxyRes.headers)) headerBlock += `${k}: ${Array.isArray(v) ? v.join(", ") : v}${CRLF}`;
        clientSocket.write(statusLine + headerBlock + CRLF);
        proxyRes.pipe(clientSocket as unknown as NodeJS.WritableStream as never);
      },
    );
    const timeout = this.options.upstreamTimeout as number;
    // 上游超时：销毁请求并回 504（socket 可能已关，写入失败静默忽略）
    if (timeout > 0) proxyReq.setTimeout(timeout, () => {
      this.log.warn(`[tls-http] upstream timeout ${clientAddr} -> ${targetUrl.host}`);
      proxyReq.destroy();
      try { clientSocket.write(`${STATUS_LINE_PREFIX}${STATUS_GATEWAY_TIMEOUT} ${REASON_GATEWAY_TIMEOUT}${CRLF}Content-Length: ${Buffer.byteLength(REASON_GATEWAY_TIMEOUT)}${DOUBLE_CRLF}${REASON_GATEWAY_TIMEOUT}`); } catch { void 0; }
      clientSocket.destroy();
    });
    // 上游错误：timeout 引发的 error 已由上方 504 处理，此处仅回 502
    proxyReq.on("error", (err) => {
      if ((clientSocket as unknown as { destroyed: boolean }).destroyed) return;
      if ((err as Error).message.includes("timeout")) return;
      this.log.warn(`[tls-http] upstream error ${clientAddr} -> ${targetUrl.host}:`, (err as Error).message);
      try { clientSocket.write(`${STATUS_LINE_PREFIX}${STATUS_BAD_GATEWAY} ${REASON_BAD_GATEWAY}${CRLF}Content-Length: ${Buffer.byteLength(REASON_BAD_GATEWAY)}${DOUBLE_CRLF}${REASON_BAD_GATEWAY}`); } catch { void 0; }
      clientSocket.destroy();
    });
    // 请求体透传：头后粘包先写入，之后持续转发；任一侧关闭即销毁另一侧，避免半开泄漏
    if (head.length) proxyReq.write(head);
    clientSocket.on("data", (chunk: Buffer) => proxyReq.write(chunk));
    clientSocket.on("close", () => proxyReq.destroy());
    clientSocket.on("error", () => proxyReq.destroy());
    proxyReq.on("close", () => { try { clientSocket.destroy(); } catch {} });
  }

  /**
   * 从请求行 URL 与头部重建完整目标 URL
   * - absolute-form（http://host/path）直接解析
   * - origin-form（/path）借 Host 头补全；协议取 x-forwarded-proto，缺省 http:
   */
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

  /**
   * CONNECT 隧道拨号：解析 host:port 后交给公共 tunnelConnect 完成
   * 「net.connect -> 回 200 -> 双向 pipe」的统一流程（含超时/错误清理）
   */
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
