/**
 * 代理公共工具函数 - 消除 core/http 与 client/forward-proxy 重复逻辑
 * 职责：
 * - 清洗 hop-by-hop 头（proxy-connection/proxy-authorization）
 * - 设置 connection: close
 * - 超时处理包装
 * - HTTP 请求构建
 */

import type http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import {
  CRLF,
  DEFAULT_PORT_HTTP,
  DEFAULT_PORT_HTTPS,
  DOUBLE_CRLF,
  HTTP_502_BAD_GATEWAY,
  HTTP_504_GATEWAY_TIMEOUT,
  HTTP_200_CONNECTION_ESTABLISHED,
  HTTP_VERSION,
  RE_ABSOLUTE_URL,
  STATUS_BAD_GATEWAY,
  STATUS_GATEWAY_TIMEOUT,
} from "./constants.js";
import { getLogger } from "./logger.js";
import { get } from "@/config/store.js";

const log = getLogger("proxy-helpers");

/**
 * 清洗请求头 - 删除 hop-by-hop 头，设置 connection: close
 * @param headers - 原始请求头（浅拷贝后修改）
 * @returns 清洗后的请求头
 */
export function sanitizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
  const sanitized = { ...headers };
  delete sanitized["proxy-connection"];
  delete sanitized["proxy-authorization"];
  sanitized["connection"] = "close";
  return sanitized;
}

/**
 * 从请求行 URL 与 Host 头解析目标（server 模式用）
 * - 绝对 URL（http://example.com/path）→ 直接解析
 * - 相对路径 + Host 头 → 补全协议与 host；协议取 protoHeader，缺省 http:
 * http-pipe 与 tls 共用这一份，输出 PipeTarget 形状，各自不再手搓正则
 */
export interface TargetParts {
  host: string;
  port: number;
  /** 上游请求路径（pathname + search，不含 host），避免把 absolute-form 请求行直发 origin server */
  path: string;
}

