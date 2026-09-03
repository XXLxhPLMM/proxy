/**
 * SOCKS 代理服务端 - SOCKS4/4a + SOCKS5 over TLS
 * 职责：继承 BaseProxy，TLS 监听，按首字节分发 SOCKS4/5 握手
 */

import tls from "node:tls";
import net from "node:net";
import type { Duplex } from "node:stream";
import { DirectServerProxy } from "@/core/base.js";
import type { ProxyOptions } from "@/core/types/proxy.js";
import type { Auth } from "@/core/auth.js";
import type { AuthRequestLike } from "@/core/types/auth.js";
import { getLogger } from "@/utils/logger.js";
import type { Logger } from "@/utils/logger.js";
import { loadTlsContext, type LoadedTlsCerts } from "@/utils/cert.js";
import { HEADER_NAME_PROXY_AUTHORIZATION, buildProxyAuthValue } from "@/utils/constants.js";
import { tunnelConnect, isSelfLoop, encodeBasicCredentials } from "@/utils/proxy-helpers.js";
import { logClientError, logClientTimeout, logLoopDetected } from "@/server/log/events-log.js";

// ── SOCKS4/4a ──

/**
 * SOCKS4/4a 握手处理（非正式标准协议，4a 为 NECI 的域名扩展）
 * 请求帧结构（大端序）：
 *   [0] VN   = 0x04        协议版本
 *   [1] CD                 命令：0x01=CONNECT（本实现仅支持 CONNECT，BIND 等拒绝）
 *   [2..3] DPORT           目标端口（UInt16BE）
 *   [4..7] DSTID           目标 IPv4；若为 0.0.0.x（x!=0）则是 SOCKS4a 的域名标记
 *   [8..]  USERID          以 0x00 结尾的用户名（仅审计，不做校验）
 *   SOCKS4a 追加：DOMAINNAME 以 0x00 结尾，由代理侧解析 DNS
 * 响应帧结构（固定 8 字节）：[0]=0x00 空字节, [1]=CD 状态码
 *   0x5a=请求 granted, 0x5b=request rejected, 0x5d=identd(userid)验证失败
 * 注意：SOCKS4 协议本身无密码字段，因此开启鉴权（authEnabled + basic/jwt）时一律拒绝
 */
function handleSocks4(
  clientSocket: Duplex,
  initial: Buffer,
  ctx: { dial: (s: Duplex, h: string, p: number, head: Buffer) => void; log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }; auth?: Auth; timeout?: number },
): void {
  const socket = clientSocket as unknown as net.Socket;
  const clientAddr = socket.remoteAddress ?? "unknown";
  const cd = initial[1]; // CD 命令码，0x01=CONNECT
  const port = initial.readUInt16BE(2); // 目标端口
  const ip = initial.subarray(4, 8); // 目标 IPv4（4a 场景为 0.0.0.x 占位）
  const nul = initial.indexOf(0x00, 8); // USERID 的 NULL 终止符位置
  const userid = initial.subarray(8, nul).toString(); // 客户端上报的用户名（仅日志）
  let host = `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`;
  // SOCKS4a 扩展判定：DSTID 形如 0.0.0.x（x!=0）时，USERID 之后跟的是域名而非 IP
  const is4a = ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] !== 0;
  if (is4a) {
    const dStart = nul + 1; // 域名起始：USERID 的 NULL 之后
    const dEnd = initial.indexOf(0x00, dStart); // 域名的 NULL 终止符
    host = initial.subarray(dStart, dEnd).toString();
  }
  // 剩余字节：4a 取域名 NULL 之后，普通 4 取 USERID NULL 之后；作为隧道首包透传给上游
  const rest = is4a ? initial.subarray(initial.indexOf(0x00, nul + 1) + 1) : initial.subarray(nul + 1);
  ctx.log.info(`[socks4] ${clientAddr} -> ${host}:${port} CD=${cd} user=${userid || "-"}`);
  // 非 CONNECT 命令（如 BIND 0x02）：回 0x5b rejected 并断开
  if (cd !== 1) { socket.write(Buffer.from([0x00, 0x5b, 0x00, 0x00, 0, 0, 0, 0])); socket.destroy(); return; }
  const auth = ctx.auth as Auth | undefined;
  const needAuth = !!(auth && (auth as Auth).isEnabled && (auth as Auth).authType !== "none");
  // 开启鉴权但 SOCKS4 无密码载体：回 0x5d（identd 失败语义）拒绝
  if (needAuth) { ctx.log.warn(`[socks4] auth required but SOCKS4 has no password, deny ${clientAddr} -> ${host}:${port}`); socket.write(Buffer.from([0x00, 0x5d, 0x00, 0x00, 0, 0, 0, 0])); socket.destroy(); return; }
  ctx.dial(clientSocket, host, port, rest);
}

