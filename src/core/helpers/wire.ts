/**
 * @fileoverview 线缆字节：出站 CONNECT 报文、裸 socket 状态行应答、写完延时销毁
 * @module core/helpers/wire
 * @description
 * 三处**直接往字节流写**的共性收口：给上游 http 代理发 CONNECT、给裸 `Duplex`
 * 写预拼的最小应答（隧道/websocket 的非 101 分支、SOCKS 失败收尾）、写完再延时销毁。
 * 报文形态刻意留在本文件——各协议应答差异是**事实**不是重复（见 `src/core/AGENTS.md`
 * 「刻意不收的」），这里只保证「魔数不内联、写入时机统一」。
 *
 * 职责：
 * - `buildConnectRequest`：拼 `CONNECT host:port` 报文；**非法 host 抛
 *   `Error("invalid target host")`**（纵深防御：主机会被拼进请求行/头行）
 * - `httpReplyFor`：状态码 → 预拼最小 HTTP/1.1 应答（未知码按 502 兜底）
 * - `writeReplyAndClose`：写应答后延时销毁（立即 destroy 会让应答字节来不及发出）
 *
 * 不负责：
 * - 不判定状态码从哪来（ACL/超时成因由调用方归类）、不选上游协议（`upstream.ts`）
 * - 不负责 socket 错误/超时联动（`core/guard.ts`）、不负责桥接（`forward/dial.ts`）
 * - 不打日志、不发事件
 *
 * 依赖：`./target.js`（`isValidTargetHost` / `formatAuthority`）+ `@/utils/constants.js`
 * + `node:stream`（`Duplex` 类型）。**本文件不读配置**。
 *
 * 使用示例：
 * ```ts
 * import { buildConnectRequest, writeReplyAndClose } from "@/core/helpers/wire.js";
 *
 * upstream.write(buildConnectRequest(host, port, upstreamAuthHeaderLine(config)));
 * writeReplyAndClose(client, Buffer.from(httpReplyFor(403)), 100);
 * ```
 */

import type { Duplex } from "node:stream";
import {
  CRLF,
  DOUBLE_CRLF,
  HEADER_NAME_HOST_TITLE,
  HEADER_NAME_PROXY_CONNECTION,
  HTTP_400_BAD_REQUEST,
  HTTP_403_FORBIDDEN,
  HTTP_502_BAD_GATEWAY,
  HTTP_504_GATEWAY_TIMEOUT,
  HTTP_VERSION,
  STATUS_BAD_REQUEST,
  STATUS_FORBIDDEN,
  STATUS_GATEWAY_TIMEOUT,
} from "@/utils/constants.js";
import { formatAuthority, isValidTargetHost } from "./target.js";

/**
 * 构造 CONNECT 请求报文
 * @description 生成 `CONNECT host:port HTTP/1.1\r\nHost: host:port\r\n[extra]\r\nProxy-Connection: keep-alive\r\n\r\n` 形态
 * @param host - 目标主机
 * @param port - 目标端口
 * @param extra - 额外头行（已含 CRLF 结束前的完整头行，如 "Proxy-Authorization: Basic xxx"），可选
 * @returns 完整的 CONNECT 报文字符串
 * @example buildConnectRequest("example.com", 443) // => "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Connection: keep-alive\r\n\r\n"
 * @example buildConnectRequest("::1", 443) // => "CONNECT [::1]:443 HTTP/1.1\r\nHost: [::1]:443\r\n..."
 * @example buildConnectRequest("example.com", 443, "Proxy-Authorization: Basic xxx") // 额外头会插入在首部
 */
export function buildConnectRequest(host: string, port: number, extra?: string): string {
  // 纵深防御：CONNECT 请求行/头由字符串拼接而成，主机名必须过白名单，
  // 否则含 CRLF 的主机会注入额外头行乃至第二个请求（借用本代理配置的上游凭证）
  if (!isValidTargetHost(host)) {
    throw new Error("invalid target host");
  }
  const auth = extra ? `${extra}${CRLF}` : "";
  const authority = formatAuthority(host, port);
  return (
    `CONNECT ${authority} ${HTTP_VERSION}${CRLF}` +
    `${HEADER_NAME_HOST_TITLE}: ${authority}${CRLF}` +
    `${auth}${HEADER_NAME_PROXY_CONNECTION}: keep-alive${DOUBLE_CRLF}`
  );
}

/**
 * 状态码 → 预拼最小 HTTP/1.1 应答报文（无 body），供裸 socket 拒绝收尾共用
 * @description tunnel / websocket 直接往 Duplex 写状态行，报文必须由 constants 派生、不得内联魔数；
 * 未知状态码按 502 兜底（网关类收尾的保守默认）
 * @param status - HTTP 状态码（400 / 403 / 504 / 502）
 * @returns `HTTP/1.1 <status> <reason>\r\n\r\n`
 * @example httpReplyFor(403) // => HTTP_403_FORBIDDEN
 */
export function httpReplyFor(status: number): string {
  switch (status) {
    case STATUS_BAD_REQUEST:
      return HTTP_400_BAD_REQUEST;
    case STATUS_FORBIDDEN:
      return HTTP_403_FORBIDDEN;
    case STATUS_GATEWAY_TIMEOUT:
      return HTTP_504_GATEWAY_TIMEOUT;
    default:
      return HTTP_502_BAD_GATEWAY;
  }
}

/**
 * 写应答后延时销毁连接
 * @description 立即 destroy 会让应答字节来不及发出（下游收不到回包），延时默认 100ms 确保先落网卡；
 * SOCKS 失败应答（server 层与 forwarder）与各类拒绝收尾共用
 * @param socket - 待回复并关闭的连接
 * @param reply - 预拼应答 Buffer
 * @param delayMs - 延时毫秒，默认 100
 */
export function writeReplyAndClose(socket: Duplex, reply: Buffer, delayMs = 100): void {
  socket.write(reply);

  setTimeout(() => {
    socket.destroy();
  }, delayMs);
}
