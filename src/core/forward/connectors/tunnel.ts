/**
 * connectors/tunnel - 经 HTTP 上游代理的 CONNECT 隧道建链（L7 下沉层）
 * 职责：dialer 建链（默认 dialHttpUpstream 明文 TCP，https/tls 上游可注入对应 dialer 先建 TLS）-> 可选发 CONNECT（含鉴权头）-> 等头块凑齐裁决
 * - sendConnect=false：TCP 建链即 resolve（直拨源站/透明分支用）
 * - sendConnect=true：发 CONNECT 给上游代理，200 才 resolve(socket+rest)，非 200 relay 后 reject
 * 成功 resolve 上游 socket（net/tls 均为 Duplex）；失败 reject，上游 socket 已 destroy
 * 本层零日志，观测经 guardOpts.onEvent 槽上抛
 */

import type { Duplex } from "node:stream";
import { CRLF, DOUBLE_CRLF_BUF } from "@/utils/constants.js";
import { buildConnectRequest, type DialGuardOptions } from "@/core/proxy-helpers.js";
import { dialHttpUpstream } from "./http.js";
import type { ConnectorDial, DialResult } from "@/core/types/connector.js";

export interface TunnelViaUpstreamOptions {
  /** 是否向拨号目标发送 CONNECT（默认 true；false = 纯 TCP 直拨） */
  sendConnect?: boolean;
  /** CONNECT 附加头行，如 `Proxy-Authorization: Basic xxx`（不含 CRLF） */
  authLine?: string;
  /** 底层拨号器：默认 dialHttpUpstream（明文）；https/tls 上游传 dialHttpsUpstream/dialTlsUpstream（先建 TLS 再发 CONNECT） */
  dialer?: ConnectorDial;
  /** 透传给 guardDialing 的守卫选项（含 target/onEvent/timeout 定制） */
  guardOpts?: DialGuardOptions;
}

export interface TunnelResult extends DialResult {
  /** 上游 200 头块之后紧跟的余量字节（TLS ClientHello 粘包等），调用方负责归位 */
  rest: Buffer;
  /** 上游回的状态行，如 `HTTP/1.1 200 Connection Established` */
  statusLine: string;
}

/** 等上游响应头块：攒 Buffer 到 DOUBLE_CRLF 后一次性交判定 */
function collectHeaderBlock(
  upstreamSocket: Duplex,
  onBlock: (headerBlock: Buffer, rest: Buffer) => void,
): void {
  let pending = Buffer.alloc(0);
  const onData = (chunk: Buffer): void => {
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf(DOUBLE_CRLF_BUF);
    if (end === -1) return;
    upstreamSocket.removeListener("data", onData);
    onBlock(pending.subarray(0, end + DOUBLE_CRLF_BUF.length), pending.subarray(end + DOUBLE_CRLF_BUF.length));
  };
  upstreamSocket.on("data", onData);
}

/**
 * 经上游代理建 CONNECT 隧道
 * @param clientSocket 客户端腿（守卫与 close 互杀用，不写业务报文）
 * @param upstreamHost 上游代理 host（TCP 拨号目标）
 * @param upstreamPort 上游代理 port
 * @param targetHost CONNECT 行里的最终目标 host
 * @param targetPort CONNECT 行里的最终目标 port
 */
export async function dialTunnelViaUpstream(
  clientSocket: Duplex,
  upstreamHost: string,
  upstreamPort: number,
  targetHost: string,
  targetPort: number,
  opts: TunnelViaUpstreamOptions = {},
): Promise<TunnelResult> {
  const { sendConnect = true, authLine, dialer = dialHttpUpstream, guardOpts } = opts;
  const { socket, dial } = await dialer(clientSocket, upstreamHost, upstreamPort, guardOpts);
  if (!sendConnect) {
    return { socket, dial, rest: Buffer.alloc(0), statusLine: "" };
  }
  return new Promise<TunnelResult>((resolve, reject) => {
    socket.write(buildConnectRequest(targetHost, targetPort, authLine));
    collectHeaderBlock(socket, (headerBlock, rest) => {
      const statusLine = headerBlock.toString().split(CRLF)[0] ?? "";
      const statusCode = Number(statusLine.split(" ")[1]);
      if (statusCode === 200) {
        resolve({ socket, dial, rest, statusLine });
      } else {
        if (typeof (clientSocket as Duplex & { writable?: boolean }).writable === "boolean") {
          if ((clientSocket as unknown as { writable: boolean }).writable) clientSocket.end(headerBlock);
        } else {
          clientSocket.end(headerBlock);
        }
        socket.destroy();
        reject(new Error(`[tunnel] upstream refused: ${statusLine}`));
      }
    });
    socket.once("error", (err) => {
      if (!socket.destroyed) socket.destroy();
      reject(err);
    });
  });
}