/**
 * SOCKS4 拨号：向上游建 TCP，成功后回 0x5a granted，失败回 0x5b rejected
 * 隧道逻辑由 tunnelConnect 提供，本函数只负责 SOCKS4 应答帧
 */
function dialSocks4(clientSocket: Duplex, host: string, port: number, head: Buffer, log: Logger, timeout?: number): void {
  const SOCKS4_OK = Buffer.from([0x00, 0x5a, 0x00, 0x00, 0, 0, 0, 0]); // VN=0 CD=0x5a(granted) + 端口/IP 全零
  const SOCKS4_REJECT = Buffer.from([0x00, 0x5b, 0x00, 0x00, 0, 0, 0, 0]); // CD=0x5b(request rejected)
  // 防止循环转发：目标地址是代理自身
  if (isSelfLoop(host, port)) {
    logLoopDetected(log, `[socks4] ${host}:${port}`);
    try { (clientSocket as unknown as net.Socket).write(SOCKS4_REJECT); } catch {}
    clientSocket.destroy();
    return;
  }
  tunnelConnect({
    clientSocket,
    hostname: host,
    port,
    head,
    timeout: timeout ?? 0,
    onEvent: (e) => {
      if (e.type === "dial" || e.type === "established") log.info(e.message);
      else log.warn(e.message, (e.err as Error)?.message ?? e.err ?? "");
    },
    logPrefix: "socks4",
    successResponse: SOCKS4_OK,
    onBeforeDestroy: () => {
      try { (clientSocket as unknown as net.Socket).write(SOCKS4_REJECT); } catch {}
    },
  });
}

// ── SOCKS5 ──

/**
 * SOCKS5 握手处理（RFC 1928 + RFC 1929 用户名密码认证）
 * 完整流程分三段，本函数负责方法协商，并在闭包内串联后续阶段：
 *  1) 方法协商  客户端: [0x05][NMETHODS][METHODS...]  ->  服务端: [0x05][CHOSEN]
 *  2) 认证(可选) 选中 0x02 时走 RFC 1929 子协商，见 handleAuth
 *  3) 请求阶段  客户端发 REQUEST，见 handleRequest
 * 支持的方法：0x00=无需认证, 0x02=用户名密码（RFC 1929）；其余一律视为不可用
 * 粘包处理：TCP 流无边界，各阶段均可能收到不完整帧或帧后紧跟数据，
 *           故统一用 leftover/acc 缓冲，靠长度字段判断是否收齐后再消费
 */
