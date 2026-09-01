/**
 * HTTP 请求管道 - 负责客户端与上游之间的数据转发
 * 职责：
 * - forwardHttp：普通 HTTP 请求转发，server 模式从请求解析目标，client 模式用上游配置
 * - forwardTunnel：CONNECT 隧道转发，同上逻辑
 * 设计：纯函数，无状态，根据 proxyMode 自动选择目标来源
 */

import http from "node:http";
import net from "node:net";
import { get } from "../config/store.js";
import { getLogger } from "../utils/logger.js";
import {
  HTTP_200_CONNECTION_ESTABLISHED,
  HTTP_502_BAD_GATEWAY,
  HTTP_504_GATEWAY_TIMEOUT,
} from "../utils/constants.js";

const log = getLogger("HttpPipe");

/** 转发目标 */
export interface PipeTarget {
  host: string;
  port: number;
  /** 上游请求路径（pathname + search，不含 host），避免把 absolute-form 请求行直发 origin server */
  path: string;
}

/**
 * 普通 HTTP 请求转发
 * - server 模式：从请求 URL / Host 头解析目标
 * - client 模式：使用上游配置（upstreamHost/upstreamPort）
 */
export function forwardHttp(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
): void {
  const mode = get("proxyMode");
  const target = mode === "client"
    ? { host: get("upstreamHost"), port: get("upstreamPort"), path: clientReq.url ?? "/" }
    : resolveTarget(clientReq);

  if (!target) {
    log.warn(`cannot resolve target for ${clientReq.url}`);
    if (!clientRes.headersSent) clientRes.writeHead(400);
    clientRes.end(HTTP_502_BAD_GATEWAY);
    return;
  }

  const timeout = get("upstreamTimeout");

  const upstreamOpts: http.RequestOptions = {
    hostname: target.host,
    port: target.port,
    path: target.path,
    method: clientReq.method,
    headers: { ...clientReq.headers },
    timeout,
  };

  log.debug(`forward ${clientReq.method} ${clientReq.url} -> ${target.host}:${target.port} (mode: ${mode})`);

  const upstreamReq = http.request(upstreamOpts, (upstreamRes) => {
    clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(clientRes);
  });

  upstreamReq.on("error", (err) => {
    log.error("upstream request error", err);
    if (clientRes.writableEnded) return;
    if (!clientRes.headersSent) clientRes.writeHead(502);
    clientRes.end(HTTP_502_BAD_GATEWAY);
  });

  upstreamReq.on("timeout", () => {
    log.warn("upstream request timeout");
    upstreamReq.destroy();
    if (clientRes.writableEnded) return;
    if (!clientRes.headersSent) clientRes.writeHead(504);
    clientRes.end(HTTP_504_GATEWAY_TIMEOUT);
  });

  clientReq.pipe(upstreamReq);

  clientReq.on("close", () => {
    // 仅当请求体未完整接收（客户端中途断开）时才销毁上游，避免因 close 提前触发导致 RST
    if (!clientReq.complete && !upstreamReq.destroyed) upstreamReq.destroy();
  });
}

/**
 * CONNECT 隧道转发
 * - server 模式：从 req.url（host:port）解析目标
 * - client 模式：使用上游配置（upstreamHost/upstreamPort）
 */
export function forwardTunnel(
  clientReq: http.IncomingMessage,
  clientSocket: import("node:stream").Duplex,
  head: Buffer,
): void {
  const mode = get("proxyMode");
  let targetHost: string;
  let targetPort: number;

  if (mode === "client") {
    targetHost = get("upstreamHost");
    targetPort = get("upstreamPort");
  } else {
    const [host, portStr] = (clientReq.url ?? "").split(":");
    targetHost = host;
    targetPort = Number(portStr) || 443;
  }

  const timeout = get("upstreamTimeout");

  log.debug(`tunnel ${clientReq.url} -> ${targetHost}:${targetPort} (mode: ${mode})`);

  const upstreamSocket = net.connect(targetPort, targetHost, () => {
    clientSocket.write(HTTP_200_CONNECTION_ESTABLISHED);

    if (head.length > 0) {
      upstreamSocket.write(head);
    }

    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  upstreamSocket.setTimeout(timeout);

  upstreamSocket.on("timeout", () => {
    log.warn("tunnel upstream timeout");
    upstreamSocket.destroy();
    if (clientSocket.writable) {
      clientSocket.end(HTTP_504_GATEWAY_TIMEOUT);
    }
  });

  upstreamSocket.on("error", (err) => {
    log.error("tunnel upstream error", err);
    if (clientSocket.writable) {
      clientSocket.end(HTTP_502_BAD_GATEWAY);
    }
  });

  clientSocket.on("close", () => {
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  });
}

/**
 * 从请求中解析转发目标（server 模式用）
 * - 绝对 URL（http://example.com/path）→ 解析出 host:port
 * - 相对路径 + Host 头 → 解析出 host:port
 */
function resolveTarget(req: http.IncomingMessage): PipeTarget | null {
  const raw = req.url ?? "";

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      return {
        host: url.hostname,
        port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
        path: `${url.pathname}${url.search}` || "/",
      };
    } catch {
      return null;
    }
  }

  const host = req.headers.host;
  if (!host) return null;
  const [hostname, portStr] = host.split(":");
  return {
    host: hostname,
    port: portStr ? Number(portStr) : 80,
    path: raw || "/",
  };
}
