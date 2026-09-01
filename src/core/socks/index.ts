/**
 * SOCKS 代理核心 - SOCKS4/4a 与 SOCKS5 over TLS（密文传输）
 * 文件职责：
 * - 继承 BaseProxy，协议固定 socks，生命周期 onBeforeStart 加载证书（store tlsKey/tlsCert/tlsCa/tlsPassphrase）
 * - doStart 以 tls.Server 监听，TLS 解密后按首字节分发至 handleSocks5/handleSocks4（实现拆至 socks5.ts/socks4.ts）
 * - 日志前缀 SocksProxy，状态机复用 BaseProxy
 * 关联：store tls* 与 auth*、socks5.ts/socks4.ts、BaseProxy 状态机
 */

import tls from "node:tls";
import net from "node:net";
import type { Duplex } from "node:stream";
import { BaseProxy } from "../base.js";
import type { ProxyOptions } from "../types.js";
import type { Auth } from "../auth.js";
import { getLogger } from "../../utils/logger.js";
import { loadCerts, extractTlsPaths } from "../../utils/cert.js";
import { handleSocks5, dialSocks5 } from "./socks5.js";
import { handleSocks4, dialSocks4 } from "./socks4.js";

export class SocksProxy extends BaseProxy {
  /** 预加载证书缓存 */
  private certs?: { key: Buffer; cert: Buffer; ca?: Buffer };
  /** 作用域日志 */
  protected readonly log = getLogger("SocksProxy");

  constructor(options: ProxyOptions = {}) { super("socks", options); }

  async onBeforeStart(): Promise<void> {
    this.log.info(`[lifecycle] socks loading certs key=${this.options.tls?.key} cert=${this.options.tls?.cert} ca=${this.options.tls?.ca}`);
    this.certs = loadCerts(extractTlsPaths(this.options.tls), this.log, "SOCKS");
  }

  async onStarted(): Promise<void> {
    this.log.info(`[lifecycle] socks started ${this.options.host}:${this.options.port} state=${this.state}`);
  }

  protected async doStart(): Promise<void> {
    if (!this.certs) this.certs = loadCerts(extractTlsPaths(this.options.tls), this.log, "SOCKS");
    const { key, cert, ca } = this.certs;
    const passphrase = (this.options.tls?.passphrase as string) || undefined;
    const server = tls.createServer({ key, cert, passphrase, ca: ca ? [ca] : undefined, requestCert: false, rejectUnauthorized: false }, (socket) => this.handleConnection(socket as unknown as Duplex));
    await this.startListening(server, this.options.port, this.options.host);
    this.attachErrorHandlers(server, "tlsClientError");
    this.server = server;
  }

  protected async doStop(): Promise<void> {
    await this.stopServer();
  }

  isRunning(): boolean { return !!this.server?.listening; }

  private handleConnection(clientSocket: Duplex): void {
    const socket = clientSocket as unknown as net.Socket;
    const clientAddr = socket.remoteAddress ?? "unknown";
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (buf.length < 1) return;
      const ver = buf[0];
      if (ver === 0x05) {
        if (buf.length < 2) return;
        const nmethods = buf[1];
        if (buf.length < 2 + nmethods) return;
        socket.off("data", onData);
        handleSocks5(clientSocket, buf, {
          authorize: (req, authority, sock) => this.authorize({ protocol: this.protocol, req: req as import("node:http").IncomingMessage, socket: sock, authority }),
          dial: (s, h, p, head) => this.dialSocks5(s, h, p, head),
          log: this.log,
          auth: this.auth as Auth,
          timeout: this.options.upstreamTimeout,
        });
      } else if (ver === 0x04) {
        if (buf.length < 9) return;
        const nul = buf.indexOf(0x00, 8);
        if (nul === -1) return;
        const ip = buf.subarray(4, 8);
        const is4a = ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] !== 0;
        if (is4a) { const domainEnd = buf.indexOf(0x00, nul + 1); if (domainEnd === -1) return; }
        socket.off("data", onData);
        handleSocks4(clientSocket, buf, { dial: (s, h, p, head) => this.dialSocks4(s, h, p, head), log: this.log, auth: this.auth as Auth, timeout: this.options.upstreamTimeout });
      } else { this.log.warn(`[socks] unknown version ${ver} from ${clientAddr}`); socket.destroy(); }
    };
    socket.on("data", onData);
    socket.on("error", (err) => this.log.warn(`[socks] client error ${clientAddr}:`, (err as Error).message));
    const timeout = this.options.upstreamTimeout as number;
    if (timeout > 0) socket.setTimeout(timeout, () => { this.log.warn(`[socks] client timeout ${clientAddr}`); socket.destroy(); });
  }

  private dialSocks5(clientSocket: Duplex, host: string, port: number, head: Buffer): void {
    dialSocks5(clientSocket, host, port, head, this.log, this.options.upstreamTimeout);
  }

  private dialSocks4(clientSocket: Duplex, host: string, port: number, head: Buffer): void {
    dialSocks4(clientSocket, host, port, head, this.log, this.options.upstreamTimeout);
  }
}

export function createSocksProxy(options?: ProxyOptions): SocksProxy { return new SocksProxy(options); }
