/**
 * connectors/https - TLS 加密上游拨号（https 上游代理 / https 源站直连）
 * 与 http.ts 对称：tls.connect + guardDialing；证书默认走系统 CA
 * 本层零日志
 */

import tls from "node:tls";
import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import { guardDialing } from "@/utils/proxy-helpers.js";
import type { DialGuardOptions } from "@/utils/proxy-helpers.js";
import type { DialCallback } from "@/core/types/connector.js";

export function dialHttpsUpstream(
  clientSocket: Duplex,
  host: string,
  port: number,
  onConnect: DialCallback,
  guardOpts?: DialGuardOptions,
): void {
  const upstreamSocket = tls.connect(port, host, { servername: host }, () => {
    onConnect(upstreamSocket as unknown as Duplex, dial);
  });
  const dial = guardDialing(clientSocket, upstreamSocket as unknown as Duplex, {
    timeout: get("upstreamTimeout"),
    target: `${host}:${port}`,
    ...guardOpts,
  });
}
