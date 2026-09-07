/**
 * TCP 明文服务
 * 通用 net 传输（socks over net 等复用），持有裸 net.Server，生命周期/鉴权由 BaseProxy 提供
 */

import net from "node:net";
import type { Duplex } from "node:stream";
import { BaseProxy } from "./base.js";
import type { ProxyOptions } from "../types/proxy.js";

export type TcpServerOptions = ProxyOptions;

export class NetServer extends BaseProxy {
  protected server: net.Server | null = null;

  constructor(options?: ProxyOptions) {
    super("socks", options);
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
    (socket as unknown as net.Socket).destroy();
  }
}
