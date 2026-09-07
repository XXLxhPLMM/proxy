/**
 * TLS 加密服务
 * 通用 tls 传输（socks over tls 等复用），持有裸 tls.Server，生命周期/鉴权由 BaseProxy 提供
 */

import tls from "node:tls";
import type { Duplex } from "node:stream";
import { BaseProxy } from "./base.js";
import type { ProxyOptions } from "../types/proxy.js";
import { getLogger } from "@/utils/logger.js";
import { loadCerts, type LoadedTlsCerts } from "@/utils/cert.js";

export type TlsServerOptions = ProxyOptions;

export class TlsServer extends BaseProxy {
  protected readonly log = getLogger("TlsServer");
  protected server: tls.Server | null = null;
  private certs?: LoadedTlsCerts;

  constructor(options?: ProxyOptions) {
    super("socks", options);
  }

  async onBeforeStart(): Promise<void> {
    if (!this.options.isWorker) {
      this.log.info(`[lifecycle] tls loading certs key=${this.options.tls?.key} cert=${this.options.tls?.cert} ca=${this.options.tls?.ca}`);
    }
    this.certs = loadCerts(this.options.tls, this.log, "TLS");
  }

  protected async doStart(): Promise<void> {
    if (!this.certs) this.certs = loadCerts(this.options.tls, this.log, "TLS");
    const { key, cert, ca } = this.certs;
    const passphrase = (this.options.tls?.passphrase as string) || undefined;
    const server = tls.createServer(
      { key, cert, passphrase, ca: ca ? [ca] : undefined, requestCert: false, rejectUnauthorized: false },
      (socket) => this.handleConnection(socket as unknown as Duplex),
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (err: Error) => {
      this.setState("error");
      this.log.error(`server error (${this.options.host}:${this.options.port}):`, err);
    });
    server.on("tlsClientError", () => {});
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

  protected handleConnection(socket: Duplex): void {
    (socket as unknown as Duplex).destroy();
  }
}
