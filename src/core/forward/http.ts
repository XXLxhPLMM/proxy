import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import net from "node:net";
import { get } from "@/config/store.js";
import {
  isSelfLoop,
  sanitizeHeaders,
  parseTargetParts,
  encodeBasicCredentials,
} from "@/core/proxy-helpers.js";
import {
  buildProxyAuthValue,
  CRLF,
  DOUBLE_CRLF,
  DOUBLE_CRLF_BUF,
  HEADER_NAME_CONNECTION,
  HEADER_NAME_HOST_LOWER,
  HEADER_VALUE_CLOSE,
  HTTP_502_BAD_GATEWAY,
  RE_HTTP_STATUS_LINE,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
} from "@/utils/constants.js";
import type { PipeEventSink } from "@/core/types/proxy.js";
import { Dialer } from "./dial.js";

/**
 * 上游鉴权头：仅当显式配置 upstreamUsername 时携带
 * 仅 client 模式透传上游时使用，server 直连不带
 */
function upstreamAuth(): string | undefined {
  const u = get("upstreamUsername");

  if (!u) {
    return undefined;
  }

  return buildProxyAuthValue(encodeBasicCredentials(u, get("upstreamPassword")));
}

/**
 * 读取上游 CA（自签场景），不存在则回退系统信任库
 */
function readCa(): Buffer | undefined {
  const p = get("upstreamCa");

  if (p && fs.existsSync(p)) {
    return fs.readFileSync(p);
  }

  return undefined;
}

/**
 * HTTP 转发器
 * - server 模式：解析 req.url/host 直连目标
 * - client 模式：按 upstreamProtocol 选
 *   http/https/socks 串联上游，自动注入 Proxy-Authorization
 */
export class HttpForwarder {
  private dialer = new Dialer();

  constructor(private sink?: PipeEventSink) {}

  // sink 异常静默吞掉：日志回调不得炸掉转发链
  private emit(e: unknown): void {
    try {
      this.sink?.(e as never);
    } catch {}
  }

  /**
   * 入口：根据 proxyMode 与 upstreamProtocol 分发
   * 任意协议的 client 都可转发到任意上游：
   * http/https 走 http(s).request，socks 走 SOCKS 隧道
   */
  handle(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): void {
    const mode = get("proxyMode");

    // client 串联时：目标即上游；
    // server 直连时：从绝对 URL / Host 解析真实目标
    const target =
      mode === "client"
        ? {
            host: get("upstreamHost"),
            port: get("upstreamPort"),
            path: clientReq.url ?? "/",
          }
        : parseTargetParts(clientReq.url ?? "", clientReq.headers.host as string);

    if (!target) {
      this.emit({ type: "target-unresolved" });

      if (!clientRes.headersSent) {
        clientRes.writeHead(STATUS_BAD_REQUEST);
      }

      clientRes.end(HTTP_502_BAD_GATEWAY);
      return;
    }

    // 自环防护：避免代理连向自身导致死循环
    if (isSelfLoop(target.host, target.port)) {
      this.emit({ type: "loop" });

      if (!clientRes.headersSent) {
        clientRes.writeHead(STATUS_BAD_GATEWAY);
      }

      clientRes.end(HTTP_502_BAD_GATEWAY);
      return;
    }

    const proto = mode === "client" ? get("upstreamProtocol") : "http";

    if (proto === "https" || proto === "sockss4" || proto === "sockss5") {
      this.forwardHttps(clientReq, clientRes, target);
      return;
    }

    if (proto === "socks4" || proto === "socks5") {
      this.forwardViaSocks(clientReq, clientRes);
      return;
    }

    this.forwardHttp(clientReq, clientRes, target);
  }

