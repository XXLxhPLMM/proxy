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
import { bridgeSockets, buildConnectRequest, guardDialing, guardUpstreamRequest, isSelfLoop, parseTargetParts } from "@/utils/proxy-helpers.js";
import type { TargetParts } from "@/utils/proxy-helpers.js";
import { logLoopDetected, logTargetUnresolved, logUpstreamRefused } from "@/utils/log-events.js";
import { getLogger } from "@/utils/logger.js";
import {
  CRLF,
  DEFAULT_PORT_HTTPS,
  DOUBLE_CRLF,
  DOUBLE_CRLF_BUF,
  HTTP_200_CONNECTION_ESTABLISHED,
  HTTP_502_BAD_GATEWAY,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_SWITCHING_PROTOCOLS,
} from "@/utils/constants.js";

const log = getLogger("HttpPipe");



/** 转发目标（见 proxy-helpers.parseTargetParts，server 模式用） */
export type PipeTarget = TargetParts;

/**
 * 普通 HTTP 请求转发
 * - server 模式：从请求 URL / Host 头解析目标
 * - client 模式：使用上游配置（upstreamHost/upstreamPort），absolute-form 原样转给上游代理；
 *   配了显式 upstreamUsername/Password 时注入 Proxy-Authorization（覆盖客户端透传头，
 *   与 CONNECT 分支同优先级），客户端自带头则原样透传由上游判定
 */
export function forwardHttp(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
): void {
  const mode = get("proxyMode");
  const target = mode === "client"
    ? { host: get("upstreamHost"), port: get("upstreamPort"), path: clientReq.url ?? "/" }
    : parseTargetParts(clientReq.url ?? "", clientReq.headers.host);

  if (!target) {
    logTargetUnresolved(log, clientReq.url);
    if (!clientRes.headersSent) clientRes.writeHead(STATUS_BAD_REQUEST);
    clientRes.end(HTTP_502_BAD_GATEWAY);
    return;
  }

  // 防止循环转发：目标地址是代理自身
  if (isSelfLoop(target.host, target.port)) {
    logLoopDetected(log, `${clientReq.method} ${clientReq.url} -> ${target.host}:${target.port}`);
    if (!clientRes.headersSent) clientRes.writeHead(STATUS_BAD_GATEWAY);
    clientRes.end(HTTP_502_BAD_GATEWAY);
    return;
  }

  const timeout = get("upstreamTimeout");

  const headers: http.OutgoingHttpHeaders = { ...clientReq.headers };
  // client 模式 + 显式上游账密：以前级身份向上游鉴权，覆盖客户端透传头
  if (mode === "client") {
    const upstreamAuth = resolveUpstreamAuth();
    if (upstreamAuth) headers["proxy-authorization"] = upstreamAuth.slice("Proxy-Authorization: ".length);
  }

  const upstreamOpts: http.RequestOptions = {
    hostname: target.host,
    port: target.port,
    path: target.path,
    method: clientReq.method,
    headers,
    timeout,
  };

  log.debug(`forward ${clientReq.method} ${clientReq.url} -> ${target.host}:${target.port} (mode: ${mode})`);

  const upstreamReq = http.request(upstreamOpts, (upstreamRes) => {
    clientRes.writeHead(upstreamRes.statusCode ?? STATUS_BAD_GATEWAY, upstreamRes.headers);
    upstreamRes.pipe(clientRes);
  });

  guardUpstreamRequest(upstreamReq, clientReq, clientRes);

  clientReq.pipe(upstreamReq);
}

/**
 * CONNECT 隧道转发
 * - server 模式：从 req.url（host:port）解析目标，直拨建隧道
 * - client 模式：向上游代理重发 CONNECT 建链（https 串联），见 forwardTunnelViaUpstream
 */
