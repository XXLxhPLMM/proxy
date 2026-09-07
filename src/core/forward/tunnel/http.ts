/**
 * tunnel/http - 经 HTTP 上游代理的 CONNECT 隧道（client 模式）
 * 流程：dial 到 upstreamHost:upstreamPort → 发 CONNECT → 等 200 → head 透传 → bridge
 * 事件经 PipeEventSink 上抛，失败由 guardDialing 兜底 502/504
 */

import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import { buildConnectRequest } from "@/core/proxy-helpers.js";
import type { IncomingMessage } from "node:http";
import type { PipeEventSink } from "@/core/types/pipe.js";
import type { HelperEventSink } from "@/core/proxy-helpers.js";
import { createPipeEmitter, dialUpstream, resolveUpstreamAuth } from "../shared.js";
import { bridgeSockets } from "../connectors/base.js";
import { CRLF, DOUBLE_CRLF_BUF, HTTP_200_CONNECTION_ESTABLISHED } from "@/utils/constants.js";
import type { TunnelHandler } from "./types.js";

export const httpTunnelHandler: TunnelHandler = {
  connect(clientSocket: Duplex, hostname: string, port: number, head: Buffer, onEvent?: PipeEventSink) {
    const emit = createPipeEmitter(onEvent);
    const upstreamHost = get("upstreamHost");
    const upstreamPort = get("upstreamPort");
    emit({ type: "route", kind: "tunnel", req: { url: `${hostname}:${port}`, method: "CONNECT" } as unknown as IncomingMessage, target: `${hostname}:${port} via ${upstreamHost}:${upstreamPort}`, mode: "client" });

    dialUpstream(clientSocket, upstreamHost, upstreamPort, (upstreamSocket, dial) => {
      const auth = resolveUpstreamAuth();
      const extraHeaders = auth ? `Proxy-Authorization: ${auth}` : undefined;
      const connectReq = buildConnectRequest(hostname, port, extraHeaders);
      emit({ type: "debug", message: () => `tunnel CONNECT via http upstream:\n${connectReq}` });
      upstreamSocket.write(connectReq);

      // 等上游 200
      let pending = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        const headerEnd = pending.indexOf(DOUBLE_CRLF_BUF);
        if (headerEnd === -1) return;
        const headerBlock = pending.subarray(0, headerEnd + DOUBLE_CRLF_BUF.length).toString();
        const rest = pending.subarray(headerEnd + DOUBLE_CRLF_BUF.length);
        upstreamSocket.removeListener("data", onData);
        if (headerBlock.includes("200")) {
          dial.established();
          // 转 rest + head 再 bridge
          if (rest.length > 0) upstreamSocket.unshift(rest);
          if (head.length > 0) upstreamSocket.write(head);
          // 告知客户端隧道已建
          if (clientSocket.writable) clientSocket.write(HTTP_200_CONNECTION_ESTABLISHED);
          bridgeSockets(clientSocket, upstreamSocket, "tunnel", onEvent as unknown as HelperEventSink);
        } else {
          emit({ type: "debug", message: `tunnel via http upstream rejected: ${headerBlock.split(CRLF)[0]}` });
          if (clientSocket.writable) clientSocket.write(pending);
          upstreamSocket.destroy();
          clientSocket.destroy();
        }
      };
      upstreamSocket.on("data", onData);
    }, { logPrefix: "tunnel", timeoutReply: "", errorReply: "" });
  },
};
