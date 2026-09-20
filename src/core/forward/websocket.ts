import http from "node:http";
import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import { checkTargetHost } from "@/config/acl.js";
import {
  createEventEmitter,
  isSelfLoop,
  isProxyCredentialValue,
  parseTargetParts,
  readResponseHead,
  type TargetParts,
} from "@/core/proxy-helpers.js";
import {
  CRLF,
  DOUBLE_CRLF,
  HEADER_NAME_HOST_LOWER,
  HEADER_NAME_HOST_TITLE,
  HEADER_PREFIX_PROXY,
  HTTP_403_FORBIDDEN,
  STATUS_SWITCHING_PROTOCOLS,
} from "@/utils/constants.js";
import type { PipeEvent, PipeEventSink } from "@/core/types/proxy.js";
import { Dialer } from "./dial.js";

/**
 * 构建 Upgrade 请求（剔除 proxy-* 头，重写 Host）
 */
function buildUpgradeReq(
  req: http.IncomingMessage,
  host: string,
  port: number,
  path: string,
): string {
  const requestLine = `${req.method} ${path} HTTP/${req.httpVersion}${CRLF}`;

  const headerLines: string[] = [];

  const raw = req.rawHeaders ?? [];

  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];

    if (name.toLowerCase().startsWith(HEADER_PREFIX_PROXY)) {
      continue;
    }

    // 代理凭证（Authorization 回退形态）不得随 upgrade 透传到目标
    if (name.toLowerCase() === "authorization" && isProxyCredentialValue(value)) {
      continue;
    }

    if (name.toLowerCase() === HEADER_NAME_HOST_LOWER) {
      headerLines.push(`${HEADER_NAME_HOST_TITLE}: ${host}:${port}`);
    } else {
      headerLines.push(`${name}: ${value}`);
    }
  }

  return `${requestLine}${headerLines.join(CRLF)}${DOUBLE_CRLF}`;
}

/**
 * WebSocket/Upgrade 转发器
 * Upgrade 语义与 HTTP 类似，但需等 101 才桥接
 */
export class WsForwarder {
  private dialer = new Dialer();

  private readonly emit: (e: PipeEvent) => void;

  constructor(private sink?: PipeEventSink) {
    this.emit = createEventEmitter<PipeEvent>(sink);
  }

  /**
   * Upgrade 入口：client+socks 上游分流走隧道，其余直拨目标等 101
   * @param req 握手请求 @param socket 下游 @param head 已读半包
   */
  handle(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const mode = get("proxyMode");
    const proto = get("upstreamProtocol");

    // socks 上游需真实目标建隧道，而非 upstreamHost
    if (
      mode === "client" &&
      (proto === "socks4" || proto === "socks5" || proto === "sockss4" || proto === "sockss5")
    ) {
      this.viaSocks(req, socket, head, proto);
      return;
    }

    const target =
      mode === "client"
        ? {
            host: get("upstreamHost"),
            port: get("upstreamPort"),
            path: req.url ?? "/",
          }
        : parseTargetParts(req.url ?? "", req.headers.host as string);

    if (!target) {
      socket.destroy();
      return;
    }

    if (isSelfLoop(target.host, target.port)) {
      socket.destroy();
      return;
    }

    if (this.denyIfForbidden(req, target.host, target.port, socket)) {
      return;
    }

    // secure 映射：https 与 sockss* 走 TLS，其余明文
    const secure = mode === "client" && (proto === "https" || proto.startsWith("sockss"));

    this.upgradeOver(
      req,
      socket,
      head,
      target,
      this.dialer.choose(socket, target.host, target.port, secure, {
        logPrefix: "upgrade",
        // 空串即静默 destroy：Upgrade 无响应行可回，区别于 tunnel 回 502
        timeoutReply: "",
        errorReply: "",
      }),
      false,
    );
  }

  /**
   * 目标名单判定：命中即回 403 并收尾
   * @description Upgrade 有请求行可回（与 407 同款写原始响应报文），故回 HTTP_403_FORBIDDEN 而非静默 destroy
   * @param req - 原始 Upgrade 请求（随事件带给日志）
   * @param host - 目标主机
   * @param port - 目标端口
   * @param socket - 客户端双工流
   * @returns true 表示已拒绝，调用方应立即 return
   */
  private denyIfForbidden(
    req: http.IncomingMessage,
    host: string,
    port: number,
    socket: Duplex,
  ): boolean {
    const acl = checkTargetHost(host);
    if (acl.allowed) {
      return false;
    }
    this.emit({
      type: "target-denied",
      target: `${host}:${port}`,
      host,
      reason: acl.reason,
      req,
    });
    socket.end(HTTP_403_FORBIDDEN);
    return true;
  }