export function forwardTunnel(
  clientReq: http.IncomingMessage,
  clientSocket: import("node:stream").Duplex,
  head: Buffer,
): void {
  if (get("proxyMode") === "client") {
    forwardTunnelViaUpstream(clientReq, clientSocket, head);
    return;
  }

  const [host, portStr] = (clientReq.url ?? "").split(":");
  const targetHost = host;
  const targetPort = Number(portStr) || DEFAULT_PORT_HTTPS;

  // 防止循环转发：目标地址是代理自身
  if (isSelfLoop(targetHost, targetPort)) {
    logLoopDetected(log, `tunnel ${clientReq.url} -> ${targetHost}:${targetPort}`);
    clientSocket.end(HTTP_502_BAD_GATEWAY);
    return;
  }

  const timeout = get("upstreamTimeout");

  log.debug(`tunnel ${clientReq.url} -> ${targetHost}:${targetPort} (mode: server)`);

  const upstreamSocket = net.connect(targetPort, targetHost, () => {
    dial.established();
    clientSocket.write(HTTP_200_CONNECTION_ESTABLISHED);

    if (head.length > 0) {
      upstreamSocket.write(head);
    }

    bridgeSockets(clientSocket, upstreamSocket);
  });
  const dial = guardDialing(clientSocket, upstreamSocket, { timeout });
}

/**
 * 上游 CONNECT 鉴权头：只用显式 upstreamUsername/Password（直透分支已覆盖
 * 客户端账密透传场景，这里不需要再透传）
 */
function resolveUpstreamAuth(): string | undefined {
  const username = get("upstreamUsername");
  if (!username) return undefined;
  const b64 = Buffer.from(`${username}:${get("upstreamPassword")}`).toString("base64");
  return `Proxy-Authorization: Basic ${b64}`;
}

/**
 * client 模式 CONNECT：向上游代理建链（https 串联的关键）
 * 注意：能进到这里说明前级鉴权已过（server/http.ts 的 authorizeAndForwardTunnel
 * 先做 authorize，失败直接 407，根本到不了转发），所以 200 永远由上游说了算，
 * 前级自己绝不代回 200。两条分支：
 * - 直透（默认）：把客户端原始 CONNECT 报文（request-line + rawHeaders，原样保留
 *   Proxy-Authorization 等头）直接交给上游处理，上游的 200/407 直达客户端
 * - 终止重发：仅当配了显式 upstreamUsername/Password 时（直透注不进上游账密），
 *   由前级重发 CONNECT；上游非 200（如 407）把响应头块原样 relay 给客户端后断开
 */
function forwardTunnelViaUpstream(
  clientReq: http.IncomingMessage,
  clientSocket: import("node:stream").Duplex,
  head: Buffer,
): void {
  const upstreamHost = get("upstreamHost");
  const upstreamPort = get("upstreamPort");

  // 上游就是自己 -> 必环，直接拒
  if (isSelfLoop(upstreamHost, upstreamPort)) {
    logLoopDetected(log, `tunnel ${clientReq.url} via upstream ${upstreamHost}:${upstreamPort}`);
    clientSocket.end(HTTP_502_BAD_GATEWAY);
    return;
  }

  if (!get("upstreamUsername")) {
    forwardTunnelTransparent(clientReq, clientSocket, head, upstreamHost, upstreamPort);
    return;
  }

  const [targetHost, portStr] = (clientReq.url ?? "").split(":");
  const targetPort = Number(portStr) || DEFAULT_PORT_HTTPS;
  if (!targetHost) {
    clientSocket.end(HTTP_502_BAD_GATEWAY);
    return;
  }

  const timeout = get("upstreamTimeout");
  log.debug(`tunnel ${clientReq.url} via upstream ${upstreamHost}:${upstreamPort} (mode: client)`);

  const upstreamSocket = net.connect(upstreamPort, upstreamHost, () => {
    upstreamSocket.write(buildConnectRequest(targetHost, targetPort, resolveUpstreamAuth()));
  });
  const dial = guardDialing(clientSocket, upstreamSocket, { timeout });

  // 等上游 CONNECT 响应头，凑齐 CRLF CRLF 后一次性判定
  let pending = Buffer.alloc(0);
  const onUpstreamData = (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf(DOUBLE_CRLF_BUF);
    if (end === -1) return;
    upstreamSocket.removeListener("data", onUpstreamData);

    const headerBlock = pending.subarray(0, end + DOUBLE_CRLF_BUF.length);
    const rest = pending.subarray(end + DOUBLE_CRLF_BUF.length);
    const statusLine = headerBlock.toString().split(CRLF)[0] ?? "";
    const statusCode = Number(statusLine.split(" ")[1]);

    if (statusCode === 200) {
      dial.established();
      clientSocket.write(HTTP_200_CONNECTION_ESTABLISHED);
      if (head.length > 0) upstreamSocket.write(head);
      if (rest.length > 0) clientSocket.write(rest);
      bridgeSockets(clientSocket, upstreamSocket);
    } else {
      logUpstreamRefused(log, statusLine);
      if (clientSocket.writable) clientSocket.end(headerBlock);
      upstreamSocket.destroy();
    }
  };
  upstreamSocket.on("data", onUpstreamData);
}

