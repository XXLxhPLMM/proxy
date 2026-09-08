/**
 * @fileoverview 代理领域共享工具集
 * @module core/proxy-helpers
 * @description
 * 本文件收敛代理链路中跨转发/隧道/认证复用的纯工具：
 * 头部处理、目标解析、凭证编码、CONNECT 报文构造与隧道拨号守卫。
 *
 * 职责：
 * - 头部域：识别/剥离代理相关头（Proxy-Authorization 等）、净化出站头（强制 `Connection: close`）
 * - 解析域：`parseTargetParts`（从绝对 URL 或 Host 头解析 host/port/path）、`parseAuthority`（拆 CONNECT authority）
 * - 编码域：`encodeBasicCredentials` / `buildConnectRequest`（构造上游 CONNECT 报文）
 * - 守卫域：`guardDialing`（为上下游 Duplex 绑定超时/错误/半关闭联动，提供未 established 前的 502/504 兜底回复）
 * - 自环检测：`isSelfLoop`（委托 `utils/ip:isSelfLoopAddr` 并注入当前监听 host/port）
 *
 * 设计要点：
 * - 纯函数优先：除 `guardDialing` 需绑定事件外，其余均为无副作用纯函数，便于单测
 * - 零日志：通过 `HelperEvent / HelperEventSink` 事件槽上抛，日志由 server 层落盘，避免转发层直接依赖 logger
 * - 大小写不敏感：`isProxyHeaderName` 统一转小写比对，兼容 Node 头名大小写差异
 * - 依赖方向：`proxy-helpers → utils/*` 单向，`tunnelConnect/bridgeSockets` 已迁至 `connectors/base.ts`，避免循环
 * - 常量收敛：所有协议常量（CRLF/状态行/默认端口/头名）均来自 `utils/constants.ts`，禁止内联魔数
 *
 * 使用示例：
 * ```ts
 * import { parseTargetParts, guardDialing, sanitizeHeaders, buildConnectRequest } from "@/core/proxy-helpers.js";
 *
 * // 1) 解析目标
 * const parts = parseTargetParts(req.url!, req.headers.host, "http:"); // => { host, port, path }
 *
 * // 2) 净化出站头
 * const outHeaders = sanitizeHeaders({ ...req.headers });
 *
 * // 3) 隧道守卫
 * const g = guardDialing(clientSocket, upstreamSocket, {
 *   target: "example.com:443",
 *   timeout: 10_000,
 *   onEvent: (e) => console.log(e.type, e.message),
 * });
 * // 建链成功后
 * g.established();
 *
 * // 4) 构造 CONNECT 报文（经 http 上游转发时）
 * const raw = buildConnectRequest("example.com", 443, "Proxy-Authorization: Basic xxx");
 * upstreamSocket.write(raw);
 * ```
 */

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
} from "@/utils/constants.js";
import { get } from "@/config/store.js";
import { isSelfLoopAddr } from "@/utils/ip.js";

/**
 * 助手事件（由 guardDialing 等工具产生，经 HelperEventSink 上抛）
 * @param type - 事件类型：dial（拨号中）/ established（已建链）/ upstream-timeout / upstream-error / client-error
 * @param message - 人类可读的描述（已含 [prefix] 前缀与路由信息）
 * @param err - 关联的原始异常（可选）
 * @example { type: "upstream-timeout", message: "[tunnel] timeout 1.2.3.4 -> example.com:443" }
 */
export interface HelperEvent {
  type: "dial" | "established" | "upstream-timeout" | "upstream-error" | "client-error";
  message: string;
  err?: unknown;
}

/**
 * 助手事件汇（回调类型）
 * @param e - 助手事件对象
 * @example const sink: HelperEventSink = (e) => logger.warn(e.message);
 */
export type HelperEventSink = (e: HelperEvent) => void;

/**
 * 创建通用事件发射器（容错包装）
 * @description 对 `sink` 的调用包裹 try/catch，避免业务回调异常反噬主流程
 * @param sink - 事件汇回调，可能为 undefined
 * @returns 包装后的发射函数 `(e) => void`，内部吞掉回调异常
 * @example const emit = createEventEmitter<HelperEvent>(onEvent); emit({ type: "dial", message: "..." });
 */
