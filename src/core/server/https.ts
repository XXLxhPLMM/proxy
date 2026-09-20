/**
 * HTTPS 代理 - 直持 https.Server，复用 HttpProxy 逻辑
 * 差异仅 doStart：先 loadCerts 加载 key/cert/ca，再建 TLS 服；
 * 建服后复用父类 bindServer（如 request/connect/upgrade + 407 逻辑）
 * 配了 tlsCa 即强制校验客户端证书（mTLS），握手失败经 tlsClientError 落 warn
 */

import https from "node:https";
import type { ProxyOptions } from "@/core/types/proxy.js";
import { HttpProxy } from "./http.js";
import { loadCerts, requiresClientCert } from "@/utils/cert.js";
import { listenAsync } from "@/utils/net.js";
import { getLogger } from "@/utils/logger.js";
import { logTlsClientError } from "@/server/log/events-log.js";

/**
 * HTTPS 代理实现：继承 HttpProxy，仅重写建服
 * 关服/isRunning/鉴权/转发链路全部复用父类
 */
export class HttpsProxy extends HttpProxy {
  /** 日志器：TLS 层事件（握手失败）以协议名为前缀，与 SOCKS 分支一致 */
  protected override readonly log = getLogger(this.protocol);

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

    // ca 非空 ⇒ 强制客户端证书：只置 requestCert 不置 rejectUnauthorized 等于白要一张证书（不校验即放行）
    const mTLS = requiresClientCert(certs);

    const server = https.createServer({
      key: certs.key,
      cert: certs.cert,
      ca: certs.ca ? [certs.ca] : undefined,
      passphrase: certs.passphrase,
      requestCert: mTLS,
      rejectUnauthorized: mTLS,
    });

    // 握手失败（含 mTLS 拒绝、非 TLS 客户端打到本端口）此前完全无痕，落 warn 便于定位「为什么连不上」
    server.on("tlsClientError", (err: Error, socket) => {
      logTlsClientError(this.log, `${this.protocol} 客户端 TLS 握手失败`, err, {
        code: (err as NodeJS.ErrnoException).code,
        authorizationError: socket?.authorizationError,
      });
    });

    this.bindServer(server as unknown as import("node:http").Server);

    await listenAsync(server, this.options.port, this.options.host);

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
