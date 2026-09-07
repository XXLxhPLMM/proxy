/**
 * upstream/shared - 上游 HTTP 层公共件
 * guardUpstreamRequest / buildUpstreamRequestOptions / readOptionalFile
 * 从 forward/http.ts 抽出供 http/https 复用，零日志
 */

import fs from "node:fs";
import http from "node:http";
import { get, type AppConfig } from "@/config/store.js";
import { sanitizeHeaders, type TargetParts } from "@/core/proxy-helpers.js";
import {
  HTTP_502_BAD_GATEWAY,
  HTTP_504_GATEWAY_TIMEOUT,
  STATUS_BAD_GATEWAY,
  STATUS_GATEWAY_TIMEOUT,
} from "@/utils/constants.js";
import { resolveUpstreamAuth } from "../shared.js";

export function guardUpstreamRequest(
  upstreamReq: http.ClientRequest,
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
): void {
  upstreamReq.on("error", () => {
    if (clientRes.writableEnded) return;
    if (!clientRes.headersSent) clientRes.writeHead(STATUS_BAD_GATEWAY);
    clientRes.end(HTTP_502_BAD_GATEWAY);
  });

  upstreamReq.on("timeout", () => {
    upstreamReq.destroy();
    if (clientRes.writableEnded) return;
    if (!clientRes.headersSent) clientRes.writeHead(STATUS_GATEWAY_TIMEOUT);
    clientRes.end(HTTP_504_GATEWAY_TIMEOUT);
  });

  clientReq.on("close", () => {
    if (!clientReq.complete && !upstreamReq.destroyed) upstreamReq.destroy();
  });
}

export function buildUpstreamRequestOptions(
  clientReq: http.IncomingMessage,
  target: TargetParts,
  mode: AppConfig["proxyMode"],
  timeout: number = get("upstreamTimeout"),
): http.RequestOptions {
  const headers: http.OutgoingHttpHeaders = sanitizeHeaders({ ...clientReq.headers });
  if (mode !== "client") {
    headers["host"] = `${target.host}:${target.port}`;
  } else {
    const upstreamAuth = resolveUpstreamAuth();
    if (upstreamAuth) headers["proxy-authorization"] = upstreamAuth;
  }
  return {
    hostname: target.host,
    port: target.port,
    path: target.path,
    method: clientReq.method,
    headers,
    timeout,
  };
}

export function readOptionalFile(p: string): Buffer | undefined {
  return p && fs.existsSync(p) ? fs.readFileSync(p) : undefined;
}
