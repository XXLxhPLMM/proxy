/**
 * HTTPS 代理核心 - 基于 HttpsServer + HttpPipe 实现
 * 职责：
 * - 继承 HttpProxy，复用鉴权 + 钩子 + 生命周期
 * - 仅将 doStart 中的 server 替换为 HttpsServer
 */

import { HttpsServer } from "../core/https-server.js";
import type { ProxyOptions } from "../core/types.js";
import { HttpProxy } from "./http.js";

/**
 * HTTPS 代理实现类
 * 继承 HttpProxy，复用一切逻辑，仅替换 server 类型
 */
export class HttpsProxy extends HttpProxy {
  constructor(options: ProxyOptions = {}) {
    super(options);
  }

  protected override async doStart(): Promise<void> {
    this.proxyServer = new HttpsServer({
      host: this.options.host as string,
      port: this.options.port as number,
      tls: {
        key: this.options.tls?.key as string,
        cert: this.options.tls?.cert as string,
        passphrase: this.options.tls?.passphrase as string,
      },
    });

    this.setupHooks();
    await this.proxyServer.start();
    this.server = this.proxyServer as unknown as import("node:http").Server;
  }
}

export function createHttpsProxy(options?: ProxyOptions): HttpsProxy {
  return new HttpsProxy(options);
}
