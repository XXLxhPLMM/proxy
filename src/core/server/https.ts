/**
 * HTTPS 代理 - 直持 https.Server，复用 HttpProxy 逻辑
 * 差异仅 doStart：先 loadCerts 加载 key/cert/ca，再建 TLS 服；
 * 建服后复用父类 bindServer（如 request/connect/upgrade + 407 逻辑）
 * 配了 tlsCa 即强制校验客户端证书（mTLS），握手失败经 tlsClientError 落 warn
 */

import https from "node:https";
import type { ProxyOptions } from "@/core/types/proxy.js";
import { HttpProxy } from "./http.js";
import { listenAsync } from "./base.js";
import { loadCerts, tlsServerOptions } from "@/utils/tls/index.js";
import { bindTlsClientError } from "./tls-alarm.js";

/**
 * HTTPS 代理实现：继承 HttpProxy，仅重写建服
 * 关服/isRunning/鉴权/转发链路全部复用父类
 */
export class HttpsProxy extends HttpProxy {
  /**
   * 构造 HTTPS 代理
   * @param options - 监听选项与必填配置访问器，tls 字段用于建服时加载证书
   */
  constructor(options: ProxyOptions) {
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
      certs = loadCerts(this.options.tls, this.log, this.protocol);
    } catch (e) {
      const err = new Error(`HTTPS 证书加载失败: ${(e as Error).message}`);
      this.emit("serverError", {
        error: err,
        host: this.options.host,
        port: this.options.port,
      });
      throw err;
    }

    // options 组装（含 ca 即 mTLS 的 requestCert/rejectUnauthorized 同源置位）收敛在
    // utils/tls，握手告警接线收敛在 core/server/tls-alarm.ts，与 TLS SOCKS 分支共用一份实现
    const server = https.createServer(tlsServerOptions(certs));
    bindTlsClientError(server, this.log, this.protocol);

    this.bindServer(server as unknown as import("node:http").Server);

    await listenAsync(server, this.options.port, this.options.host);

    this.server = server as unknown as import("node:http").Server;
  }
}

/**
 * 快捷构造 HTTPS 代理（免 new）
 * @param options - 同 HttpsProxy 构造选项，必须显式提供配置访问器
 * @returns 未启动的 HttpsProxy 实例
 */
export function createHttpsProxy(options: ProxyOptions): HttpsProxy {
  return new HttpsProxy(options);
}
