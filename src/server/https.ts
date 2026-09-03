/**
 * HTTPS 代理核心 - 基于 HttpsServer + HttpPipe 实现
 * 职责：
 * - 继承 HttpProxy，复用鉴权 + 钩子 + 生命周期
 * - 仅将 doStart 中的 server 替换为 HttpsServer
 * 注意：本层零日志，证书失败转抛 serverError 事件后重抛，由 ProxyServer 记日志
 */

import { HttpsServer } from "@/core/http-server.js";
import type { ProxyOptions } from "@/core/types.js";
import type { ProxyServerErrorEvent } from "@/core/types.js";
import { HttpProxy } from "./http.js";

/**
 * HTTPS 代理实现类
 * 继承 HttpProxy，复用一切逻辑，仅替换 server 类型
 */
export class HttpsProxy extends HttpProxy {
  constructor(options: ProxyOptions = {}) {
    super(options, "https");
  }

  protected override async doStart(): Promise<void> {
    try {
      this.proxyServer = new HttpsServer();
    } catch (e) {
      this.emit("serverError", {
        error: e as Error,
        host: this.options.host,
        port: this.options.port,
      } satisfies ProxyServerErrorEvent);
      throw e;
    }

    this.setupHooks();
    await this.proxyServer.start();
  }
}

export function createHttpsProxy(options?: ProxyOptions): HttpsProxy {
  return new HttpsProxy(options);
}