export function createEventEmitter<T>(sink?: (e: T) => void): (e: T) => void {
  return (e) => {
    try {
      sink?.(e);
    } catch {}
  };
}

/**
 * 创建助手事件发射器
 * @description `createEventEmitter<HelperEvent>` 的语义别名，使调用点意图更清晰
 * @param s - 助手事件汇
 * @returns 包装后的发射函数
 * @example const emit = createHelperEmitter(onEvent);
 */
export function createHelperEmitter(s?: HelperEventSink): (e: HelperEvent) => void {
  return createEventEmitter(s);
}

const PROXY_HEADERS = new Set(
  [
    HEADER_NAME_PROXY_AUTHENTICATE,
    HEADER_NAME_PROXY_AUTHORIZATION,
    HEADER_NAME_PROXY_CONNECTION,
  ].map((n) => n.toLowerCase()),
);

/**
 * 判断是否为代理相关的头名
 * @description 对传入的头名转小写后比对 `Proxy-Authorization / Proxy-Authenticate / Proxy-Connection` 三者
 * @param n - 头名（任意大小写）
 * @returns 是否为代理相关头
 * @example isProxyHeaderName("Proxy-Authorization") // => true
 * @example isProxyHeaderName("Content-Type") // => false
 */
export function isProxyHeaderName(n: string): boolean {
  return PROXY_HEADERS.has(n.toLowerCase());
}

/**
 * 剥离代理相关头（原地删除）
 * @description 遍历头字典，删除所有命中 `isProxyHeaderName` 的键；注意会 mutate 传入对象
 * @param h - 头字典（会被原地修改）
 * @returns 同一对象（已删除代理头）
 * @example stripProxyHeaders({ "Proxy-Authorization": "Basic xxx", "Host": "example.com" }) // => { Host: ... }
 */
export function stripProxyHeaders<H extends Record<string, string | string[] | undefined>>(
  h: H,
): H {
  for (const k of Object.keys(h)) {
    if (isProxyHeaderName(k)) {
      delete h[k];
    }
  }
  return h;
}

/**
 * 净化出站头（浅拷贝后剥离代理头并强制 `Connection: close`）
 * @description 先浅拷贝再 `stripProxyHeaders`，避免污染原对象；随后覆写 `connection: close` 以禁用上游长连接
 * @param h - 原始头字典
 * @returns 净化后的新头字典
 * @example sanitizeHeaders(req.headers) // => { host: "...", connection: "close", ... }（无 proxy 头）
 */
export function sanitizeHeaders(
  h: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const s = stripProxyHeaders({ ...h });
  s["connection"] = "close";
  return s;
}

/**
 * 目标三元组
 * @param host - 主机名/IP
 * @param port - 端口号
 * @param path - 请求路径（含 query，如 "/api?page=1"）
 * @example { host: "example.com", port: 80, path: "/index.html" }
 */
export interface TargetParts {
  host: string;
  port: number;
  path: string;
}

/**
 * 解析请求目标为 host/port/path 三元组
 * @description
 * - 若 `raw` 为绝对 URL（`http(s)://...`）：用 `new URL` 解析，端口优先取 URL 显式端口，其次取 Host 头中的端口，最后按协议取默认端口
 * - 否则视为 origin-form：依赖 `hostHeader` 拆出 host/port，缺省端口按 `proto` 判定（https→443，其余→80）
 * @param raw - 请求的 URL 原始字符串（可能是绝对 URL 或 origin-form 的 path）
 * @param hostHeader - Host 请求头值（可能含端口，如 "example.com:8080"）
 * @param proto - 协议提示（如 "https:"），用于 origin-form 的默认端口判定
 * @returns 解析成功返回 TargetParts，失败返回 null（绝对 URL 解析异常或缺 Host 头）
 * @example parseTargetParts("http://example.com:8080/api?q=1", "example.com:8080") // => { host:"example.com", port:8080, path:"/api?q=1" }
 * @example parseTargetParts("/api", "example.com") // => { host:"example.com", port:80, path:"/api" }
 * @example parseTargetParts("/api", undefined) // => null
 */