  /**
   * 明文通道：server 直连与 http 上游共用 http.request
   */
  private forwardHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: { host: string; port: number; path: string },
  ): void {
    const headers: Record<string, string | string[] | undefined> = sanitizeHeaders(
      req.headers as never,
    );

    // 仅显式配 upstreamUsername 才注入：防 client 头透传泄漏
    if (get("proxyMode") === "client") {
      const auth = upstreamAuth();

      if (auth) {
        (headers as Record<string, unknown>)["proxy-authorization"] = auth;
      }
    }

    const isUpstream = get("proxyMode") === "client";
    const path = isUpstream ? req.url! : target.path;

    const opts: http.RequestOptions = {
      host: target.host,
      port: target.port,
      method: req.method,
      path,
      headers: headers as never,
      timeout: get("upstreamTimeout"),
    };

    const proxy = http.request(opts, (upRes) => {
      // 无状态行归属 502：上游未给有效响应即网关无应答
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });

    proxy.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(STATUS_BAD_GATEWAY);
      }

      res.end(HTTP_502_BAD_GATEWAY);
    });

    // timeout 只 destroy：具体 502 由 error 兜底统一回
    proxy.on("timeout", () => {
      proxy.destroy();
    });

    req.pipe(proxy);
  }

  /**
   * TLS 通道：https / sockss* 共用 https.request，按建链目标校验 SNI
   */
  private forwardHttps(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: { host: string; port: number; path: string },
  ): void {
    const headers: Record<string, string | string[] | undefined> = sanitizeHeaders(
      req.headers as never,
    );

    // 仅显式配 upstreamUsername 才注入：防 client 头透传泄漏
    if (get("proxyMode") === "client") {
      const auth = upstreamAuth();

      if (auth) {
        (headers as Record<string, unknown>)["proxy-authorization"] = auth;
      }
    }

    const isUpstream = get("proxyMode") === "client";
    const path = isUpstream ? req.url! : target.path;

    const opts: https.RequestOptions = {
      host: target.host,
      port: target.port,
      method: req.method,
      path,
      headers: headers as never,
      timeout: get("upstreamTimeout"),
      // 证书校验必须锚定建链目标，而非转发的 Host 头（Host 是源站名）
      // IP 按 RFC6066 置空 servername（跳过 SNI，按连接 host 校验 SAN-IP）
      servername: net.isIP(target.host) ? "" : target.host,
      rejectUnauthorized: !get("upstreamInsecure"),
      ca: readCa(),
    };

    const proxy = https.request(opts, (upRes) => {
      // 无状态行归属 502：上游未给有效响应即网关无应答
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });

    proxy.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(STATUS_BAD_GATEWAY);
      }

      res.end(HTTP_502_BAD_GATEWAY);
    });

    // timeout 只 destroy：具体 502 由 error 兜底统一回
    proxy.on("timeout", () => {
      proxy.destroy();
    });

    req.pipe(proxy);
  }

  /**
   * SOCKS 上游：先经 Dialer 建 SOCKS 隧道，再在隧道上发原始 HTTP 报文
   * 满足“任意 client → 任意上游”：
   * http 服务的 client 也可走 socks 上游
   */
  private forwardViaSocks(req: http.IncomingMessage, res: http.ServerResponse): void {
    // socks 上游需知道真实目标（而非 upstreamHost），从 req 重新解析
    const real = parseTargetParts(req.url ?? "", req.headers.host as string);

    if (!real) {
      if (!res.headersSent) {
        res.writeHead(STATUS_BAD_REQUEST);
      }

      res.end(HTTP_502_BAD_GATEWAY);
      return;
    }

    // 真实目标已重解析，需二次自环校验
    if (isSelfLoop(real.host, real.port)) {
      if (!res.headersSent) {
        res.writeHead(STATUS_BAD_GATEWAY);
      }

      res.end(HTTP_502_BAD_GATEWAY);
      return;
    }

    this.dialViaSocksAndForward(req, res, real).catch(() => {
      if (!res.headersSent) {
        res.writeHead(STATUS_BAD_GATEWAY);
      }

      res.end(HTTP_502_BAD_GATEWAY);
    });
  }

  /**
   * 经 SOCKS 隧道发 HTTP：隧道直达真实目标后手拼报文
   * @param target 真实目标（非 upstreamHost）；异常由调用方统一转 502
   */
  private async dialViaSocksAndForward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: { host: string; port: number; path: string },
  ): Promise<void> {
    // 经 upstreamHost:upstreamPort 建到真实目标的隧道
    const proto = get("upstreamProtocol");
    const version: 4 | 5 = proto === "socks4" || proto === "sockss4" ? 4 : 5;

    const tunnel = await this.dialer.dialSocks(
      req.socket as unknown as import("node:stream").Duplex,
      target.host,
      target.port,
      version,
    );

    const headers = sanitizeHeaders(req.headers as never);

    // socks 隧道直达目标，不带 Proxy-Authorization（已在 SOCKS 层外）
    // 重写 Host 对齐目标；强制 close 让源站关连接，隧道按字节透传无需分帧
    headers[HEADER_NAME_HOST_LOWER] = `${target.host}:${target.port}`;
    headers[HEADER_NAME_CONNECTION] = HEADER_VALUE_CLOSE;

    // 多值头只取首项：手拼报文无法表多值，Cookie 合并可能丢值（简化取舍）
    const headerLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v[0] : v}`)
      .join(CRLF);

    const requestHead =
      `${req.method} ${target.path} HTTP/${req.httpVersion}` +
      `${CRLF}${headerLines}${DOUBLE_CRLF}`;

    tunnel.write(requestHead);

    // 请求体透传：end:false，请求结束不能 FIN 隧道（否则响应回不来）
    // 隧道生命周期由目标的 connection:close / 双关接管
    req.pipe(tunnel, { end: false });

    let buf = Buffer.alloc(0);

    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);

      const idx = buf.indexOf(DOUBLE_CRLF_BUF);

      if (idx === -1) {
        return;
      }

      tunnel.off("data", onData);

      const headerBlock = buf.subarray(0, idx).toString();
      const remain = buf.subarray(idx + DOUBLE_CRLF_BUF.length);

      // 无状态行归属 502：隧道对端无有效 HTTP 应答
      const statusMatch = headerBlock.match(RE_HTTP_STATUS_LINE);
      const statusCode = statusMatch ? Number(statusMatch[1]) : 502;

      // 响应头不逐行解析：仅回状态码，body 交管道透传（简化取舍）
      res.writeHead(statusCode);

      if (remain.length) {
        res.write(remain);
      }

      tunnel.pipe(res);
    };

    tunnel.on("data", onData);

    tunnel.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(STATUS_BAD_GATEWAY);
      }

      res.end(HTTP_502_BAD_GATEWAY);
    });
  }
}

export function forwardHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sink?: PipeEventSink,
): void {
  new HttpForwarder(sink).handle(req, res);
}
