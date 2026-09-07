/**
 * tunnel/socks - SOCKS 上游隧道（占位）
 * 真实 SOCKS5 需实现 VER/NMETHODS → CONNECT 帧握手，当前保持 502 语义由上层处理
 * 此 handler 保留载体位，后续补 socks 握手后同样 bridgeSockets
 */

import type { Duplex } from "node:stream";
import { HTTP_502_BAD_GATEWAY } from "@/utils/constants.js";
import type { PipeEventSink } from "@/core/types/pipe.js";
import type { TunnelHandler } from "./types.js";

export const socksTunnelHandler: TunnelHandler = {
  connect(clientSocket: Duplex, _hostname: string, _port: number, _head: Buffer, onEvent?: PipeEventSink) {
    onEvent?.({ type: "debug", message: "[tunnel] socks upstream not implemented" } as unknown as Parameters<NonNullable<PipeEventSink>>[0]);
    try {
      if ((clientSocket as unknown as { writable: boolean }).writable) clientSocket.write(HTTP_502_BAD_GATEWAY);
    } catch {}
    clientSocket.destroy();
  },
};
