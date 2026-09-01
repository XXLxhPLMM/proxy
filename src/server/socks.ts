/**
 * SOCKS 代理服务端 - SOCKS4/4a + SOCKS5 over TLS
 * 职责：继承 BaseProxy，TLS 监听，按首字节分发 SOCKS4/5 握手
 */

import tls from "node:tls";
import net from "node:net";
import type { Duplex } from "node:stream";
import { BaseProxy } from "../core/base.js";
import type { ProxyOptions } from "../core/types.js";
import type { Auth } from "../core/auth.js";
import { getLogger } from "../utils/logger.js";
import { loadCerts, extractTlsPaths } from "../utils/cert.js";
import { tunnelConnect } from "../utils/proxy-helpers.js";

// ── SOCKS4/4a ──

function handleSocks4(
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

function dialSocks4(clientSocket: Duplex, host: string, port: number, head: Buffer, log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }, timeout?: number): void {
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

// ── SOCKS5 ──

function handleSocks5(
  clientSocket: Duplex,
  initial: Buffer,
  ctx: {
    authorize: (req: unknown, authority: string, socket: Duplex) => Promise<boolean>;
    dial: (s: Duplex, h: string, p: number, head: Buffer) => void;
    log: { warn: (...a: unknown[]) => void };
    auth?: Auth;
    timeout?: number;
  },
): void {
  const socket = clientSocket as unknown as net.Socket;
  const clientAddr = socket.remoteAddress ?? "unknown";
  const nmethods = initial[1];
  const methods = initial.subarray(2, 2 + nmethods);
  const auth = ctx.auth as Auth | undefined;
  const needAuth = !!(auth && (auth as Auth).isEnabled && (auth as Auth).authType === "basic");
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

function dialSocks5(clientSocket: Duplex, host: string, port: number, head: Buffer, log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }, timeout?: number): void {
  const SOCKS5_OK = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
  const SOCKS5_TIMEOUT = Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
  const SOCKS5_ERROR = Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
  tunnelConnect({
    clientSocket,
    hostname: host,
    port,
    head,
    timeout: timeout ?? 0,
    log,
    logPrefix: "socks5",
    successResponse: SOCKS5_OK,
    onBeforeDestroy: (side) => {
      try { (clientSocket as unknown as net.Socket).write(side === "timeout" ? SOCKS5_TIMEOUT : SOCKS5_ERROR); } catch {}
    },
  });
}

// ── SocksProxy 主类 ──

export class SocksProxy extends BaseProxy {
  private certs?: { key: Buffer; cert: Buffer; ca?: Buffer };
  protected readonly log = getLogger("SocksProxy");

  constructor(options: ProxyOptions = {}) { super("socks", options); }

  async onBeforeStart(): Promise<void> {
    this.log.info(`[lifecycle] socks loading certs key=${this.options.tls?.key} cert=${this.options.tls?.cert} ca=${this.options.tls?.ca}`);
    this.certs = loadCerts(extractTlsPaths(this.options.tls), this.log, "SOCKS");
  }

  async onStarted(): Promise<void> {
    this.log.info(`[lifecycle] socks started ${this.options.host}:${this.options.port} state=${this.state}`);
  }

  protected async doStart(): Promise<void> {
    if (!this.certs) this.certs = loadCerts(extractTlsPaths(this.options.tls), this.log, "SOCKS");
    const { key, cert, ca } = this.certs;
    const passphrase = (this.options.tls?.passphrase as string) || undefined;
    const server = tls.createServer({ key, cert, passphrase, ca: ca ? [ca] : undefined, requestCert: false, rejectUnauthorized: false }, (socket) => this.handleConnection(socket as unknown as Duplex));
    await this.startListening(server, this.options.port, this.options.host);
    this.attachErrorHandlers(server, "tlsClientError");
    this.server = server;
  }

  protected async doStop(): Promise<void> {
    await this.stopServer();
  }

  isRunning(): boolean { return !!this.server?.listening; }

  private handleConnection(clientSocket: Duplex): void {
    const socket = clientSocket as unknown as net.Socket;
    const clientAddr = socket.remoteAddress ?? "unknown";
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (buf.length < 1) return;
      const ver = buf[0];
      if (ver === 0x05) {
        if (buf.length < 2) return;
        const nmethods = buf[1];
        if (buf.length < 2 + nmethods) return;
        socket.off("data", onData);
        handleSocks5(clientSocket, buf, {
          authorize: (req, authority, sock) => this.authorize({ protocol: this.protocol, req: req as import("node:http").IncomingMessage, socket: sock, authority }),
          dial: (s, h, p, head) => this.dialSocks5(s, h, p, head),
          log: this.log,
          auth: this.auth as Auth,
          timeout: this.options.upstreamTimeout,
        });
      } else if (ver === 0x04) {
        if (buf.length < 9) return;
        const nul = buf.indexOf(0x00, 8);
        if (nul === -1) return;
        const ip = buf.subarray(4, 8);
        const is4a = ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] !== 0;
        if (is4a) { const domainEnd = buf.indexOf(0x00, nul + 1); if (domainEnd === -1) return; }
        socket.off("data", onData);
        handleSocks4(clientSocket, buf, { dial: (s, h, p, head) => this.dialSocks4(s, h, p, head), log: this.log, auth: this.auth as Auth, timeout: this.options.upstreamTimeout });
      } else { this.log.warn(`[socks] unknown version ${ver} from ${clientAddr}`); socket.destroy(); }
    };
    socket.on("data", onData);
    socket.on("error", (err) => this.log.warn(`[socks] client error ${clientAddr}:`, (err as Error).message));
    const timeout = this.options.upstreamTimeout as number;
    if (timeout > 0) socket.setTimeout(timeout, () => { this.log.warn(`[socks] client timeout ${clientAddr}`); socket.destroy(); });
  }

  private dialSocks5(clientSocket: Duplex, host: string, port: number, head: Buffer): void {
    dialSocks5(clientSocket, host, port, head, this.log, this.options.upstreamTimeout);
  }

  private dialSocks4(clientSocket: Duplex, host: string, port: number, head: Buffer): void {
    dialSocks4(clientSocket, host, port, head, this.log, this.options.upstreamTimeout);
  }
}

export function createSocksProxy(options?: ProxyOptions): SocksProxy { return new SocksProxy(options); }
