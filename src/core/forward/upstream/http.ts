/**
 * upstream/http - 明文 HTTP 上游转发
 * 职责：http.request 直连（server 模式直连源站 / client 模式透传 absolute-form 到 http 上游代理）
 * 零日志，错误经 guard 兜底 502/504
 */

import http from "node:http";
import { get } from "@/config/store.js";
import type { TargetParts } from "@/core/proxy-helpers.js";
import type { PipeEventSink } from "@/core/types/pipe.js";
import { buildUpstreamRequestOptions, guardUpstreamRequest } from "./shared.js";
import { STATUS_BAD_GATEWAY } from "@/utils/constants.js";
import type { UpstreamHandler } from "./types.js";

export const httpUpstreamHandler: UpstreamHandler = {
  forward(clientReq, clientRes, target: TargetParts, _onEvent?: PipeEventSink) {
    const mode = get("proxyMode");
    const upstreamOpts = buildUpstreamRequestOptions(clientReq, target, mode);
    const upstreamReq = http.request(upstreamOpts, (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode ?? STATUS_BAD_GATEWAY, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    });
    guardUpstreamRequest(upstreamReq, clientReq, clientRes);
    clientReq.pipe(upstreamReq);
  },
};
