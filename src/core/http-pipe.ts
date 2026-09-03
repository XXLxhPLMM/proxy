/**
 * HTTP 请求管道 - 负责客户端与上游之间的数据转发
 * 职责：
 * - forwardHttp：普通 HTTP 请求转发，server 模式从请求解析目标，client 模式用上游配置
 * - forwardTunnel：CONNECT 隧道转发，同上逻辑
 * - forwardUpgrade：WebSocket 等协议升级转发
 * 设计：纯函数，无状态，根据 proxyMode 自动选择目标来源
 * 注意：本层零日志——观测点经可选 onEvent 槽抛出 PipeEvent，由调用方转抛，缺省静默
 */

import http from "node:http";
import net from "node:net";
import { get, type AppConfig } from "@/config/store.js";
import { bridgeSockets, createEventEmitter, encodeBasicCredentials, guardUpstreamRequest, isProxyHeaderName, isSelfLoop, parseTargetParts, sanitizeHeaders, type DialGuardOptions, type TargetParts } from "@/utils/proxy-helpers.js";
import {
  CRLF,
  DEFAULT_PORT_HTTPS,
  DOUBLE_CRLF,
  DOUBLE_CRLF_BUF,
  HEADER_NAME_PROXY_AUTHORIZATION,
  HTTP_200_CONNECTION_ESTABLISHED,
  HTTP_502_BAD_GATEWAY,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_SWITCHING_PROTOCOLS,
  buildProxyAuthValue,
} from "@/utils/constants.js";
import type { PipeEvent, PipeEventSink } from "./types/pipe.js";
import { dialHttpUpstream, dialTunnelViaUpstream } from "./connectors/index.js";

/** 普通 HTTP 目标解析：client 模式读上游配置，server 模式从 URL/Host 双来源解析，失败返回 null 由调用方 emit */
function resolveHttpTarget(clientReq: http.IncomingMessage, mode: AppConfig["proxyMode"]): TargetParts | null {
  if (mode === "client") {
    return { host: get("upstreamHost"), port: get("upstreamPort"), path: clientReq.url ?? "/" };
  }
  return parseTargetParts(clientReq.url ?? "", clientReq.headers.host);
}

/**
 * 上游鉴权头值：只认显式 upstreamUsername/Password，未配返回 undefined（不带头）
 */
function resolveUpstreamAuth(
  username: string = get("upstreamUsername"),
  password: string = get("upstreamPassword"),
): string | undefined {
  if (!username) return undefined;
  return buildProxyAuthValue(encodeBasicCredentials(username, password));
}

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

/** 构造事件发射器：PipeEvent 特化（存量兼容，内部即通用版） */
function createPipeEmitter(onEvent?: PipeEventSink): (e: PipeEvent) => void {
  return createEventEmitter<PipeEvent>(onEvent);
}

/**
 * 建链：复用 connectors/dialHttpUpstream（Promise<socket>），成功回调里写首包
 * （tunnel server / 透明分支 / upgrade 共用；失败时守卫已写 502/504 兜底，这里只吞 reject 防未处理）
 */
function dialUpstream(
  clientSocket: import("node:stream").Duplex,
  host: string,
  port: number,
  onConnect: (upstreamSocket: net.Socket, dial: { established: () => void }) => void,
  guardOpts?: DialGuardOptions,
): void {
  dialHttpUpstream(clientSocket, host, port, guardOpts).then(
    ({ socket, dial }) => onConnect(socket as unknown as net.Socket, dial),
    () => {},
  );
}

/** 重建请求头行：rawHeaders 扁平数组回填，proxy-* 头过滤，hostRewrite 传了就重写 Host */
function rebuildHeaderLines(
  clientReq: http.IncomingMessage,
  hostRewrite?: string,
): string[] {
  const lines: string[] = [];
  const raw = clientReq.rawHeaders ?? [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    if (isProxyHeaderName(name)) continue;
    if (hostRewrite !== undefined && name.toLowerCase() === "host") {
      lines.push(`Host: ${hostRewrite}`);
    } else {
      lines.push(`${name}: ${raw[i + 1]}`);
    }
  }
  return lines;
}

