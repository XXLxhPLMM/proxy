/**
 * SOCKSS5 加密 - tls (SOCKS5 over TLS)
 */

import tls from "node:tls";
import type { Duplex } from "node:stream";
import { BaseProxy } from "@/core/server/base.js";
import type { ProxyOptions } from "@/core/types/proxy.js";
import { getLogger } from "@/utils/logger.js";
import { loadCerts, type LoadedTlsCerts } from "@/utils/cert.js";

export class Sockss5Proxy extends BaseProxy {
  protected readonly log = getLogger("Sockss5Proxy");
  protected server: tls.Server | null = null;
  private certs?: LoadedTlsCerts;

  constructor(options: ProxyOptions = {}) {
    super("sockss5", options);
  }

  async onBeforeStart(): Promise<void> {
    if (!this.options.isWorker) this.log.info(`[lifecycle] sockss5 loading certs key=${this.options.tls?.key} cert=${this.options.tls?.cert} ca=${this.options.tls?.ca}`);
    this.certs = loadCerts(this.options.tls, this.log, "SOCKSS5");
  }

  protected async doStart(): Promise<void> {
    if (!this.certs) this.certs = loadCerts(this.options.tls, this.log, "SOCKSS5");
    const { key, cert, ca } = this.certs;
    const passphrase = (this.options.tls?.passphrase as string) || undefined;
    const server = tls.createServer({ key, cert, passphrase, ca: ca ? [ca] : undefined, requestCert: false, rejectUnauthorized: false }, (socket) => this.handleConnection(socket as unknown as Duplex));
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
    socket.once("data", (chunk: Buffer) => {
      if (chunk[0] !== 0x05) { socket.destroy(); return; }
      socket.destroy();
    });
    socket.on("error", () => socket.destroy());
  }
}
