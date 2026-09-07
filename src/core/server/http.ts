/**
 * HTTP 代理 - 直持 http.Server，鉴权后委派 forward/*
 */

import http from "node:http";
import type { Duplex } from "node:stream";
import { BaseProxy } from "@/core/server/base.js";
import { forwardHttp } from "@/core/forward/http.js";
import { forwardTunnel } from "@/core/forward/tunnel.js";
import { forwardUpgrade } from "@/core/forward/websocket.js";
import type { PipeEvent } from "@/core/types/pipe.js";
import type { ProxyOptions, ProxyProtocol } from "@/core/types/proxy.js";
import { HTTP_400_BAD_REQUEST } from "@/utils/constants.js";
import { getAuthority } from "@/utils/ip.js";
import {
  HEADER_NAME_PROXY_AUTHENTICATE,
  HEADER_PROXY_AUTHENTICATE,
  HTTP_407_PROXY_AUTH_REQUIRED,
  REASON_PROXY_AUTH_REQUIRED,
  STATUS_PROXY_AUTH_REQUIRED,
} from "@/utils/constants.js";

export class HttpProxy extends BaseProxy {
  protected server: http.Server | null = null;

  constructor(options: ProxyOptions = {}, protocol: ProxyProtocol = "http") {
    super(protocol, options);
  }

  private pipeSink = (e: PipeEvent): void => {
    this.emit("pipe", e);
  };

  protected async doStart(): Promise<void> {
    const server = http.createServer();
    this.bindServer(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", reject);
        resolve();
      });
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

  protected bindServer(server: http.Server): void {
    server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
      void this.handleForward("http", req, req.socket as unknown as Duplex, res, () =>
        forwardHttp(req, res, this.pipeSink),
      );
    });
    server.on("connect", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.handleForward("tunnel", req, socket, socket, () =>
        forwardTunnel(req, socket, head, this.pipeSink),
      );
    });
    server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.handleForward("upgrade", req, socket, socket, () =>
        forwardUpgrade(req, socket, head, this.pipeSink),
      );
    });
    server.on("error", (err: Error) => {
      this.setState("error");
      this.emit("serverError", { error: err, host: this.options.host, port: this.options.port });
    });
    server.on("clientError", (err: Error, socket: Duplex) => {
      this.emit("clientError", { error: err });
      try { (socket as Duplex).end(HTTP_400_BAD_REQUEST); } catch {}
    });
    server.on("close", () => this.emit("close"));
    server.on("listening", () => this.emit("listening", { host: this.options.host, port: this.options.port }));
  }

  private async handleForward(
    kind: "http" | "tunnel" | "upgrade",
    req: http.IncomingMessage,
    socket: Duplex,
    rejectTarget: http.ServerResponse | Duplex,
    forward: () => void,
  ): Promise<void> {
    try {
      if (!(await this.authorizeOrReject(req, socket, rejectTarget))) return;
      this.emit("forward", { kind, req });
      forward();
    } catch (err) {
      this.emit("forwardError", { kind, error: err });
    }
  }

  protected writeAuthRejected(target: http.ServerResponse | Duplex): void {
    if ("writeHead" in target) {
      target.writeHead(STATUS_PROXY_AUTH_REQUIRED, { [HEADER_NAME_PROXY_AUTHENTICATE]: HEADER_PROXY_AUTHENTICATE });
      target.end(REASON_PROXY_AUTH_REQUIRED);
    } else {
      target.end(HTTP_407_PROXY_AUTH_REQUIRED);
    }
  }

  protected async authorizeOrReject(
    req: http.IncomingMessage,
    socket: Duplex,
    rejectTarget: http.ServerResponse | Duplex,
  ): Promise<boolean> {
    const passed = await this.authorize({
      protocol: this.protocol,
      req,
      socket,
      authority: getAuthority(req),
    });
    if (!passed) this.writeAuthRejected(rejectTarget);
    return passed;
  }
}

export function createHttpProxy(options?: ProxyOptions): HttpProxy {
  return new HttpProxy(options);
}
