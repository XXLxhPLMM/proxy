import http from "node:http";
import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import { isSelfLoop, parseTargetParts } from "@/core/proxy-helpers.js";
import {
  CRLF,
  DOUBLE_CRLF,
  DOUBLE_CRLF_BUF,
  HEADER_NAME_HOST_LOWER,
  HEADER_NAME_HOST_TITLE,
  HEADER_PREFIX_PROXY,
  RE_HTTP_STATUS_LINE,
  STATUS_SWITCHING_PROTOCOLS,
} from "@/utils/constants.js";
import type { PipeEventSink } from "@/core/types/proxy.js";
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

  constructor(private sink?: PipeEventSink) {}

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

    // secure 映射：https 与 sockss* 走 TLS，其余明文
    const secure = mode === "client" && (proto === "https" || proto.startsWith("sockss"));

    this.dialer
      .choose(socket, target.host, target.port, secure, {
        logPrefix: "upgrade",
        // 空串即静默 destroy：Upgrade 无响应行可回，区别于 tunnel 回 502
        timeoutReply: "",
        errorReply: "",
      })
      .then((upstream) => {
        upstream.write(buildUpgradeReq(req, target.host, target.port, target.path));

        if (head.length) {
          upstream.write(head);
        }

        this.relay(socket, upstream);
      })
      .catch(() => {
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

    // 版本推导：socks4/sockss4→4，其余→5（secure 另由 sockss* 决定）
    const version: 4 | 5 = proto === "socks4" || proto === "sockss4" ? 4 : 5;

    this.dialer
      .dialSocks(socket, real.host, real.port, version, undefined, {
        logPrefix: "upgrade",
        // 空串即静默 destroy：Upgrade 无响应行可回
        timeoutReply: "",
        errorReply: "",
      })
      .then((upstream) => {
        upstream.write(buildUpgradeReq(req, real.host, real.port, real.path));

        if (head.length) {
          upstream.write(head);
        }

        this.relay(socket, upstream);
      })
      .catch(() => {
        socket.destroy();
      });
  }

  /**
   * 等 101 桥接：严格解析状态行判 101，非 101 原样回源后双关
   * - 状态行用 RE_HTTP_STATUS_LINE 提取三位码严格比对，避免 `302` + `Content-Length: 1010`
   *   之类子串被 `includes("101")` 误判为升级成功
   * - 等待响应期间以 upstreamTimeout 兜底：超时销毁双方；收到完整响应头（判定点）后清除
   */
  private relay(client: Duplex, upstream: Duplex): void {
    let buf = Buffer.alloc(0);
    const timeout = get("upstreamTimeout");

    const timer = setTimeout(() => {
      if (!upstream.destroyed) {
        upstream.destroy();
      }

      if (!client.destroyed) {
        client.destroy();
      }
    }, timeout);

    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);

      const idx = buf.indexOf(DOUBLE_CRLF_BUF);

      if (idx === -1) {
        return;
      }

      upstream.off("data", onData);
      clearTimeout(timer);

      const header = buf.subarray(0, idx + DOUBLE_CRLF_BUF.length);
      const rest = buf.subarray(idx + DOUBLE_CRLF_BUF.length);

      // 严格取状态码：仅 101 视为升级成功，杜绝子串误判
      const statusCode = RE_HTTP_STATUS_LINE.exec(header.toString())?.[1];

      if (statusCode === String(STATUS_SWITCHING_PROTOCOLS)) {
        client.write(header);

        if (rest.length) {
          client.write(rest);
        }

        this.dialer.bridge(client, upstream);
      } else {
        client.write(Buffer.concat([header, rest]));
        upstream.destroy();
        client.destroy();
      }
    };

    upstream.on("data", onData);
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