  /**
   * 拨号成功后接管 Upgrade：写握手报文（剔 proxy 头 + 重写 Host）→ 回灌已读半包 → 等 101 桥接；
   * 失败统一落盘并销毁客户端（Upgrade 无响应行可回，区别于 tunnel 回 502）
   * @param target - 建链目标（直拨为解析目标，socks 上游为隧道真实目标）
   * @param upstreamDial - 上游拨号 Promise
   * @param viaSocks - 是否经 SOCKS 隧道（仅影响失败日志文案）
   */
  private upgradeOver(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    target: TargetParts,
    upstreamDial: Promise<Duplex>,
    viaSocks: boolean,
  ): void {
    upstreamDial
      .then((upstream) => {
        upstream.write(buildUpgradeReq(req, target.host, target.port, target.path));

        if (head.length) {
          upstream.write(head);
        }

        void this.relay(socket, upstream);
      })
      .catch((err: Error) => {
        // Upgrade 不回报文（无响应行可回），但失败成因必须落盘，否则升级失败在日志里无痕
        this.emit({
          type: "upstream-error",
          message: `[upgrade] upstream error ${viaSocks ? "via socks " : ""}${target.host}:${target.port}: ${err.message}`,
          err,
        });
        socket.destroy();
      });
  }

  /**
   * 经 SOCKS 隧道发 Upgrade：隧道直达真实目标后走同 dial 流程
   */
  private viaSocks(req: http.IncomingMessage, socket: Duplex, head: Buffer, proto: string): void {
    const real = parseTargetParts(req.url ?? "", req.headers.host as string);

    if (!real) {
      socket.destroy();
      return;
    }

    if (isSelfLoop(real.host, real.port)) {
      socket.destroy();
      return;
    }

    if (this.denyIfForbidden(req, real.host, real.port, socket)) {
      return;
    }

    // 版本推导：socks4/sockss4→4，其余→5（secure 另由 sockss* 决定）
    const version: 4 | 5 = proto === "socks4" || proto === "sockss4" ? 4 : 5;

    this.upgradeOver(
      req,
      socket,
      head,
      real,
      this.dialer.dialSocks(socket, real.host, real.port, version, undefined, {
        logPrefix: "upgrade",
        // 空串即静默 destroy：Upgrade 无响应行可回
        timeoutReply: "",
        errorReply: "",
      }),
      true,
    );
  }

  /**
   * 等 101 桥接：严格解析状态行判 101，非 101 原样回源后双关
   * - 状态行用 RE_HTTP_STATUS_LINE 提取三位码严格比对，避免 `302` + `Content-Length: 1010`
   *   之类子串被 `includes("101")` 误判为升级成功
   * - 等待响应期间以 upstreamTimeout 兜底：超时销毁双方；收到完整响应头（判定点）后清除
   */
  private async relay(client: Duplex, upstream: Duplex): Promise<void> {
    // 自建读超时（Upgrade 无拨号守卫接管）：超时销毁双方
    const res = await readResponseHead(upstream, {
      timeout: get("upstreamTimeout") as number,
      onTimeout: () => {
        if (!upstream.destroyed) {
          upstream.destroy();
        }

        if (!client.destroyed) {
          client.destroy();
        }
      },
    });

    if (!res) {
      // 超时（onTimeout 已双毁）或缓冲封顶：同样双毁，兜底幂等
      if (!upstream.destroyed) {
        upstream.destroy();
      }

      if (!client.destroyed) {
        client.destroy();
      }

      return;
    }

    // 严格取状态码：仅 101 视为升级成功，杜绝 `302` + `Content-Length: 1010` 之类子串误判
    if (res.statusCode === String(STATUS_SWITCHING_PROTOCOLS)) {
      client.write(res.head);

      if (res.rest.length) {
        client.write(res.rest);
      }

      this.dialer.bridge(client, upstream);
    } else {
      client.write(Buffer.concat([res.head, res.rest]));
      upstream.destroy();
      client.destroy();
    }
  }
}

export function forwardUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  sink?: PipeEventSink,
): void {
  new WsForwarder(sink).handle(req, socket, head);
}
