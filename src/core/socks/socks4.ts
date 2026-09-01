/**
 * SOCKS4/4a 实现 - VN 0x04 CD 0x01 PORT IP USERID 0x00 [DOMAIN 0x00]
 * 职责：帧解析、4a 域名识别、鉴权拒绝、dial 透传
 */

import net from "node:net";
import type { Duplex } from "node:stream";
import type { Auth } from "../auth.js";
import { tunnelConnect } from "../../utils/proxy-helpers.js";

/** 处理 SOCKS4/4a 请求 */
export function handleSocks4(
  clientSocket: Duplex,
  initial: Buffer,
  ctx: { dial: (s: Duplex, h: string, p: number, head: Buffer) => void; log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }; auth?: Auth; timeout?: number },
): void {
  const socket = clientSocket as unknown as net.Socket;
  const clientAddr = socket.remoteAddress ?? "unknown";
  const cd = initial[1];
  const port = initial.readUInt16BE(2);
  const ip = initial.subarray(4, 8);
  const nul = initial.indexOf(0x00, 8);
  const userid = initial.subarray(8, nul).toString();
  let host = `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`;
  const is4a = ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] !== 0;
  if (is4a) {
    const dStart = nul + 1;
    const dEnd = initial.indexOf(0x00, dStart);
    host = initial.subarray(dStart, dEnd).toString();
  }
  const rest = is4a ? initial.subarray(initial.indexOf(0x00, nul + 1) + 1) : initial.subarray(nul + 1);
  ctx.log.info(`[socks4] ${clientAddr} -> ${host}:${port} CD=${cd} user=${userid || "-"}`);
  if (cd !== 1) { socket.write(Buffer.from([0x00, 0x5b, 0x00, 0x00, 0, 0, 0, 0])); socket.destroy(); return; }
  const auth = ctx.auth as Auth | undefined;
  const needAuth = !!(auth && (auth as Auth).isEnabled && (auth as Auth).authType !== "none");
  if (needAuth) { ctx.log.warn(`[socks4] auth required but SOCKS4 has no password, deny ${clientAddr} -> ${host}:${port}`); socket.write(Buffer.from([0x00, 0x5d, 0x00, 0x00, 0, 0, 0, 0])); socket.destroy(); return; }
  ctx.dial(clientSocket, host, port, rest);
}

/** SOCKS4 透传拨号，成功回 0x5a */
export function dialSocks4(clientSocket: Duplex, host: string, port: number, head: Buffer, log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }, timeout?: number): void {
  const SOCKS4_OK = Buffer.from([0x00, 0x5a, 0x00, 0x00, 0, 0, 0, 0]);
  const SOCKS4_REJECT = Buffer.from([0x00, 0x5b, 0x00, 0x00, 0, 0, 0, 0]);
  tunnelConnect({
    clientSocket,
    hostname: host,
    port,
    head,
    timeout: timeout ?? 0,
    log,
    logPrefix: "socks4",
    successResponse: SOCKS4_OK,
    onBeforeDestroy: () => {
      try { (clientSocket as unknown as net.Socket).write(SOCKS4_REJECT); } catch {}
    },
  });
}