/** 等上游响应头块：攒 Buffer 到 DOUBLE_CRLF 后一次性交判定（CONNECT 重发 / upgrade 101 共用） */
function collectHeaderBlock(
  upstreamSocket: import("node:stream").Duplex,
  onBlock: (headerBlock: Buffer, rest: Buffer) => void,
): void {
  let pending = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf(DOUBLE_CRLF_BUF);
    if (end === -1) return;
    upstreamSocket.removeListener("data", onData);
    onBlock(pending.subarray(0, end + DOUBLE_CRLF_BUF.length), pending.subarray(end + DOUBLE_CRLF_BUF.length));
  };
  upstreamSocket.on("data", onData);
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

/**
 * WebSocket/Upgrade 协议升级转发
 * - server 模式：从请求 URL / Host 头解析目标
 * - client 模式：使用上游配置（upstreamHost/upstreamPort）
 * 流程：解析目标 → 自环 guard → 建 TCP → 写升级请求 → 等 101 → 双向 pipe
 */
export function forwardUpgrade(
  clientReq: http.IncomingMessage,
  clientSocket: import("node:stream").Duplex,
  head: Buffer,
  onEvent?: PipeEventSink,
): void {
  const emit = createPipeEmitter(onEvent);
  const mode = get("proxyMode");
  const target = resolveHttpTarget(clientReq, mode);
  if (!target) {
    emit({ type: "target-unresolved", url: clientReq.url });
    clientSocket.destroy();
    return;
  }

  // 防止循环转发：目标地址是代理自身
  if (isSelfLoop(target.host, target.port)) {
    emit({ type: "loop-detected", detail: `upgrade ${clientReq.url} -> ${target.host}:${target.port}` });
    clientSocket.destroy();
    return;
  }

  emit({ type: "debug", message: () => `upgrade ${clientReq.url} -> ${target.host}:${target.port} (mode: ${mode})` });

  // 无 ServerResponse 可写，建链失败只断开不写兜底
  dialUpstream(clientSocket, target.host, target.port, (upstreamSocket, dial) => {
    const upgradeRequest = buildUpgradeRequest(clientReq, target.host, target.port, target.path);
    emit({ type: "debug", message: () => `upgrade request:\n${upgradeRequest}` });
    upstreamSocket.write(upgradeRequest);

    // 转发 head 中的剩余数据
    if (head.length > 0) {
      upstreamSocket.write(head);
    }

    relayUpgradeHandshake(clientSocket, upstreamSocket, dial);
  }, { logPrefix: "upgrade", timeoutReply: "", errorReply: "" });
}

/** 重建 HTTP Upgrade 请求：相对路径 + rawHeaders 回填（proxy-* 头已滤），Host 重写为目标 */
function buildUpgradeRequest(
  clientReq: http.IncomingMessage,
  targetHost: string,
  targetPort: number,
  targetPath: string,
): string {
  const requestLine = `${clientReq.method} ${targetPath} HTTP/${clientReq.httpVersion}${CRLF}`;
  const headerPairs = rebuildHeaderLines(clientReq, `${targetHost}:${targetPort}`);
  return `${requestLine}${headerPairs.join(CRLF)}${DOUBLE_CRLF}`;
}

/** 等上游 101：成功则回 101 头 + 双向 pipe，失败把上游响应原样甩回客户端 */
function relayUpgradeHandshake(
  clientSocket: import("node:stream").Duplex,
  upstreamSocket: import("node:stream").Duplex,
  dial: { established: () => void },
): void {
  collectHeaderBlock(upstreamSocket, (headerBlock, rest) => {
    if (headerBlock.toString().includes(String(STATUS_SWITCHING_PROTOCOLS))) {
      dial.established();
      clientSocket.write(headerBlock);
      if (rest.length > 0) clientSocket.write(rest);
      bridgeSockets(clientSocket, upstreamSocket, "upgrade");
    } else {
      clientSocket.write(Buffer.concat([headerBlock, rest]));
      upstreamSocket.destroy();
      clientSocket.destroy();
    }
  });
}
