/**
 * connectors/tls - 原生 TLS 透传上游拨号（mTLS / tls 上游代理）
 * 与 https.ts 区别：允许调用方透传 key/cert/ca（mTLS），不强制 servername 校验以外的 http 语义
 * 本层零日志
 */

import tls from "node:tls";
import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import { guardDialing } from "@/utils/proxy-helpers.js";
import type { DialGuardOptions } from "@/utils/proxy-helpers.js";
import type { DialCallback } from "@/core/types/connector.js";

export interface TlsUpstreamOptions {
  key?: string | Buffer;
  cert?: string | Buffer;
  ca?: string | Buffer;
  rejectUnauthorized?: boolean;
}

export function dialTlsUpstream(
  clientSocket: Duplex,
  host: string,
  port: number,
  onConnect: DialCallback,
  guardOpts?: DialGuardOptions,
  tlsOpts?: TlsUpstreamOptions,
): void {
  const upstreamSocket = tls.connect(port, host, { servername: host, ...tlsOpts }, () => {
    onConnect(upstreamSocket as unknown as Duplex, dial);
  });
  const dial = guardDialing(clientSocket, upstreamSocket as unknown as Duplex, {
    timeout: get("upstreamTimeout"),
    target: `${host}:${port}`,
    ...guardOpts,
  });
}
