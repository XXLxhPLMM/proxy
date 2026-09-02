/**
 * HTTP 请求管道 - 负责客户端与上游之间的数据转发
 * 职责：
 * - forwardHttp：普通 HTTP 请求转发，server 模式从请求解析目标，client 模式用上游配置
 * - forwardTunnel：CONNECT 隧道转发，同上逻辑
 * - forwardUpgrade：WebSocket 等协议升级转发
 * 设计：纯函数，无状态，根据 proxyMode 自动选择目标来源
 */

import http from "node:http";
import net from "node:net";
import { get } from "@/config/store.js";
import { getLogger } from "@/utils/logger.js";
import {
  CRLF,
  DEFAULT_PORT_HTTPS,
  DEFAULT_PORT_HTTP,
  DOUBLE_CRLF,
  DOUBLE_CRLF_BUF,
  HTTP_200_CONNECTION_ESTABLISHED,
  HTTP_502_BAD_GATEWAY,
  HTTP_504_GATEWAY_TIMEOUT,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_GATEWAY_TIMEOUT,
  STATUS_SWITCHING_PROTOCOLS,
} from "@/utils/constants.js";

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
    if (!clientRes.headersSent) clientRes.writeHead(STATUS_BAD_REQUEST);
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
    clientRes.writeHead(upstreamRes.statusCode ?? STATUS_BAD_GATEWAY, upstreamRes.headers);
    upstreamRes.pipe(clientRes);
  });

  upstreamReq.on("error", (err) => {
    log.error("upstream request error", err);
    if (clientRes.writableEnded) return;
    if (!clientRes.headersSent) clientRes.writeHead(STATUS_BAD_GATEWAY);
    clientRes.end(HTTP_502_BAD_GATEWAY);
  });

  upstreamReq.on("timeout", () => {
    log.warn("upstream request timeout");
    upstreamReq.destroy();
    if (clientRes.writableEnded) return;
    if (!clientRes.headersSent) clientRes.writeHead(STATUS_GATEWAY_TIMEOUT);
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
    targetPort = Number(portStr) || DEFAULT_PORT_HTTPS;
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
 * WebSocket/Upgrade 协议升级转发
 * - server 模式：从请求 URL / Host 头解析目标
 * - client 模式：使用上游配置（upstreamHost/upstreamPort）
 * 流程：解析目标 → 建立 TCP 连接 → 转发原始 Upgrade 请求 → 双向 pipe
 */
export function forwardUpgrade(
  clientReq: http.IncomingMessage,
  clientSocket: import("node:stream").Duplex,
  head: Buffer,
): void {
  const mode = get("proxyMode");
  let targetHost: string;
  let targetPort: number;
  let targetPath: string;

  if (mode === "client") {
    targetHost = get("upstreamHost");
    targetPort = get("upstreamPort");
    targetPath = clientReq.url ?? "/";
  } else {
    const target = resolveTarget(clientReq);
    if (!target) {
      log.warn(`cannot resolve upgrade target for ${clientReq.url}`);
      clientSocket.destroy();
      return;
    }
    targetHost = target.host;
    targetPort = target.port;
    targetPath = target.path;
  }

  const timeout = get("upstreamTimeout");

  log.debug(`upgrade ${clientReq.url} -> ${targetHost}:${targetPort} (mode: ${mode})`);

  const upstreamSocket = net.connect(targetPort, targetHost, () => {
    // 重建 HTTP Upgrade 请求，使用相对路径
    const requestLine = `${clientReq.method} ${targetPath} HTTP/${clientReq.httpVersion}${CRLF}`;
    // rawHeaders 是 [name1, value1, name2, value2, ...] 扁平数组
    // 需要重新构建为 "Name: Value" 格式，并重写 Host 头
    const headerPairs: string[] = [];
    for (let i = 0; i < clientReq.rawHeaders.length; i += 2) {
      const name = clientReq.rawHeaders[i];
      const value = clientReq.rawHeaders[i + 1];
      if (name.toLowerCase() === "host") {
        headerPairs.push(`Host: ${targetHost}:${targetPort}`);
      } else {
        headerPairs.push(`${name}: ${value}`);
      }
    }
    const headers = headerPairs.join(CRLF);
    const upgradeRequest = `${requestLine}${headers}${DOUBLE_CRLF}`;
    log.debug(`upgrade request:\n${upgradeRequest}`);
    upstreamSocket.write(upgradeRequest);

    // 转发 head 中的剩余数据
    if (head.length > 0) {
      upstreamSocket.write(head);
    }

    // 等待上游响应，检查是否为 101 Switching Protocols
    let responseBuffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      const responseStr = responseBuffer.toString();

      if (responseStr.includes(DOUBLE_CRLF)) {
        upstreamSocket.removeListener("data", onData);

        if (responseStr.includes(String(STATUS_SWITCHING_PROTOCOLS))) {
          // 升级成功：将 101 响应发回给客户端
          const headerEnd = responseBuffer.indexOf(DOUBLE_CRLF_BUF) + 4;
          const responseHeaders = responseBuffer.subarray(0, headerEnd);
          const responseBody = responseBuffer.subarray(headerEnd);

          clientSocket.write(responseHeaders);
          if (responseBody.length > 0) {
            clientSocket.write(responseBody);
          }

          // 双向 pipe：客户端 ↔ 上游
          upstreamSocket.pipe(clientSocket);
          clientSocket.pipe(upstreamSocket);
        } else {
          // 升级失败：将上游响应转发给客户端
          clientSocket.write(responseBuffer);
          upstreamSocket.destroy();
          clientSocket.destroy();
        }
      }
    };

    upstreamSocket.on("data", onData);
  });

  upstreamSocket.setTimeout(timeout);

  upstreamSocket.on("timeout", () => {
    log.warn("upgrade upstream timeout");
    upstreamSocket.destroy();
    if (clientSocket.writable) {
      clientSocket.destroy();
    }
  });

  upstreamSocket.on("error", (err) => {
    log.error("upgrade upstream error", err);
    if (clientSocket.writable) {
      clientSocket.destroy();
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
        port: url.port ? Number(url.port) : url.protocol === "https:" ? DEFAULT_PORT_HTTPS : DEFAULT_PORT_HTTP,
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
    port: portStr ? Number(portStr) : DEFAULT_PORT_HTTP,
    path: raw || "/",
  };
}
