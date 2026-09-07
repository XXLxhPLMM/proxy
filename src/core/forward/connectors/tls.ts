/**
 * connectors/tls - 原生 TLS 透传上游拨号（TlsUpstreamConnector，mTLS / tls 上游代理）
 * 与 https.ts 区别：允许调用方透传 key/cert/ca（mTLS，构造期注入），不强制 servername 校验以外的 http 语义
 * 本层零日志
 */

import tls from "node:tls";
import type { Duplex } from "node:stream";
import { BaseUpstreamConnector } from "./base.js";

export interface TlsUpstreamOptions {
  key?: string | Buffer;
  cert?: string | Buffer;
  ca?: string | Buffer;
  rejectUnauthorized?: boolean;
}

export class TlsUpstreamConnector extends BaseUpstreamConnector {
  readonly protocol = "tls" as const;

  constructor(private readonly tlsOpts: TlsUpstreamOptions = {}) {
    super();
  }

  protected open(host: string, port: number, onConnected: () => void): Duplex {
    return tls.connect(port, host, { servername: host, ...this.tlsOpts }, onConnected);
  }
}
