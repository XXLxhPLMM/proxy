/**
 * upstream/socks - SOCKS 上游（HTTP 语义层占位）
 * 当前未实现：HTTP 请求经 SOCKS 需先 SOCKS 握手再发 HTTP 报文
 * 行为保持与旧 forward/http 一致：回 502，由 tunnel/socks 承载真正的隧道能力
 */

import type http from "node:http";
import type { TargetParts } from "@/core/proxy-helpers.js";
import type { PipeEventSink } from "@/core/types/pipe.js";
import { HTTP_502_BAD_GATEWAY, STATUS_BAD_GATEWAY } from "@/utils/constants.js";
import type { UpstreamHandler } from "./types.js";

export const socksUpstreamHandler: UpstreamHandler = {
  forward(_clientReq: http.IncomingMessage, clientRes: http.ServerResponse, _target: TargetParts, onEvent?: PipeEventSink) {
    onEvent?.({ type: "debug", message: "[forward] upstream protocol socks not implemented" } as unknown as Parameters<NonNullable<PipeEventSink>>[0]);
    if (!clientRes.headersSent) clientRes.writeHead(STATUS_BAD_GATEWAY);
    clientRes.end(HTTP_502_BAD_GATEWAY);
  },
};
