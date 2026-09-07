/**
 * connectors/socks - SOCKS5 上游拨号（SocksUpstreamConnector，占位）
 * TODO: 实现 SOCKS5 握手（CONNECT + 账密），再经基类 guardDialing 接管
 * 先抛错，避免静默走明文造成误解
 */

import type { Duplex } from "node:stream";
import { BaseUpstreamConnector } from "./base.js";

export class SocksUpstreamConnector extends BaseUpstreamConnector {
  readonly protocol = "socks" as const;

  /** 永不触发：dial 已覆写为直接 reject */
  protected open(): Duplex {
    throw new Error("[socks] open not implemented");
  }

  override dial(clientSocket: Duplex, host: string, port: number): Promise<never> {
    void clientSocket;
    return Promise.reject(new Error(`[socks] upstream dial not implemented: ${host}:${port}`));
  }
}
