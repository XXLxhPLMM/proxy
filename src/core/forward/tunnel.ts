/**
 * CONNECT 隧道转发 - 薄分发层
 * 解析 authority → 自环 guard → 按 proxyMode/upstreamProtocol 委派 tunnel/* 载体
 * 隧道抽象 = 双向字节管道，载体可为 直拨 / HTTP CONNECT / HTTPS CONNECT / SOCKS / TLS
 * 本层零日志，事件经 PipeEventSink 上抛
 */

import http from "node:http";
import { get } from "@/config/store.js";
import { isSelfLoop, parseAuthority } from "@/core/proxy-helpers.js";
import { HTTP_502_BAD_GATEWAY, STATUS_BAD_GATEWAY } from "@/utils/constants.js";
import type { PipeEventSink } from "../types/pipe.js";
import { createPipeEmitter } from "./shared.js";
import { getTunnelHandler } from "./tunnel/index.js";

export function forwardTunnel(
  clientReq: http.IncomingMessage,
  clientSocket: import("node:stream").Duplex,
  head: Buffer,
  onEvent?: PipeEventSink,
): void {
  const emit = createPipeEmitter(onEvent);
  const authority = clientReq.url ?? "";
  const parsed = parseAuthority(authority);
  if (!parsed) {
    emit({ type: "target-unresolved", url: authority });
    if ((clientSocket as unknown as { writable: boolean }).writable) {
      try { clientSocket.write(HTTP_502_BAD_GATEWAY); } catch {}
    }
    clientSocket.destroy();
    return;
  }

  const { hostname, port } = parsed;
  if (isSelfLoop(hostname, port)) {
    emit({ type: "loop-detected", req: clientReq, target: `${hostname}:${port}` });
    if ((clientSocket as unknown as { writable: boolean }).writable) {
      try { clientSocket.write(HTTP_502_BAD_GATEWAY); } catch {}
    }
    clientSocket.destroy();
    return;
  }

  emit({ type: "route", kind: "tunnel", req: clientReq, target: `${hostname}:${port}`, mode: get("proxyMode") });

  const mode = get("proxyMode");
  const upstreamProtocol = get("upstreamProtocol");
  const handler = getTunnelHandler(mode, upstreamProtocol);
  handler.connect(clientSocket, hostname, port, head, onEvent);

  // 建链期错误由 tunnel 内部 guardDialing 兜底（写 502/504 或静默销毁）
  // 防止未捕获异常导致进程崩溃
  clientSocket.on("error", () => {});
}
