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
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";
import { BaseProxy } from "./base.js";
import type { ProxyOptions } from "./types.js";
import { get } from "../config/store.js";
import { getLogger } from "../utils/logger.js";
import {
  HTTP_200_CONNECTION_ESTABLISHED,
  HTTP_400_BAD_REQUEST,
  HTTP_407_PROXY_AUTH_REQUIRED,
  HTTP_504_GATEWAY_TIMEOUT,
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
    const server = tls.createServer(
      {
        key,
        cert,
        ca: ca ? [ca] : undefined,
        requestCert: true,
        rejectUnauthorized: false, // 握手层不直接拒绝，业务层按需校验并日志
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
      const header = head.subarray(0, idx).toString(); // 头部字符串
      const rest = head.subarray(idx + 4); // 头后粘包数据（如 TLS ClientHello 剩余）
      const firstLine = header.split("\r\n")[0] ?? ""; // 首行如 CONNECT example.com:443 HTTP/1.1
      const m = firstLine.match(/^CONNECT\s+(\S+)\s+HTTP\/\d/); // 严格匹配 CONNECT authority
      if (!m) {
        this.log.warn(`[tls] bad header ${clientAddr} -> ${firstLine}`); // 非 CONNECT 视为非法
        clientSocket.write(HTTP_400_BAD_REQUEST);
        clientSocket.destroy();
        return;
      }
      const authority = m[1]; // 提取 host:port
      this.log.info(`[tunnel-tls] ${clientAddr} -> ${authority} CONNECT`);
      // 鉴权：复用 BaseProxy.authorize，构造最小 IncomingMessage 以复用 TokenExtractor 链
      const fakeReq = { url: authority, headers: {}, socket: clientSocket } as unknown as import("node:http").IncomingMessage;
      // 由 Auth 集中输出 [auth] 日志，此处仅处理结果
      this.authorize({ protocol: this.protocol, req: fakeReq, socket: clientSocket, authority }).then((passed) => {
        if (!passed) {
          clientSocket.write(HTTP_407_PROXY_AUTH_REQUIRED);
          clientSocket.destroy();
          return;
        }
        this.dialTunnel(clientSocket, authority, rest); // 鉴权通过，透传粘包 rest
      });
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
