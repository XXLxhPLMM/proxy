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
  HEADER_NAME_PROXY_AUTHENTICATE,
  HEADER_NAME_PROXY_AUTHORIZATION,
  HEADER_NAME_PROXY_CONNECTION,
  HTTP_502_BAD_GATEWAY,
  HTTP_504_GATEWAY_TIMEOUT,
  HTTP_VERSION,
  RE_ABSOLUTE_URL,
  STATUS_BAD_GATEWAY,
  STATUS_GATEWAY_TIMEOUT,
} from "@/utils/constants.js";
import { get } from "@/config/store.js";
import { isSelfLoopAddr } from "@/utils/ip.js";

/** 工具层事件（零日志：只抛事件，由 server 层落盘；缺省静默） */
export interface HelperEvent {
  type:
    | "dial"
    | "established"
    | "upstream-timeout"
    | "upstream-error"
    | "client-error"
    | "upstream-request-error"
    | "upstream-request-timeout";
  message: string;
  err?: unknown;
}

/** 工具层事件槽（与 core PipeEventSink 同套路，异常由抛送方隔离） */
export type HelperEventSink = (e: HelperEvent) => void;

/** 通用事件发射器：隔离观察者异常，回调抛错不炸主链路（零日志，静默吞掉） */
export function createEventEmitter<TEvent>(sink?: (e: TEvent) => void): (e: TEvent) => void {
  return (e: TEvent): void => {
    try {
      sink?.(e);
    } catch {}
  };
}

/** 构造事件发射器：HelperEvent 特化（存量兼容，内部即通用版） */
export function createHelperEmitter(onEvent?: HelperEventSink): (e: HelperEvent) => void {
  return createEventEmitter<HelperEvent>(onEvent);
}

/** 代理相关头（RFC 7230/7235）：客户端与代理之间的鉴权/连接语义，禁止透传上游 */
const PROXY_HEADERS = new Set(
  [HEADER_NAME_PROXY_AUTHORIZATION, HEADER_NAME_PROXY_AUTHENTICATE, HEADER_NAME_PROXY_CONNECTION].map((n) =>
    n.toLowerCase(),
  ),
);

/** 是否代理相关头（大小写无关，供报文重建时逐行过滤） */
export function isProxyHeaderName(name: string): boolean {
  return PROXY_HEADERS.has(name.toLowerCase());
}

/**
 * 去代理头 - 大小写无关删除 proxy-* 头，原地修改并返回同一对象
 * http 真请求键恒小写，tls 手解/裸对象允许原样大小写，此处统一按小写比对
 * @param headers - 待清洗的请求头（IncomingMessage.headers 或裸 Record）
 * @returns 传入的同一对象
 */
export function stripProxyHeaders<H extends Record<string, string | string[] | undefined>>(headers: H): H {
  for (const k of Object.keys(headers)) {
    if (isProxyHeaderName(k)) delete headers[k];
  }
  return headers;
}

/**
 * 清洗请求头 - 去代理头并固定 connection: close
 * @param headers - 原始请求头（浅拷贝后修改，不动传入对象）
 * @returns 清洗后的请求头
 */
export function sanitizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
  const sanitized = stripProxyHeaders({ ...headers });
  sanitized["connection"] = "close";
  return sanitized;
}

/**
 * 从请求行 URL 与 Host 头解析目标（server 模式用）
 * - 绝对 URL（http://example.com/path）→ 直接解析
 * - 相对路径 + Host 头 → 补全协议与 host；协议取 protoHeader，缺省 http:
 * forward/http 与 tls 共用这一份，输出 TargetParts 形状
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
      // 绝对 URL 优先；URL 里没写显式端口时再看 Host 头借端口（如 GET http://h/path + Host: h:8081）
      let port = url.port ? Number(url.port) : NaN;
      if (!port && hostHeader) {
        const hostPort = hostHeader.split(":")[1];
        if (hostPort && /^\d+$/.test(hostPort.trim())) port = Number(hostPort);
      }
      if (!port) port = url.protocol === "https:" ? DEFAULT_PORT_HTTPS : DEFAULT_PORT_HTTP;
      return {
        host: url.hostname,
        port,
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
 * Basic 凭证编码（RFC 7617）：base64("username:password")
 * auth 预计算期望值、socks 拼伪 Basic 头、上游鉴权注头共用这一份
 */
