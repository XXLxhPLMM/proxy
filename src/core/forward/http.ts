/**
 * HTTP 请求转发 - 薄分发层
 * 解析目标 → 自环 guard → 按 upstreamProtocol 委派 upstream/* 处理器
 * 本层零日志，事件经 PipeEventSink 上抛
 */

import { get } from "@/config/store.js";
import { isSelfLoop } from "@/core/proxy-helpers.js";
import { HTTP_502_BAD_GATEWAY, STATUS_BAD_GATEWAY, STATUS_BAD_REQUEST } from "@/utils/constants.js";
import type { PipeEventSink } from "../types/pipe.js";
import { createPipeEmitter, resolveHttpTarget } from "./shared.js";
import { getUpstreamHandler } from "./upstream/index.js";

export function forwardHttp(
  clientReq: import("node:http").IncomingMessage,
  clientRes: import("node:http").ServerResponse,
  onEvent?: PipeEventSink,
): void {
  const emit = createPipeEmitter(onEvent);
  const mode = get("proxyMode");
  const target = resolveHttpTarget(clientReq, mode);

  if (!target) {
    emit({ type: "target-unresolved", url: clientReq.url });
    if (!clientRes.headersSent) clientRes.writeHead(STATUS_BAD_REQUEST);
    clientRes.end(HTTP_502_BAD_GATEWAY);
    return;
  }
  emit({ type: "route", kind: "forward", req: clientReq, target: `${target.host}:${target.port}`, mode });
  if (isSelfLoop(target.host, target.port)) {
    emit({ type: "loop-detected", req: clientReq, target: `${target.host}:${target.port}` });
    if (!clientRes.headersSent) clientRes.writeHead(STATUS_BAD_GATEWAY);
    clientRes.end(HTTP_502_BAD_GATEWAY);
    return;
  }

  const upstreamProtocol = mode === "client" ? get("upstreamProtocol") : "http";
  const handler = getUpstreamHandler(upstreamProtocol);
  handler.forward(clientReq, clientRes, target, onEvent);
}
