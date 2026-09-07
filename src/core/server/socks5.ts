/**
 * SOCKS5 明文 - net
 */

import net from "node:net";
import type { Duplex } from "node:stream";
import { BaseProxy } from "@/core/server/base.js";
import type { ProxyOptions } from "@/core/types/proxy.js";

export class Socks5Proxy extends BaseProxy {
  protected server: net.Server | null = null;

  constructor(options: ProxyOptions = {}) {
    super("socks5", options);
  }

  protected async doStart(): Promise<void> {
    const server = net.createServer((socket) => this.handleConnection(socket as unknown as Duplex));
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