export function encodeBasicCredentials(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`).toString("base64");
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
  return `CONNECT ${host}:${port} ${HTTP_VERSION}${CRLF}Host: ${host}:${port}${CRLF}${authLine}${HEADER_NAME_PROXY_CONNECTION}: keep-alive${DOUBLE_CRLF}`;
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
  /** 拨号目标 host:port（或 "url via upstream"），拼进超时/错误日志；不传则只记客户端 */
  target?: string;
  /** 事件槽：超时/错误由此上抛，缺省静默（零日志） */
  onEvent?: HelperEventSink;
  /** 超时销毁前回调（SOCKS 等协议可在此写入拒绝帧） */
  onTimeout?: () => void;
  /** 建链期出错销毁前回调 */
  onError?: (err: Error) => void;
}

/**
 * 建链期一站式守卫：timeout + error + 双向 close
 * 建链成功后调用 established() 解除“写兜底”武装，此后出错只断不断写
 * （避免隧道中途被塞 502/504 垃圾），再配 connectors/base 的 bridgeSockets 进入稳态
 */
export function guardDialing(
  clientSocket: Duplex,
  upstreamSocket: Duplex,
  opts: DialGuardOptions = {},
): { established: () => void } {
  const prefix = opts.logPrefix ?? "tunnel";
  const timeoutReply = opts.timeoutReply ?? HTTP_504_GATEWAY_TIMEOUT;
  const errorReply = opts.errorReply ?? HTTP_502_BAD_GATEWAY;
  const emit = createHelperEmitter(opts.onEvent);
  // 路由定位：客户端地址守卫自取，目标由调用方经 target 传入（5 个拨号点）
  const clientAddr = (clientSocket as unknown as net.Socket)?.remoteAddress ?? "unknown";
  const route = opts.target ? `${clientAddr} -> ${opts.target}` : clientAddr;
  let live = false;

  const destroyBoth = (): void => {
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  };

  const ups = upstreamSocket as Duplex & { setTimeout?(ms: number): void };
  const timeout = opts.timeout ?? 0;
  if (timeout > 0) ups.setTimeout?.(timeout);

  upstreamSocket.on("timeout", () => {
    emit({ type: "upstream-timeout", message: `[${prefix}] upstream timeout ${route}` });
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
    emit({ type: "upstream-error", message: `[${prefix}] upstream error ${route}`, err });
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
    emit({ type: "client-error", message: `[${prefix}] client error ${route}`, err });
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
 * 普通 HTTP 上游请求守卫：error → 502、timeout → 504、客户端中途断开 → 弃上游
 */
export function guardUpstreamRequest(
  upstreamReq: http.ClientRequest,
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  logPrefix = "http",
  onEvent?: HelperEventSink,
): void {
  const emit = createHelperEmitter(onEvent);
  upstreamReq.on("error", (err) => {
    emit({ type: "upstream-request-error", message: `[${logPrefix}] upstream request error`, err });
    if (clientRes.writableEnded) return;
    if (!clientRes.headersSent) clientRes.writeHead(STATUS_BAD_GATEWAY);
    clientRes.end(HTTP_502_BAD_GATEWAY);
  });

  upstreamReq.on("timeout", () => {
    emit({ type: "upstream-request-timeout", message: `[${logPrefix}] upstream request timeout` });
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
 * 检测目标地址是否指向代理自身，防止循环转发（自取 host/port 配置）
 * 规则见 isSelfLoopAddr（ip.ts）
 */
export function isSelfLoop(targetHost: string, targetPort: number): boolean {
  return isSelfLoopAddr(targetHost, targetPort, get("host"), get("port"));
}
