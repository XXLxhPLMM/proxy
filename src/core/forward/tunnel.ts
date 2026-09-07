/**
 * CONNECT 隧道转发 - client↔上游 的隧道建立与数据桥接
 * - server 模式：从 req.url（host:port）解析目标，直拨建隧道
 * - client 模式：向上游代理重发 CONNECT 建链（https 串联），见 forwardTunnelViaUpstream
 * 设计：纯函数，无状态；本层零日志，事件经 PipeEventSink 上抛，缺省静默
 */

import http from "node:http";
import net from "node:net";
import { get } from "@/config/store.js";
import { bridgeSockets, isSelfLoop } from "@/core/proxy-helpers.js";
import {
  CRLF,
  DEFAULT_PORT_HTTPS,
  DOUBLE_CRLF,
  HEADER_NAME_PROXY_AUTHORIZATION,
  HTTP_200_CONNECTION_ESTABLISHED,
  HTTP_502_BAD_GATEWAY,
} from "@/utils/constants.js";
import type { PipeEvent, PipeEventSink } from "../types/pipe.js";
import { dialTunnelViaUpstream } from "./connectors/index.js";
import { createPipeEmitter, dialUpstream, rebuildHeaderLines, resolveUpstreamAuth } from "./shared.js";

/**
 * CONNECT 隧道转发
 * - server 模式：从 req.url（host:port）解析目标，直拨建隧道
 * - client 模式：向上游代理重发 CONNECT 建链（https 串联），见 forwardTunnelViaUpstream
 */
export function forwardTunnel(
  clientReq: http.IncomingMessage,
  clientSocket: import("node:stream").Duplex,
  head: Buffer,
  onEvent?: PipeEventSink,
): void {
  const emit = createPipeEmitter(onEvent);
  if (get("proxyMode") === "client") {
    forwardTunnelViaUpstream(clientReq, clientSocket, head, emit);
    return;
  }

  const [host, portStr] = (clientReq.url ?? "").split(":");
  const targetHost = host;
  const targetPort = Number(portStr) || DEFAULT_PORT_HTTPS;

  // 防止循环转发：目标地址是代理自身
  if (isSelfLoop(targetHost, targetPort)) {
    emit({ type: "loop-detected", detail: `tunnel ${clientReq.url} -> ${targetHost}:${targetPort}` });
    clientSocket.end(HTTP_502_BAD_GATEWAY);
    return;
  }

  emit({ type: "debug", message: () => `tunnel ${clientReq.url} -> ${targetHost}:${targetPort} (mode: server)` });

  dialUpstream(clientSocket, targetHost, targetPort, (upstreamSocket, dial) => {
    dial.established();
    clientSocket.write(HTTP_200_CONNECTION_ESTABLISHED);

    if (head.length > 0) {
      upstreamSocket.write(head);
    }

    bridgeSockets(clientSocket, upstreamSocket);
  });
}

/**
 * client 模式 CONNECT：向上游代理建链（https 串联的关键）
 * 注意：能进到这里说明前级鉴权已过（server/http.ts 的 authorizeAndForwardTunnel
 * 先做 authorize，失败直接 407，根本到不了转发），所以 200 永远由上游说了算，
 * 前级自己绝不代回 200。两条分支：
 * - 直透（默认）：把客户端原始 CONNECT 报文（request-line + rawHeaders，proxy-* 头已滤）
 *   直接交给上游处理，上游的 200/407 直达客户端
 * - 终止重发：仅当配了显式 upstreamUsername/Password 时，由前级重发 CONNECT
 *   并注入上游账密；上游非 200（如 407）把响应头块原样 relay 给客户端后断开
 */
function forwardTunnelViaUpstream(
  clientReq: http.IncomingMessage,
  clientSocket: import("node:stream").Duplex,
  head: Buffer,
  emit: (e: PipeEvent) => void,
): void {
  const upstreamHost = get("upstreamHost");
  const upstreamPort = get("upstreamPort");

  // 上游就是自己 -> 必环，直接拒
  if (isSelfLoop(upstreamHost, upstreamPort)) {
    emit({ type: "loop-detected", detail: `tunnel ${clientReq.url} via upstream ${upstreamHost}:${upstreamPort}` });
    clientSocket.end(HTTP_502_BAD_GATEWAY);
    return;
  }

  if (!get("upstreamUsername")) {
    forwardTunnelTransparent(clientReq, clientSocket, head, upstreamHost, upstreamPort, emit);
    return;
  }

  const [targetHost, portStr] = (clientReq.url ?? "").split(":");
  const targetPort = Number(portStr) || DEFAULT_PORT_HTTPS;
  if (!targetHost) {
    clientSocket.end(HTTP_502_BAD_GATEWAY);
    return;
  }

  emit({ type: "debug", message: () => `tunnel ${clientReq.url} via upstream ${upstreamHost}:${upstreamPort} (mode: client)` });

  const upstreamAuth = resolveUpstreamAuth();
  const authLine = upstreamAuth === undefined ? undefined : `${HEADER_NAME_PROXY_AUTHORIZATION}: ${upstreamAuth}`;
  // CONNECT 下沉到 connectors/tunnel：拨号+发 CONNECT+等 200 全在里面，成功 resolve socket
  dialTunnelViaUpstream(clientSocket, upstreamHost, upstreamPort, targetHost, targetPort, {
    authLine,
    guardOpts: { target: `${clientReq.url} via ${upstreamHost}:${upstreamPort}` },
  }).then(
    ({ socket, dial, rest }) => {
      const upstreamSocket = socket as unknown as net.Socket;
      dial.established();
      clientSocket.write(HTTP_200_CONNECTION_ESTABLISHED);
      if (head.length > 0) upstreamSocket.write(head);
      if (rest.length > 0) clientSocket.write(rest);
      bridgeSockets(clientSocket, socket);
    },
    (err: Error) => {
      emit({ type: "upstream-refused", statusLine: err.message });
    },
  );
}

/**
 * 直透分支：解析器已吃掉原始 CONNECT 行，用 method/url/httpVersion/rawHeaders
 * 重建后一次写给上游（proxy-* 头已滤，客户端凭证到此为止），此后前级只做 TCP
 * pipe，上游的 200/407 直达客户端
 */
function forwardTunnelTransparent(
  clientReq: http.IncomingMessage,
  clientSocket: import("node:stream").Duplex,
  head: Buffer,
  upstreamHost: string,
  upstreamPort: number,
  emit: (e: PipeEvent) => void,
): void {
  emit({ type: "debug", message: () => `tunnel ${clientReq.url} transparent via upstream ${upstreamHost}:${upstreamPort} (mode: client)` });

  const headerLines = rebuildHeaderLines(clientReq);
  const rebuilt =
    `${clientReq.method} ${clientReq.url} HTTP/${clientReq.httpVersion}${CRLF}` +
    (headerLines.length > 0 ? headerLines.join(CRLF) + CRLF : "") +
    DOUBLE_CRLF;

  dialUpstream(clientSocket, upstreamHost, upstreamPort, (upstreamSocket, dial) => {
    dial.established();
    upstreamSocket.write(rebuilt);
    if (head.length > 0) upstreamSocket.write(head);
    bridgeSockets(clientSocket, upstreamSocket);
  }, { target: `${clientReq.url} via ${upstreamHost}:${upstreamPort}` });
}
