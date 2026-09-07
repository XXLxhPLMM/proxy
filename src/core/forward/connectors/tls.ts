/**
 * connectors/tls - TLS 加密上游拨号（TlsUpstreamConnector）
 * 与 net.ts 对称：tls.connect（secureConnect 才算建链成功）+ 基类 guardDialing
 * https 上游 / tls 上游 / mTLS 同属一种 TLS 传输，差异只在构造期注入的 key/cert/ca
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
  servername?: string;
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
