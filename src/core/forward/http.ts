/**
 * HTTP 请求转发 - 普通 HTTP 请求的客户端↔上游转发
 * - server 模式：从请求 URL / Host 头解析目标
 * - client 模式：使用上游配置（upstreamHost/upstreamPort），absolute-form 原样转给上游代理；
 *   Proxy-Authorization 只认显式 upstreamUsername/Password 注入，客户端自带头一律过滤
 * 设计：纯函数，无状态；本层零日志，事件经 PipeEventSink 上抛，缺省静默
 */

import http from "node:http";
import { get, type AppConfig } from "@/config/store.js";
import {
  guardUpstreamRequest,
  isSelfLoop,
  sanitizeHeaders,
  type TargetParts,
} from "@/core/proxy-helpers.js";
import {
  HTTP_502_BAD_GATEWAY,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
} from "@/utils/constants.js";
import type { PipeEventSink } from "../types/pipe.js";
import { createPipeEmitter, resolveHttpTarget, resolveUpstreamAuth } from "./shared.js";

/**
 * 组装上游请求参数：超时 + 清洗头 + 目标拆包
 * - proxy-* 头统洗，connection 固定 close；server 模式重写 Host 为解析出的目标
 * - client 模式保留客户端原始 Host，Proxy-Authorization 只认显式上游账密注入
 */
function buildUpstreamRequestOptions(
  clientReq: http.IncomingMessage,
  target: TargetParts,
  mode: AppConfig["proxyMode"],
  timeout: number = get("upstreamTimeout"),
): http.RequestOptions {
  const headers: http.OutgoingHttpHeaders = sanitizeHeaders({ ...clientReq.headers });
  if (mode !== "client") {
    headers["host"] = `${target.host}:${target.port}`;
  } else {
    // client 模式 + 显式上游账密：以前级身份向上游鉴权
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

/**
 * 普通 HTTP 请求转发
 * - server 模式：从请求 URL / Host 头解析目标
 * - client 模式：使用上游配置（upstreamHost/upstreamPort），absolute-form 原样转给上游代理；
 *   Proxy-Authorization 只认显式 upstreamUsername/Password 注入，客户端自带头一律过滤
 */
export function forwardHttp(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
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

  // 防止循环转发：目标地址是代理自身
  if (isSelfLoop(target.host, target.port)) {
    emit({ type: "loop-detected", detail: `${clientReq.method} ${clientReq.url} -> ${target.host}:${target.port}` });
    if (!clientRes.headersSent) clientRes.writeHead(STATUS_BAD_GATEWAY);
    clientRes.end(HTTP_502_BAD_GATEWAY);
    return;
  }

  const upstreamOpts = buildUpstreamRequestOptions(clientReq, target, mode);

  emit({ type: "debug", message: () => `forward ${clientReq.method} ${clientReq.url} -> ${target.host}:${target.port} (mode: ${mode})` });

  const upstreamReq = http.request(upstreamOpts, (upstreamRes) => {
    clientRes.writeHead(upstreamRes.statusCode ?? STATUS_BAD_GATEWAY, upstreamRes.headers);
    upstreamRes.pipe(clientRes);
  });

  guardUpstreamRequest(upstreamReq, clientReq, clientRes);

  clientReq.pipe(upstreamReq);
}
