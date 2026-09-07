/**
 * upstream/tls - TLS 直连上游（HTTP 语义层占位）
 * 当前未实现：与 https 同属 TLS 传输但语义为裸 TLS 代理
 * 行为保持与旧 forward/http 一致：回 502，由 tunnel/tls 承载
 */

import type http from "node:http";
import type { TargetParts } from "@/core/proxy-helpers.js";
import type { PipeEventSink } from "@/core/types/pipe.js";
import { HTTP_502_BAD_GATEWAY, STATUS_BAD_GATEWAY } from "@/utils/constants.js";
import type { UpstreamHandler } from "./types.js";

export const tlsUpstreamHandler: UpstreamHandler = {
  forward(_clientReq: http.IncomingMessage, clientRes: http.ServerResponse, _target: TargetParts, onEvent?: PipeEventSink) {
    onEvent?.({ type: "debug", message: "[forward] upstream protocol tls not implemented" } as unknown as Parameters<NonNullable<PipeEventSink>>[0]);
    if (!clientRes.headersSent) clientRes.writeHead(STATUS_BAD_GATEWAY);
    clientRes.end(HTTP_502_BAD_GATEWAY);
  },
};