function handleSocks5(
  clientSocket: Duplex,
  initial: Buffer,
  ctx: {
    authorize: (req: AuthRequestLike, authority: string, socket: Duplex) => Promise<boolean>;
    dial: (s: Duplex, h: string, p: number, head: Buffer) => void;
    log: { warn: (...a: unknown[]) => void };
    auth?: Auth;
    timeout?: number;
  },
): void {
  const socket = clientSocket as unknown as net.Socket;
  const clientAddr = socket.remoteAddress ?? "unknown";
  const nmethods = initial[1]; // 客户端提供的方法数量
  const methods = initial.subarray(2, 2 + nmethods); // 方法列表
  const auth = ctx.auth as Auth | undefined;
  // SOCKS5 有原生密码认证帧，因此仅 basic 类型可映射；jwt 无对应载体，退化为免认证
  const needAuth = !!(auth && (auth as Auth).isEnabled && (auth as Auth).authType === "basic");
  const hasNoAuth = methods.includes(0x00);
  const hasUserPass = methods.includes(0x02);
  let selected: number;
  if (needAuth) {
    // 服务端要求鉴权：客户端必须支持 0x02，否则回 0xff（无可用方法）并断开
    if (hasUserPass) selected = 0x02;
    else { socket.write(Buffer.from([0x05, 0xff])); socket.destroy(); ctx.log.warn(`[socks5] auth required but client no 0x02 ${clientAddr}`); return; }
  } else {
    // 免鉴权：优先 0x00；客户端未提供 0x00 时也可接受 0x02（认证后同样放行）
    if (hasNoAuth) selected = 0x00;
    else if (hasUserPass) selected = 0x02;
    else { socket.write(Buffer.from([0x05, 0xff])); socket.destroy(); return; }
  }
  socket.write(Buffer.from([0x05, selected])); // 回选中的方法
  // 方法协商帧之后可能已粘着认证帧或 REQUEST 帧，先缓存下来
  let leftover = initial.subarray(2 + nmethods);
  const state: { authed: boolean } = { authed: selected === 0x00 }; // 免认证直接进入请求阶段

  /** 进入请求阶段：优先消费已缓冲数据，否则等待下一个 data 事件 */
  const proceedRequest = () => {
    if (leftover.length > 0) handleRequest(leftover);
    else socket.once("data", (c) => handleRequest(c as Buffer));
  };

  /**
   * RFC 1929 用户名/密码子协商
   * 请求: [0x01][ULEN][USER][PLEN][PASS]，响应: [0x01][STATUS]，STATUS=0x00 成功
   * 逐字段校验长度，收不齐就 concat 等待，避免半包误解析
   */
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
    leftover = data.subarray(3 + ulen + plen); // 认证帧之后的字节留给请求阶段
    // 复用 HTTP Basic 语义：把 SOCKS5 凭证编码成 Proxy-Authorization 头，走统一 Auth 校验
    const token = encodeBasicCredentials(uname, passwd);
    const fakeReq = { headers: { [HEADER_NAME_PROXY_AUTHORIZATION]: buildProxyAuthValue(token) }, url: "", socket: clientSocket };
    ctx.authorize(fakeReq, `${uname}:***`, clientSocket).then((passed) => {
      if (!passed) { socket.write(Buffer.from([0x01, 0x01])); socket.destroy(); return; }
      socket.write(Buffer.from([0x01, 0x00]));
      state.authed = true;
      proceedRequest();
    });
  };

  /**
   * REQUEST 帧解析与转发（RFC 1928 §4/§5）
   * 请求: [0x05][CMD][RSV][ATYP][DST.ADDR][DST.PORT]
   *   ATYP: 0x01=IPv4(4B) / 0x03=域名(1B 长度 + 变长) / 0x04=IPv6(16B)
   *   CMD : 0x01=CONNECT（本实现仅支持），其余回 0x07 command not supported
   * 响应: [0x05][REP][RSV][ATYP][BND.ADDR][BND.PORT]，本实现回全零 BND 地址
   *   REP : 0x00=succeeded, 0x02=connection not allowed by ruleset（鉴权拒绝）, 0x07=command not supported
   */
  const handleRequest = (data: Buffer) => {
    /** 尝试解析缓冲区；帧不完整返回 null 交由上层继续等待拼接 */
    const parse = (buf: Buffer): { host: string; port: number; consumed: number } | null => {
      if (buf.length < 7) return null; // 固定头 4B + 至少 ATYP 数据 2B + 端口 2B
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
      const rest = acc.subarray(consumed); // REQUEST 帧后可能已粘着业务首包（如 TLS ClientHello）
      // 防御性兜底：若认证未完成就进入请求阶段（正常流程不会发生），再校验一次并拒绝
      if (needAuth && !state.authed) {
        const fakeReq = { headers: {}, url: `${host}:${port}`, socket: clientSocket };
        ctx.authorize(fakeReq, `${host}:${port}`, clientSocket).then((passed) => {
          if (!passed) { socket.write(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); socket.destroy(); return; }
          ctx.dial(clientSocket, host, port, rest);
        });
      } else ctx.dial(clientSocket, host, port, rest);
    };
    tryParse();
  };

  // 协商完成后分流：需认证走子协商，否则直接进请求阶段
  if (selected === 0x02) {
    if (leftover.length > 0) handleAuth(leftover);
    else socket.once("data", (c) => handleAuth(c as Buffer));
  } else proceedRequest();
}

/**
 * SOCKS5 拨号：向上游建 TCP，成功后回 REP=0x00 响应帧，失败按原因回对应 REP
 * 隧道逻辑由 tunnelConnect 提供，本函数只负责 SOCKS5 应答帧
 * 响应帧: [0x05][REP][RSV=0x00][ATYP=0x01][BND.ADDR 4B][BND.PORT 2B]，共 10 字节
 *   REP=0x04 网络不可达（此处用于超时语义近似）, 0x05 connection refused（上游错误）
 */
function dialSocks5(clientSocket: Duplex, host: string, port: number, head: Buffer, log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }, timeout?: number): void {
  const SOCKS5_OK = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]); // REP=0x00 succeeded
  const SOCKS5_TIMEOUT = Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]); // REP=0x04
  const SOCKS5_ERROR = Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]); // REP=0x05
  tunnelConnect({
    clientSocket,
    hostname: host,
    port,
    head,
    timeout: timeout ?? 0,
    onEvent: (e) => {
      if (e.type === "dial" || e.type === "established") log.info(e.message);
      else log.warn(e.message, (e.err as Error)?.message ?? e.err ?? "");
    },
    logPrefix: "socks5",
    successResponse: SOCKS5_OK,
    onBeforeDestroy: (side) => {
      try { (clientSocket as unknown as net.Socket).write(side === "timeout" ? SOCKS5_TIMEOUT : SOCKS5_ERROR); } catch {}
    },
  });
}

// ── SocksProxy 主类 ──

