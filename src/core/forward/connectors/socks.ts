/**
 * connectors/socks - SOCKS5 上游拨号（占位）
 * TODO: 实现 SOCKS5 握手（CONNECT + 账密），再经 guardDialing 接管
 * 先抛错，避免静默走明文造成误解
 */

import type { Duplex } from "node:stream";
import type { DialGuardOptions } from "@/utils/proxy-helpers.js";
import type { DialResult } from "@/core/types/connector.js";

export function dialSocksUpstream(
  _clientSocket: Duplex,
  host: string,
  port: number,
  _guardOpts?: DialGuardOptions,
): Promise<DialResult> {
  void _clientSocket;
  void _guardOpts;
  return Promise.reject(new Error(`[socks] upstream dial not implemented: ${host}:${port}`));
}