export function parseTargetParts(
  raw: string,
  hostHeader?: string,
  proto?: string,
): TargetParts | null {
  if (RE_ABSOLUTE_URL.test(raw)) {
    try {
      const u = new URL(raw);
      let port = u.port ? Number(u.port) : NaN;
      if (!port && hostHeader) {
        const p = hostHeader.split(":")[1];
        if (p && /^\d+$/.test(p.trim())) {
          port = Number(p);
        }
      }
      if (!port) {
        port = u.protocol === "https:" ? DEFAULT_PORT_HTTPS : DEFAULT_PORT_HTTP;
      }
      return {
        host: u.hostname,
        port,
        path: `${u.pathname}${u.search}` || "/",
      };
    } catch {
      return null;
    }
  }
  if (!hostHeader) {
    return null;
  }
  const [host, ps] = hostHeader.split(":");
  return {
    host,
    port: ps ? Number(ps) : proto?.startsWith("https") ? DEFAULT_PORT_HTTPS : DEFAULT_PORT_HTTP,
    path: raw || "/",
  };
}

/**
 * 解析 CONNECT authority 为 hostname/port
 * @description 按最后的 `:` 分割，缺端口时默认 443；任一分量非法则返回 null
 * @param a - authority 字符串（如 "example.com:443" 或 "example.com"）
 * @returns 解析结果或 null
 * @example parseAuthority("example.com:443") // => { hostname:"example.com", port:443 }
 * @example parseAuthority("example.com") // => { hostname:"example.com", port:443 }
 * @example parseAuthority(":443") // => null
 */
export function parseAuthority(a: string): { hostname: string; port: number } | null {
  const [h, pr] = a.split(":");
  const p = Number(pr ?? DEFAULT_PORT_HTTPS);
  if (!h || Number.isNaN(p)) {
    return null;
  }
  return { hostname: h, port: p };
}

/**
 * 编码 Basic 凭证为 base64
 * @description 按 `username:password` 拼接后做 base64 编码
 * @param u - 用户名
 * @param p - 密码
 * @returns base64 字符串
 * @example encodeBasicCredentials("admin", "s3cr3t") // => "YWRtaW46czNjcjN0"
 */
export function encodeBasicCredentials(u: string, p: string): string {
  return Buffer.from(`${u}:${p}`).toString("base64");
}

/**
 * 构造 CONNECT 请求报文
 * @description 生成 `CONNECT host:port HTTP/1.1\r\nHost: host:port\r\n[extra]\r\nProxy-Connection: keep-alive\r\n\r\n` 形态
 * @param host - 目标主机
 * @param port - 目标端口
 * @param extra - 额外头行（已含 CRLF 结束前的完整头行，如 "Proxy-Authorization: Basic xxx"），可选
 * @returns 完整的 CONNECT 报文字符串
 * @example buildConnectRequest("example.com", 443) // => "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Connection: keep-alive\r\n\r\n"
 * @example buildConnectRequest("example.com", 443, "Proxy-Authorization: Basic xxx") // 额外头会插入在首部
 */
export function buildConnectRequest(host: string, port: number, extra?: string): string {
  const auth = extra ? `${extra}${CRLF}` : "";
  return (
    `CONNECT ${host}:${port} ${HTTP_VERSION}${CRLF}` +
    `Host: ${host}:${port}${CRLF}` +
    `${auth}${HEADER_NAME_PROXY_CONNECTION}: keep-alive${DOUBLE_CRLF}`
  );
}

/**
 * 拨号守卫选项
 * @param logPrefix - 日志前缀（默认 "tunnel"）
 * @param timeout - 超时毫秒数（>0 时为 upstream 设置 setTimeout）
 * @param timeoutReply - 超时时向客户端回复的 HTTP 报文（默认 504）
 * @param errorReply - 出错时向客户端回复的 HTTP 报文（默认 502）
 * @param target - 目标展示字符串（用于日志路由，如 "example.com:443"）
 * @param onEvent - 助手事件汇
 * @param onTimeout - 超时时的额外回调（可选）
 * @param onError - 出错时的额外回调（可选）
 * @example { target: "example.com:443", timeout: 10000, onEvent: (e)=>logger.warn(e.message) }
 */
