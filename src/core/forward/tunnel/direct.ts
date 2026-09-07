/**
 * tunnel/direct - 直拨隧道（server 模式）
 * 流程：net.connect → 200 → head 透传 → bridgeSockets
 * 复用 connectors/base 的 tunnelConnect（零日志，事件经 onEvent 上抛）
 */

import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import { tunnelConnect } from "../connectors/base.js";
import type { PipeEventSink } from "@/core/types/pipe.js";
import type { HelperEventSink } from "@/core/proxy-helpers.js";
import type { TunnelHandler } from "./types.js";

export const directTunnelHandler: TunnelHandler = {
  connect(clientSocket: Duplex, hostname: string, port: number, head: Buffer, onEvent?: PipeEventSink) {
    tunnelConnect({
      clientSocket,
      hostname,
      port,
      head,
      timeout: get("upstreamTimeout"),
      logPrefix: "tunnel",
      onEvent: onEvent as unknown as HelperEventSink,
    });
  },
};
