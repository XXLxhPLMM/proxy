/**
 * SOCKS5 实现 - RFC1928 握手 + RFC1929 用户密码
 * 职责：METHOD 协商、子协商鉴权（复用 Basic Auth）、ATYP 解析、dial 透传
 * 被 src/core/socks/index.ts 的 SocksProxy 聚合调用
 */

import net from "node:net";
import type { Duplex } from "node:stream";
import { get } from "../../config/store.js";

/**
 * 处理 SOCKS5 握手与请求
 * @param clientSocket - 客户端 TLS 解密后的 Duplex
 * @param initial - 首包（含 VER/NMETHODS/METHODS）
 * @param ctx - 需提供 authorize、dial、log、protocol
 */
export function handleSocks5(
  clientSocket: Duplex,
  initial: Buffer,
  ctx: {
    authorize: (req: unknown, authority: string, socket: Duplex) => Promise<boolean>;
    dial: (s: Duplex, h: string, p: number, head: Buffer) => void;
    log: { warn: (...a: unknown[]) => void };
  },
): void {
  const socket = clientSocket as unknown as net.Socket;
  const clientAddr = socket.remoteAddress ?? "unknown";
  const nmethods = initial[1];
  const methods = initial.subarray(2, 2 + nmethods);
  const needAuth = !!(get("authEnabled") as boolean) && (get("authType") as string) === "basic";
  const hasNoAuth = methods.includes(0x00);
  const hasUserPass = methods.includes(0x02);
  let selected: number;
  if (needAuth) {
    if (hasUserPass) selected = 0x02;
    else { socket.write(Buffer.from([0x05, 0xff])); socket.destroy(); ctx.log.warn(`[socks5] auth required but client no 0x02 ${clientAddr}`); return; }
  } else {
    if (hasNoAuth) selected = 0x00;
    else if (hasUserPass) selected = 0x02;
    else { socket.write(Buffer.from([0x05, 0xff])); socket.destroy(); return; }
  }
  socket.write(Buffer.from([0x05, selected]));
  let leftover = initial.subarray(2 + nmethods);
  const state: { authed: boolean } = { authed: selected === 0x00 };

  const proceedRequest = () => {
    if (leftover.length > 0) handleRequest(leftover);
    else socket.once("data", (c) => handleRequest(c as Buffer));
  };

  const handleAuth = (data: Buffer) => {
    if (data.length < 5) { socket.once("data", (c) => handleAuth(Buffer.concat([data, c as Buffer]))); return; }
    const ver = data[0];
    if (ver !== 0x01) { socket.write(Buffer.from([0x01, 0x01])); socket.destroy(); return; }
    const ulen = data[1];
    if (data.length < 2 + ulen + 1) { socket.once("data", (c) => handleAuth(Buffer.concat([data, c as Buffer]))); return; }
    const uname = data.subarray(2, 2 + ulen).toString();
    const plen = data[2 + ulen];
    if (data.length < 2 + ulen + 1 + plen) { socket.once("data", (c) => handleAuth(Buffer.concat([data, c as Buffer]))); return; }
    const passwd = data.subarray(3 + ulen, 3 + ulen + plen).toString();
    leftover = data.subarray(3 + ulen + plen);
    const token = Buffer.from(`${uname}:${passwd}`).toString("base64");
    const fakeReq = { headers: { "proxy-authorization": `Basic ${token}` }, url: "", socket: clientSocket } as unknown as import("node:http").IncomingMessage;
    ctx.authorize(fakeReq, `${uname}:***`, clientSocket).then((passed) => {
      if (!passed) { socket.write(Buffer.from([0x01, 0x01])); socket.destroy(); return; }
      socket.write(Buffer.from([0x01, 0x00]));
      state.authed = true;
      proceedRequest();
    });
  };

  const handleRequest = (data: Buffer) => {
    const parse = (buf: Buffer): { host: string; port: number; consumed: number } | null => {
      if (buf.length < 7) return null;
      const ver = buf[0], cmd = buf[1], atyp = buf[3];
      if (ver !== 0x05) return null;
      if (cmd !== 0x01) { socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); socket.destroy(); return null; }
      let host = "", port = 0, consumed = 0;
      if (atyp === 0x01) { if (buf.length < 10) return null; host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`; port = buf.readUInt16BE(8); consumed = 10; }
      else if (atyp === 0x03) { const len = buf[4]; if (buf.length < 5 + len + 2) return null; host = buf.subarray(5, 5 + len).toString(); port = buf.readUInt16BE(5 + len); consumed = 7 + len; }
      else if (atyp === 0x04) { if (buf.length < 22) return null; const ipBuf = buf.subarray(4, 20); host = Array.from(ipBuf).map((b) => b.toString(16).padStart(2, "0")).join(":"); port = buf.readUInt16BE(20); consumed = 22; }
      else return null;
      return { host, port, consumed };
    };
    let acc = data;
    const tryParse = () => {
      const parsed = parse(acc);
      if (!parsed) { socket.once("data", (c) => { acc = Buffer.concat([acc, c as Buffer]); tryParse(); }); return; }
      const { host, port, consumed } = parsed;
      const rest = acc.subarray(consumed);
      if (needAuth && !state.authed) {
        const fakeReq = { headers: {}, url: `${host}:${port}`, socket: clientSocket } as unknown as import("node:http").IncomingMessage;
        ctx.authorize(fakeReq, `${host}:${port}`, clientSocket).then((passed) => {
          if (!passed) { socket.write(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); socket.destroy(); return; }
          ctx.dial(clientSocket, host, port, rest);
        });
      } else ctx.dial(clientSocket, host, port, rest);
    };
    tryParse();
  };

  if (selected === 0x02) {
    if (leftover.length > 0) handleAuth(leftover);
    else socket.once("data", (c) => handleAuth(c as Buffer));
  } else proceedRequest();
}

/**
 * SOCKS5 透传拨号
 * 成功回 0x05 0x00，超时/错误映射 0x04/0x05
 */
export function dialSocks5(clientSocket: Duplex, host: string, port: number, head: Buffer, log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }): void {
  const clientAddr = (clientSocket as unknown as net.Socket).remoteAddress ?? "unknown";
  log.info(`[socks5] dial ${clientAddr} -> ${host}:${port}`);
  const serverSocket = net.connect(port, host, () => {
    serverSocket.setTimeout(0);
    log.info(`[socks5] established ${clientAddr} -> ${host}:${port}`);
    (clientSocket as unknown as net.Socket).write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    if (head.length) serverSocket.write(head);
    clientSocket.pipe(serverSocket);
    serverSocket.pipe(clientSocket);
  });
  const timeout = get("upstreamTimeout") as number;
  let timedOut = false;
  if (timeout > 0) serverSocket.setTimeout(timeout, () => {
    if (serverSocket.destroyed) return;
    timedOut = true;
    log.warn(`[socks5] upstream timeout ${clientAddr} -> ${host}:${port}`);
    try { (clientSocket as unknown as net.Socket).write(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch {}
    clientSocket.destroy(); serverSocket.destroy();
  });
  const destroyBoth = () => { clientSocket.destroy(); serverSocket.destroy(); };
  const onErr = (side: string) => (err: Error) => {
    if (timedOut) return;
    log.warn(`[socks5] ${side} error ${clientAddr} -> ${host}:${port}:`, err.message);
    try { (clientSocket as unknown as net.Socket).write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch {}
    destroyBoth();
  };
  clientSocket.on("error", onErr("client"));
  serverSocket.on("error", onErr("upstream"));
  clientSocket.on("close", () => serverSocket.destroy());
  serverSocket.on("close", () => clientSocket.destroy());
}