export function parseTargetParts(raw: string, hostHeader?: string, protoHeader?: string): TargetParts | null {
  if (RE_ABSOLUTE_URL.test(raw)) {
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

  if (!hostHeader) return null;
  const [hostname, portStr] = hostHeader.split(":");
  const proto = protoHeader || "http:";
  return {
    host: hostname,
    port: portStr ? Number(portStr) : proto.startsWith("https") ? DEFAULT_PORT_HTTPS : DEFAULT_PORT_HTTP,
    path: raw || "/",
  };
}

/**
 * 解析 CONNECT authority
 * @param authority - host:port 格式
 * @returns 解析结果或 null
 */
export function parseAuthority(authority: string): { hostname: string; port: number } | null {
  const [hostname, portRaw] = authority.split(":");
  const port = Number(portRaw ?? DEFAULT_PORT_HTTPS);
  if (!hostname || Number.isNaN(port)) return null;
  return { hostname, port };
}

/**
 * 构建 CONNECT 请求
 * @param host - 目标主机
 * @param port - 目标端口
 * @param extraHeaders - 额外头部（如 Proxy-Authorization）
 * @returns CONNECT 请求字符串
 */
export function buildConnectRequest(
  host: string,
  port: number,
  extraHeaders?: string,
): string {
  const authLine = extraHeaders ? `${extraHeaders}${CRLF}` : "";
  return `CONNECT ${host}:${port} ${HTTP_VERSION}${CRLF}Host: ${host}:${port}${CRLF}${authLine}Proxy-Connection: keep-alive${DOUBLE_CRLF}`;
}

/** 隧道拨号选项 */
export interface TunnelOptions {
  /** 客户端 socket（通常是 http 模块的 Duplex） */
  clientSocket: Duplex;
  /** 目标主机 */
  hostname: string;
  /** 目标端口 */
  port: number;
  /** 已读的粘包缓冲 */
  head: Buffer;
  /** 超时 ms */
  timeout: number;
  /** 日志器 */
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
  /** 日志前缀，默认 "tunnel" */
  logPrefix?: string;
  /** 连接成功后写入 serverSocket 的预连接数据（SOCKS 帧等） */
  preConnectData?: Buffer;
  /** 自定义成功响应（默认 HTTP/1.1 200 Connection Established） */
  successResponse?: Buffer;
  /** 成功响应的字符串形式（与 successResponse 二选一，Buffer 类型优先） */
  successResponseStr?: string;
  /** 超时/错误销毁前回调（SOCKS 等协议可在此写入拒绝帧） */
  onBeforeDestroy?: (side: "timeout" | "error", err?: Error) => void;
}

/**
 * 统一隧道拨号逻辑 - net.connect → timeout → establish → pipe
 * 建链期守卫与稳态 pipe 复用 guardDialing / bridgeSockets（与 http-pipe 同一套）
 * 注意：默认 error 不写兜底（SOCKS 等裸 socket 协议写 HTTP 文本即垃圾字节），
 * 有 ServerResponse 的调用方（http-pipe）自行传 errorReply
 */
export function tunnelConnect(opts: TunnelOptions): void {
  const {
    clientSocket,
    hostname,
    port,
    head,
    timeout,
    log,
    logPrefix = "tunnel",
    preConnectData,
    successResponse,
    successResponseStr,
    onBeforeDestroy,
  } = opts;
  const clientAddr = (clientSocket as unknown as net.Socket).remoteAddress ?? "unknown";

  log.info(`[${logPrefix}] dial ${clientAddr} -> ${hostname}:${port}`);
  const serverSocket = net.connect(port, hostname, () => {
    dial.established();
    log.info(`[${logPrefix}] established ${clientAddr} -> ${hostname}:${port}`);
    if (successResponse) {
      clientSocket.write(successResponse);
    } else if (successResponseStr) {
      clientSocket.write(successResponseStr);
    } else {
      clientSocket.write(HTTP_200_CONNECTION_ESTABLISHED);
    }
    if (preConnectData?.length) serverSocket.write(preConnectData);
    if (head.length) serverSocket.write(head);
    bridgeSockets(clientSocket, serverSocket, logPrefix);
  });

  const dial = guardDialing(clientSocket, serverSocket, {
    logPrefix,
    timeout,
    errorReply: "",
    onTimeout: () => onBeforeDestroy?.("timeout"),
    onError: (err) => onBeforeDestroy?.("error", err),
  });
}

/** 建链期守卫选项（兜底传 "" 表示只断开不写，适配 upgrade 这类无 ServerResponse 场景） */
export interface DialGuardOptions {
  /** 日志前缀，默认 "tunnel" */
  logPrefix?: string;
  /** 拨号超时 ms，0 表示不设 */
  timeout?: number;
  /** 建链超时时给客户端的兜底报文，默认 504 */
  timeoutReply?: string;
  /** 建链失败时给客户端的兜底报文，默认 502 */
  errorReply?: string;
  /** 超时销毁前回调（SOCKS 等协议可在此写入拒绝帧） */
  onTimeout?: () => void;
  /** 建链期出错销毁前回调 */
  onError?: (err: Error) => void;
}

/**
 * 建链期一站式守卫：timeout + error + 双向 close，替代各处手搓的 .on() 四件套
 * 建链成功后调用 established() 解除“写兜底”武装，此后出错只断不断写
 * （避免隧道中途被塞 502/504 垃圾），再配 bridgeSockets 进入稳态
 */
export function guardDialing(
  clientSocket: Duplex,
  upstreamSocket: Duplex,
  opts: DialGuardOptions = {},
): { established: () => void } {
  const prefix = opts.logPrefix ?? "tunnel";
  const timeoutReply = opts.timeoutReply ?? HTTP_504_GATEWAY_TIMEOUT;
  const errorReply = opts.errorReply ?? HTTP_502_BAD_GATEWAY;
  let live = false;

  const destroyBoth = (): void => {
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  };

  const ups = upstreamSocket as Duplex & { setTimeout?(ms: number): void };
  const timeout = opts.timeout ?? 0;
  if (timeout > 0) ups.setTimeout?.(timeout);

  upstreamSocket.on("timeout", () => {
    log.warn(`[${prefix}] upstream timeout`);
    try {
      opts.onTimeout?.();
    } catch {}
    if (!live && timeoutReply && clientSocket.writable) {
      clientSocket.end(timeoutReply);
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
      return;
    }
    destroyBoth();
  });

  upstreamSocket.on("error", (err) => {
    log.warn(`[${prefix}] upstream error:`, (err as Error)?.message ?? err);
    try {
      opts.onError?.(err as Error);
    } catch {}
    if (!live && errorReply && clientSocket.writable) {
      clientSocket.end(errorReply);
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
      return;
    }
    destroyBoth();
  });

  clientSocket.on("error", (err) => {
    log.warn(`[${prefix}] client error:`, (err as Error)?.message ?? err);
    destroyBoth();
  });
  clientSocket.on("close", () => {
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  });
  upstreamSocket.on("close", () => {
    if (!clientSocket.destroyed) clientSocket.destroy();
  });

  return {
    established: () => {
      live = true;
      ups.setTimeout?.(0);
    },
  };
}

/**
 * 稳态双向 pipe：建链成功后调用，只断不断写
 * 前提：已配 guardDialing（close 互杀与 client error 由它兜底），这里只补上游 error
 */
export function bridgeSockets(clientSocket: Duplex, upstreamSocket: Duplex, logPrefix = "tunnel"): void {
  upstreamSocket.pipe(clientSocket);
  clientSocket.pipe(upstreamSocket);
  upstreamSocket.on("error", (err) => {
    log.warn(`[${logPrefix}] upstream error:`, (err as Error)?.message ?? err);
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  });
}

/**
 * 普通 HTTP 上游请求守卫：error → 502、timeout → 504、客户端中途断开 → 弃上游
 * 替代 forwardHttp 里手搓的三坨 .on()
 */
export function guardUpstreamRequest(
  upstreamReq: http.ClientRequest,
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  logPrefix = "http",
): void {
  upstreamReq.on("error", (err) => {
    log.error(`[${logPrefix}] upstream request error`, err);
    if (clientRes.writableEnded) return;
    if (!clientRes.headersSent) clientRes.writeHead(STATUS_BAD_GATEWAY);
    clientRes.end(HTTP_502_BAD_GATEWAY);
  });

  upstreamReq.on("timeout", () => {
    log.warn(`[${logPrefix}] upstream request timeout`);
    upstreamReq.destroy();
    if (clientRes.writableEnded) return;
    if (!clientRes.headersSent) clientRes.writeHead(STATUS_GATEWAY_TIMEOUT);
    clientRes.end(HTTP_504_GATEWAY_TIMEOUT);
  });

  clientReq.on("close", () => {
    // 仅当请求体未完整接收（客户端中途断开）时才销毁上游，避免因 close 提前触发导致 RST
    if (!clientReq.complete && !upstreamReq.destroyed) upstreamReq.destroy();
  });
}

/**
 * 检测目标地址是否指向代理自身，防止循环转发
 * 规则：
 * 1. 端口不同 → 不是循环
 * 2. 代理监听 0.0.0.0（所有接口）→ 任何目标+相同端口都是循环
 * 3. 代理监听具体 IP/域名 → 目标地址必须完全匹配才是循环（含 localhost 等价）
 */
export function isSelfLoop(targetHost: string, targetPort: number): boolean {
  const selfHost = get("host");
  const selfPort = get("port");

  // 端口不同，肯定不是循环
  if (targetPort !== selfPort) return false;

  const normalizedTarget = targetHost.toLowerCase();
  const normalizedSelf = selfHost.toLowerCase();

  // 本机地址别名（这些都指向同一个 loopback 接口）
  const localhostAliases = ["localhost", "127.0.0.1", "::1", "[::1]"];

  // 情况1：代理监听 0.0.0.0（所有接口）→ 任何目标+相同端口都是循环
  if (normalizedSelf === "0.0.0.0") {
    return true;
  }

  // 情况2：目标地址与监听地址完全相同
  if (normalizedTarget === normalizedSelf) {
    return true;
  }

  // 情况3：监听的是 localhost 别名，目标也是 localhost 别名
  if (localhostAliases.includes(normalizedSelf) && localhostAliases.includes(normalizedTarget)) {
    return true;
  }

  return false;
}