export interface DialGuardOptions {
  logPrefix?: string;
  timeout?: number;
  timeoutReply?: string;
  errorReply?: string;
  target?: string;
  onEvent?: HelperEventSink;
  onTimeout?: () => void;
  onError?: (e: Error) => void;
}

/**
 * 为上下游 Duplex 绑定拨号守卫
 * @description
 * - 为 upstream 绑定 `timeout` / `error` / `close`，为 client 绑定 `error` / `close`，实现双向联动销毁
 * - 未 `established()` 前的超时/错误会尝试向 client 回写 `timeoutReply` / `errorReply`（502/504）后再销毁
 * - 建链后（调用 `established()`）则直接双向销毁，不再回写 HTTP 报文（此时已进入隧道态）
 * @param client - 客户端 Duplex（通常为入站 socket）
 * @param upstream - 上游 Duplex（dial 成功后的 socket）
 * @param opts - 守卫选项（含超时、回复报文与事件汇）
 * @returns 守卫句柄 `{ established: () => void }`，建链成功后必须调用以切换至稳态
 * @example
 * const guard = guardDialing(client, upstream, { target: "example.com:443", timeout: 10000, onEvent });
 * upstream.on("connect", () => guard.established());
 */
export function guardDialing(
  client: Duplex,
  upstream: Duplex,
  opts: DialGuardOptions = {},
): { established: () => void } {
  const prefix = opts.logPrefix ?? "tunnel";
  const timeoutReply = opts.timeoutReply ?? HTTP_504_GATEWAY_TIMEOUT;
  const errorReply = opts.errorReply ?? HTTP_502_BAD_GATEWAY;
  const emit = createHelperEmitter(opts.onEvent);
  const clientAddr = (client as unknown as net.Socket)?.remoteAddress ?? "unknown";
  const route = opts.target ? `${clientAddr} -> ${opts.target}` : clientAddr;
  let live = false;
  const destroyBoth = (): void => {
    if (!client.destroyed) {
      client.destroy();
    }
    if (!upstream.destroyed) {
      upstream.destroy();
    }
  };
  const ups = upstream as Duplex & { setTimeout?(ms: number): void };
  if ((opts.timeout ?? 0) > 0) {
    ups.setTimeout?.(opts.timeout!);
  }
  upstream.on("timeout", () => {
    emit({
      type: "upstream-timeout",
      message: `[${prefix}] timeout ${route}`,
    });
    try {
      opts.onTimeout?.();
    } catch {}
    if (!live && timeoutReply && (client as unknown as { writable: boolean }).writable) {
      client.end(timeoutReply);
      if (!upstream.destroyed) {
        upstream.destroy();
      }
      return;
    }
    destroyBoth();
  });
  upstream.on("error", (err) => {
    emit({
      type: "upstream-error",
      message: `[${prefix}] error ${route}`,
      err,
    });
    try {
      opts.onError?.(err as Error);
    } catch {}
    if (!live && errorReply && (client as unknown as { writable: boolean }).writable) {
      client.end(errorReply);
      if (!upstream.destroyed) {
        upstream.destroy();
      }
      return;
    }
    destroyBoth();
  });
  client.on("error", (err) => {
    emit({
      type: "client-error",
      message: `[${prefix}] client error ${route}`,
      err,
    });
    destroyBoth();
  });
  client.on("close", () => {
    if (!upstream.destroyed) {
      upstream.destroy();
    }
  });
  upstream.on("close", () => {
    if (!client.destroyed) {
      client.destroy();
    }
  });
  return {
    established: () => {
      live = true;
      ups.setTimeout?.(0);
    },
  };
}

/**
 * 判断是否为指向自身监听地址的自环请求
 * @description 委托 `utils/ip:isSelfLoopAddr`，自动注入当前配置的 `host/port`
 * @param h - 目标主机名/IP
 * @param p - 目标端口
 * @returns 是否为自环（命中则应直接拒绝，避免代理环路）
 * @example isSelfLoop("127.0.0.1", 7890) // 若当前监听 127.0.0.1:7890 则为 true
 */
export function isSelfLoop(h: string, p: number): boolean {
  return isSelfLoopAddr(h, p, get("host"), get("port"));
}
