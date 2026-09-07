/**
 * tunnel/tls - TLS 直连隧道（server/tls 直拨或 client 经 tls 上游）
 * server 模式：tls.connect 到 target 直建隧道
 * client 模式：需经 tls 上游（暂按直连实现，后续可复用 https 隧道 CONNECT 逻辑）
 */

import tls from "node:tls";
import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import { guardDialing, type HelperEventSink } from "@/core/proxy-helpers.js";
import type { PipeEventSink } from "@/core/types/pipe.js";
import { bridgeSockets } from "../connectors/base.js";
import { HTTP_200_CONNECTION_ESTABLISHED } from "@/utils/constants.js";
import type { TunnelHandler } from "./types.js";

export const tlsTunnelHandler: TunnelHandler = {
  connect(clientSocket: Duplex, hostname: string, port: number, head: Buffer, onEvent?: PipeEventSink) {
    const socket = tls.connect(port, hostname, { servername: hostname }, () => {
      dial.established();
      if (clientSocket.writable) clientSocket.write(HTTP_200_CONNECTION_ESTABLISHED);
      if (head.length) socket.write(head);
      bridgeSockets(clientSocket, socket as unknown as Duplex, "tunnel", onEvent as unknown as HelperEventSink);
    });
    const dial = guardDialing(clientSocket, socket as unknown as Duplex, {
      timeout: get("upstreamTimeout"),
      target: `${hostname}:${port}`,
      logPrefix: "tunnel",
      onEvent: onEvent as unknown as HelperEventSink,
    });
  },
};
