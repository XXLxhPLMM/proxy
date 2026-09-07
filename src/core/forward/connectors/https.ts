/**
 * connectors/https - TLS 加密上游拨号（HttpsUpstreamConnector，https 上游代理 / https 源站直连）
 * 与 http.ts 对称：tls.connect（secureConnect 才算建链成功）+ 基类 guardDialing；证书默认走系统 CA
 * 本层零日志
 */

import tls from "node:tls";
import type { Duplex } from "node:stream";
import { BaseUpstreamConnector } from "./base.js";

export class HttpsUpstreamConnector extends BaseUpstreamConnector {
  readonly protocol = "https" as const;

  protected open(host: string, port: number, onConnected: () => void): Duplex {
    return tls.connect(port, host, { servername: host }, onConnected);
  }
}
