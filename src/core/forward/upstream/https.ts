/**
 * upstream/https - TLS 加密 HTTP 上游转发
 * 职责：https.request + servername/ca/insecure 处理
 * - servername: IP 目标置空跳 SNI（RFC 6066），域名则透传目标域名防 Host 头错位校验
 * - upstreamCa 存在才注入，缺省回退系统信任库；upstreamInsecure 关校验
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { get } from "@/config/store.js";
import type { TargetParts } from "@/core/proxy-helpers.js";
import type { PipeEventSink } from "@/core/types/pipe.js";
import { buildUpstreamRequestOptions, guardUpstreamRequest, readOptionalFile } from "./shared.js";
import { STATUS_BAD_GATEWAY } from "@/utils/constants.js";
import type { UpstreamHandler } from "./types.js";

export const httpsUpstreamHandler: UpstreamHandler = {
  forward(clientReq, clientRes, target: TargetParts, _onEvent?: PipeEventSink) {
    const mode = get("proxyMode");
    const upstreamOpts: https.RequestOptions = buildUpstreamRequestOptions(clientReq, target, mode);
    upstreamOpts.servername = net.isIP(target.host) ? "" : target.host;
    upstreamOpts.rejectUnauthorized = !get("upstreamInsecure");
    const ca = readOptionalFile(get("upstreamCa"));
    if (ca) upstreamOpts.ca = ca;

    const upstreamReq = https.request(upstreamOpts, (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode ?? STATUS_BAD_GATEWAY, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    });
    guardUpstreamRequest(upstreamReq as unknown as http.ClientRequest, clientReq, clientRes);
    clientReq.pipe(upstreamReq);
  },
};