/**
 * 直透分支：解析器已吃掉原始 CONNECT 行，用 method/url/httpVersion/rawHeaders
 * 等字节重建后一次写给上游，此后前级只做 TCP pipe，上游的 200/407 直达客户端
 */
function forwardTunnelTransparent(
  clientReq: http.IncomingMessage,
  clientSocket: import("node:stream").Duplex,
  head: Buffer,
  upstreamHost: string,
  upstreamPort: number,
): void {
  const timeout = get("upstreamTimeout");
  log.debug(`tunnel ${clientReq.url} transparent via upstream ${upstreamHost}:${upstreamPort} (mode: client)`);

  const headerLines: string[] = [];
  const raw = clientReq.rawHeaders ?? [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    headerLines.push(`${raw[i]}: ${raw[i + 1]}`);
  }
  const rebuilt =
    `${clientReq.method} ${clientReq.url} HTTP/${clientReq.httpVersion}${CRLF}` +
    (headerLines.length > 0 ? headerLines.join(CRLF) + CRLF : "") +
    DOUBLE_CRLF;

  const upstreamSocket = net.connect(upstreamPort, upstreamHost, () => {
    dial.established();
    upstreamSocket.write(rebuilt);
    if (head.length > 0) upstreamSocket.write(head);
    bridgeSockets(clientSocket, upstreamSocket);
  });
  const dial = guardDialing(clientSocket, upstreamSocket, { timeout });
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
    const target = parseTargetParts(clientReq.url ?? "", clientReq.headers.host);
    if (!target) {
      logTargetUnresolved(log, clientReq.url);
      clientSocket.destroy();
      return;
    }
    targetHost = target.host;
    targetPort = target.port;
    targetPath = target.path;
  }

  // 防止循环转发：目标地址是代理自身
  if (isSelfLoop(targetHost, targetPort)) {
    logLoopDetected(log, `upgrade ${clientReq.url} -> ${targetHost}:${targetPort}`);
    clientSocket.destroy();
    return;
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
          dial.established();
          const headerEnd = responseBuffer.indexOf(DOUBLE_CRLF_BUF) + 4;
          const responseHeaders = responseBuffer.subarray(0, headerEnd);
          const responseBody = responseBuffer.subarray(headerEnd);

          clientSocket.write(responseHeaders);
          if (responseBody.length > 0) {
            clientSocket.write(responseBody);
          }

          // 双向 pipe：客户端 ↔ 上游
          bridgeSockets(clientSocket, upstreamSocket, "upgrade");
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
  // 无 ServerResponse 可写，建链失败只断开不写兜底（与原来一致）
  const dial = guardDialing(clientSocket, upstreamSocket, { logPrefix: "upgrade", timeout, timeoutReply: "", errorReply: "" });
}
