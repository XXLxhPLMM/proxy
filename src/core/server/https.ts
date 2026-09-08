/**
 * HTTPS 代理 - 直持 https.Server，复用 HttpProxy 逻辑
 * 差异仅 doStart：先 loadCerts 加载 key/cert/ca，再建 TLS 服；
 * 建服后复用父类 bindServer（如 request/connect/upgrade + 407 逻辑）
 */

import https from "node:https";
import type { ProxyOptions } from "@/core/types/proxy.js";
import { HttpProxy } from "./http.js";
import { loadCerts } from "@/utils/cert.js";

/**
 * HTTPS 代理实现：继承 HttpProxy，仅重写建服
 * 关服/isRunning/鉴权/转发链路全部复用父类
 */
export class HttpsProxy extends HttpProxy {
  /**
   * 构造 HTTPS 代理
   * @param options - 监听选项，tls 字段（key/cert/ca/passphrase）用于建服时加载证书
   */
  constructor(options: ProxyOptions = {}) {
    super(options, "https");
  }

  /**
   * 建服：加载证书 -> 创建 https.Server -> 复用 bindServer -> listen
   * 证书缺失/非法时先发 serverError 事件再抛错，便于上层落盘
   * @throws 证书加载失败或 listen 失败（如 EADDRINUSE）时抛错
   */
  protected override async doStart(): Promise<void> {
    let certs;
    try {
      certs = loadCerts(this.options.tls);
    } catch (e) {
      const err = new Error(`HTTPS 证书加载失败: ${(e as Error).message}`);
      this.emit("serverError", {
        error: err,
        host: this.options.host,
        port: this.options.port,
      });
      throw err;
    }

    const server = https.createServer({
      key: certs.key,
      cert: certs.cert,
      ca: certs.ca ? [certs.ca] : undefined,
      passphrase: certs.passphrase,
    });

    this.bindServer(server as unknown as import("node:http").Server);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    this.server = server as unknown as import("node:http").Server;
  }
}

/**
 * 快捷构造 HTTPS 代理（免 new）
 * @param options - 同 HttpsProxy 构造选项，需含 tls 证书路径/内容
 * @returns 未启动的 HttpsProxy 实例
 */
export function createHttpsProxy(options?: ProxyOptions): HttpsProxy {
  return new HttpsProxy(options);
}
