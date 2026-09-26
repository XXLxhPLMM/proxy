/**
 * HTTPS 代理 - 直持 https.Server，复用 HttpProxy 逻辑
 * 差异仅 doStart：先 loadCerts 加载 key/cert/ca，再建 TLS 服；
 * 建服后复用父类 bindServer（如 request/connect/upgrade + 闸门 407/403 逻辑）
 * 配了 tlsCa 即强制校验客户端证书（mTLS），握手失败经 tlsClientError 落 warn
 * 依赖全部来自基类的 `ProtocolDeps`（鉴权/名单/配置/路由/转发器注册表）与 `deps.logger`
 * 派生的实例级日志器（core 零日志：日志器只注入 utils 的打印入口）
 */

import https from "node:https";
import type { ProxyOptions } from "@/core/types/proxy.js";
import { HttpProxy } from "./http.js";
import { bindTlsClientError, loadCerts, tlsServerOptions } from "@/utils/net/tls.js";
import { listenAsync } from "@/utils/net/listen.js";
import type { ProtocolDeps } from "@/plugins/contracts.js";

/**
 * HTTPS 代理实现：继承 HttpProxy，仅重写建服
 * 关服/isRunning/鉴权/名单/转发链路全部复用父类
 */
export class HttpsProxy extends HttpProxy {
  /**
   * 构造 HTTPS 代理
   * @param options - 监听选项，tls 字段（key/cert/ca/passphrase）用于建服时加载证书
   * @param deps - 本实例能力插件（由 `ProtocolProvider` 注入）
   */
  constructor(options: ProxyOptions = {}, deps: ProtocolDeps) {
    super(options, deps, "https");
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

    // options 组装（含 ca 即 mTLS 的 requestCert/rejectUnauthorized 同源置位）与
    // tlsClientError 告警接线收敛在 utils/net/tls.ts，与 TLS SOCKS 分支共用一份实现；
    // 传入的 `this.log` 是本实例的协议级子日志器（不落进程级 logger）
    const server = https.createServer(tlsServerOptions(certs));
    bindTlsClientError(server, this.log, this.protocol);

    this.bindServer(server as unknown as import("node:http").Server);

    await listenAsync(server, this.options.port, this.options.host);

    this.server = server as unknown as import("node:http").Server;
  }
}