/**
 * SOCKS 代理服务端实现
 * 协议语义：在 TLS 监听之上承载 SOCKS4/4a/5 握手（见文件头），握手成功后双向透传 TCP
 * 与 BaseProxy 的协作：
 *   - 生命周期由基类编排（onBeforeStart 加载证书 -> doStart 建服 -> markStarted -> onStarted）
 *   - 鉴权统一走基类 authorize()，SOCKS5 凭证被编码成 HTTP Basic 头复用 Auth 抽象
 */
export class SocksProxy extends DirectServerProxy {
  /** 缓存的证书，onBeforeStart 预加载，doStart 兜底再加载 */
  private certs?: LoadedTlsCerts;
  protected readonly log = getLogger("SocksProxy");

  constructor(options: ProxyOptions = {}) { super("socks", options); }

  /** 启动前置钩子：从 options.tls 指定的路径同步加载 key/cert/ca */
  async onBeforeStart(): Promise<void> {
    if (!this.options.isWorker) {
      this.log.info(`[lifecycle] socks loading certs key=${this.options.tls?.key} cert=${this.options.tls?.cert} ca=${this.options.tls?.ca}`);
    }
    this.certs = loadTlsContext(this.options.tls, this.log, "SOCKS");
  }

  /** 启动后置钩子：输出运行态日志 */
  async onStarted(): Promise<void> {
    if (!this.options.isWorker) {
      this.log.info(`[lifecycle] socks started ${this.options.host}:${this.options.port} state=${this.state}`);
    }
  }

  /**
   * 真实建服：tls.createServer 监听，每条连接进入 SOCKS 握手
   * requestCert=false / rejectUnauthorized=false：仅加密传输，不强制客户端证书（mTLS 由 tls 协议负责）
   */
  protected async doStart(): Promise<void> {
    if (!this.certs) this.certs = loadTlsContext(this.options.tls, this.log, "SOCKS");
    const { key, cert, ca } = this.certs;
    const passphrase = (this.options.tls?.passphrase as string) || undefined;
    const server = tls.createServer({ key, cert, passphrase, ca: ca ? [ca] : undefined, requestCert: false, rejectUnauthorized: false }, (socket) => this.handleConnection(socket as unknown as Duplex));
    await this.startListening(server, this.options.port, this.options.host);
    this.attachErrorHandlers(server, "tlsClientError");
    this.server = server;
  }

  /** 真实关服：委托基类优雅 close */
  protected async doStop(): Promise<void> {
    await this.stopServer();
  }

  isRunning(): boolean { return !!this.server?.listening; }

  /**
   * 首包版本分发
   * 缓冲数据直到能判定协议版本（首字节 0x04/0x05）及完整握手帧，再 off 掉本监听器，
   * 把后续流控交给 handleSocks4/handleSocks5；未知版本直接断开
   */
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
        // SOCKS5 方法协商帧需收齐 [VER][NMETHODS][METHODS...] 才交棒
        if (buf.length < 2) return;
        const nmethods = buf[1];
        if (buf.length < 2 + nmethods) return;
        socket.off("data", onData);
        handleSocks5(clientSocket, buf, {
          authorize: (req, authority, sock) => this.authorize({ protocol: this.protocol, req, socket: sock, authority }),
          dial: (s, h, p, head) => this.dialSocks5(s, h, p, head),
          log: this.log,
          auth: this.auth as Auth,
          timeout: this.options.upstreamTimeout,
        });
      } else if (ver === 0x04) {
        // SOCKS4 固定头 8B + 至少 1B USERID 终止符；4a 还需收齐域名终止符
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
    socket.on("error", (err) => logClientError(this.log, `[socks] ${clientAddr}`, (err as Error).message));
    // 握手阶段超时保护：迟迟不发完整帧则断开，避免半开连接占用资源
    const timeout = this.options.upstreamTimeout as number;
    if (timeout > 0) socket.setTimeout(timeout, () => { logClientTimeout(this.log, `[socks] ${clientAddr}`); socket.destroy(); });
  }

  /** 实例方法包装：注入本实例日志器与超时配置后转调模块级 dialSocks5 */
  private dialSocks5(clientSocket: Duplex, host: string, port: number, head: Buffer): void {
    dialSocks5(clientSocket, host, port, head, this.log, this.options.upstreamTimeout);
  }

  /** 实例方法包装：注入本实例日志器与超时配置后转调模块级 dialSocks4 */
  private dialSocks4(clientSocket: Duplex, host: string, port: number, head: Buffer): void {
    dialSocks4(clientSocket, host, port, head, this.log, this.options.upstreamTimeout);
  }
}

/** 工厂：创建 SOCKS 代理实例 */
export function createSocksProxy(options?: ProxyOptions): SocksProxy { return new SocksProxy(options); }
