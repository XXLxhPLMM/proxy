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
  DEFAULT_PORT_HTTPS,
  DOUBLE_CRLF,
  HTTP_504_GATEWAY_TIMEOUT,
  HTTP_200_CONNECTION_ESTABLISHED,
  HTTP_VERSION,
  RE_ABSOLUTE_URL,
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
 * 解析目标 URL - 兼容代理显式写法与直连写法
 * @param req - 入站请求
 * @returns 合法 URL 或 null
 */
export function resolveTargetUrl(req: http.IncomingMessage): URL | null {
  const raw = req.url ?? "";
  try {
    if (RE_ABSOLUTE_URL.test(raw)) return new URL(raw);
    const host = req.headers.host;
    if (!host) return null;
    const proto = (req.headers["x-forwarded-proto"] as string) || "http:";
    const prefix = proto.endsWith(":") ? proto : `${proto}:`;
    return new URL(`${prefix}//${host}${raw.startsWith("/") ? raw : `/${raw}`}`);
  } catch {
    return null;
  }
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
 * 带有 setTimeout 方法的接口
 */
interface Timeoutable {
  setTimeout(ms: number, callback: () => void): void;
}

/**
 * 包装超时处理 - 超时后自动销毁并回调
 * @param target - 需要超时保护的对象（net.Socket 或 http.ClientRequest）
 * @param timeout - 超时时间 ms
 * @param onTimeout - 超时回调
 */
export function wrapTimeout(
  target: Timeoutable,
  timeout: number,
  onTimeout: () => void,
): { clear: () => void; isTimedOut: () => boolean } {
  let timedOut = false;
  if (timeout > 0) {
    target.setTimeout(timeout, () => {
      timedOut = true;
      onTimeout();
    });
  }
  return {
    clear: () => target.setTimeout(0, () => {}),
    isTimedOut: () => timedOut,
  };
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

/**
 * 构建 HTTP 请求头字符串
 * @param method - HTTP 方法
 * @param url - 目标 URL
 * @param headers - 请求头
 * @returns 请求头字符串
 */
export function buildHttpRequestHeaders(
  method: string,
  url: URL,
  headers: Record<string, string | string[] | undefined>,
): string {
  const headerLines = Object.entries(headers)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join(CRLF);

  const hasHost = Object.keys(headers).some((k) => k.toLowerCase() === "host");
  const hostLine = hasHost ? "" : `Host: ${url.host}${CRLF}`;

  return `${method} ${url.pathname}${url.search} ${HTTP_VERSION}${CRLF}${hostLine}${headerLines}${CRLF}Connection: close${DOUBLE_CRLF}`;
}

/**
 * 设置客户端 socket 超时并处理错误
 * @param clientSocket - 客户端 socket
 * @param serverSocket - 服务端 socket
 * @param timeout - 超时时间 ms
 * @param context - 上下文日志前缀
 * @param onBeforeDestroy - 超时销毁前回调（SOCKS 等协议可在此写入拒绝帧）
 */
export function setupTunnelTimeout(
  clientSocket: net.Socket,
  serverSocket: net.Socket,
  timeout: number,
  context?: string,
  onBeforeDestroy?: () => void,
): { isTimedOut: () => boolean } {
  let timedOut = false;

  if (timeout > 0) {
    serverSocket.setTimeout(timeout, () => {
      if (serverSocket.destroyed) return;
      timedOut = true;
      const prefix = context ? `[${context}]` : "[tunnel]";
      log.warn(`${prefix} upstream timeout after ${timeout}ms`);
      try {
        onBeforeDestroy?.();
        if (!clientSocket.destroyed) {
          clientSocket.write(HTTP_504_GATEWAY_TIMEOUT);
          clientSocket.destroy();
        }
      } catch {}
      serverSocket.destroy();
    });
  }

  return { isTimedOut: () => timedOut };
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
 * 消除 http.ts / tls.ts / socks4.ts / socks5.ts 中的重复隧道代码
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
    serverSocket.setTimeout(0);
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
    clientSocket.pipe(serverSocket);
    serverSocket.pipe(clientSocket);
  });

  const timer = setupTunnelTimeout(clientSocket as unknown as net.Socket, serverSocket, timeout, logPrefix, () => onBeforeDestroy?.("timeout"));

  const destroyBoth = (): void => {
    clientSocket.destroy();
    serverSocket.destroy();
  };

  const onErr = (side: string) => (err: Error) => {
    if (timer.isTimedOut()) return;
    log.warn(`[${logPrefix}] ${side} error ${clientAddr} -> ${hostname}:${port}:`, err.message);
    onBeforeDestroy?.("error", err);
    destroyBoth();
  };
  clientSocket.on("error", onErr("client"));
  serverSocket.on("error", onErr("upstream"));
  clientSocket.on("close", () => serverSocket.destroy());
  serverSocket.on("close", () => clientSocket.destroy());
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
