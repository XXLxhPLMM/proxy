import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import { isSelfLoop } from "@/core/proxy-helpers.js";
import {
  CRLF,
  DOUBLE_CRLF,
  HEADER_NAME_PROXY_AUTHORIZATION,
  SOCKS4_NULL,
  SOCKS4_REPLY_FAILURE,
  SOCKS4_REPLY_SUCCESS,
  SOCKS4_VERSION,
  SOCKS5_ATYP_DOMAIN,
  SOCKS5_ATYP_IPV4,
  SOCKS5_AUTH_VERSION,
  SOCKS5_REPLY_FAILURE,
  SOCKS5_REPLY_SUCCESS,
  SOCKS5_VERSION,
  SOCKS_CMD_CONNECT,
  RE_HTTP_STATUS_LINE,
  STATUS_OK,
  buildProxyAuthValue,
} from "@/utils/constants.js";
import type { PipeEventSink } from "@/core/types/proxy.js";
import type { DialGuardOptions } from "@/core/proxy-helpers.js";
import { Dialer } from "./dial.js";
import { encodeBasicCredentials, buildConnectRequest } from "@/core/proxy-helpers.js";

/**
 * 上游鉴权头：仅当显式配置 upstreamUsername 时携带
 */
function upstreamAuth(): string | undefined {
  const user = get("upstreamUsername");

  if (!user) {
    return undefined;
  }

  return `${HEADER_NAME_PROXY_AUTHORIZATION}: ${buildProxyAuthValue(
    encodeBasicCredentials(user, get("upstreamPassword")),
  )}`;
}

// ── 握手缓冲读取器 ──

/**
 * 握手读取失败原因
 * @description `timeout` 读超时 / `overflow` 握手缓冲超限 / `closed` 对端关闭 / `error` 底层错误
 */
export type SocksReadFail = "timeout" | "overflow" | "closed" | "error";

/**
 * 握手读取器选项
 * @param maxBuffered - 握手缓冲上限（字节），超限即销毁，默认 1024，防慢速/畸形握手撑爆内存
 * @param timeout - 读超时毫秒，<=0 不限；缺省取 store 的 `upstreamTimeout`
 * @param onTimeout - 读超时回调（销毁前调用，供 `logClientTimeout` 记录）
 * @param onInvalid - 超限等非法回调（销毁前调用，供 bad-request 记录）
 */
export interface SocksHandshakeReaderOptions {
  maxBuffered?: number;
  timeout?: number;
  onTimeout?: (detail: string) => void;
  onInvalid?: (detail: string) => void;
}

/** 单次读取条件：读满 n 字节 / 读至分隔符（含） */
type ReadCond = { kind: "exact"; n: number } | { kind: "until"; delim: number };

/**
 * SOCKS 握手缓冲读取器
 *
 * 职责：把「按需读满 / 读至 NUL / 剩余字节留给下一阶段」收敛到一个读取器，
 * 解决四个 SOCKS server 与 forwarder 共有的两类问题：
 * - TCP 分段：greeting / CONNECT 被拆成多次 `data` 时不再当非法请求断链；
 * - pipelining：greeting 与 CONNECT 同包到达时首包不丢，逐阶段消费。
 *
 * 设计：
 * - 内部维护一段 `buf`，每次 `data` 先追加再尝试匹配当前挂起的读取条件，命中即消费对应前缀，余量保留；
 * - 握手缓冲设上限（`maxBuffered`，默认 1024B），仅在「条件未满足且缓冲超限」时判失败并销毁，避免误杀正常流水线；
 * - 读超时用 `upstreamTimeout`（或显式 `timeout`）：超时销毁并回调 `onTimeout`；
 * - 正常移交下一阶段用 `takeBuffered()` 取走余量后 `dispose()`，读取器不再消费 socket。
 */
export class SocksHandshakeReader {
  /** 尚未被消费的缓冲字节 */
  private buf: Buffer = Buffer.alloc(0);

  /** 当前挂起的读取条件与其决议句柄；握手串行，任意时刻至多一个 */
  private pending?: { cond: ReadCond; resolve: (v: Buffer | null) => void };

  /** 是否已终结（失败/移交/销毁），终结后不再接受新读取 */
  private settled = false;

  /** 读超时定时器 */
  private timer?: ReturnType<typeof setTimeout>;

  /** 缓冲上限（字节） */
  private readonly max: number;

  /** 读超时（毫秒），<=0 表示不限 */
  private readonly timeout: number;

  private readonly onTimeout?: (detail: string) => void;
  private readonly onInvalid?: (detail: string) => void;

  /**
   * 构造读取器并挂载 socket 数据监听
   * @param socket - 客户端双工流
   * @param opts - 缓冲上限、读超时与超时/非法回调
   */
  constructor(
    private readonly socket: Duplex,
    opts: SocksHandshakeReaderOptions = {},
  ) {
    this.max = opts.maxBuffered ?? 1024;
    this.timeout = opts.timeout ?? (get("upstreamTimeout") as number);
    this.onTimeout = opts.onTimeout;
    this.onInvalid = opts.onInvalid;

    if (socket.destroyed) {
      this.settled = true;
      return;
    }

    socket.on("data", this.handleData);
    socket.once("end", this.handleEnd);
    socket.once("close", this.handleEnd);
    socket.once("error", this.handleError);
  }

  /**
   * 读满 n 字节；失败/超时/超限/关闭返回 null（socket 已销毁）
   * @param n - 期望字节数，<=0 立即返回空 Buffer
   */
  readExactly(n: number): Promise<Buffer | null> {
    if (n <= 0) {
      return Promise.resolve(Buffer.alloc(0));
    }

    return this.await({ kind: "exact", n });
  }

  /**
   * 读至分隔符（含）；返回分隔符之前的字节（可能为空），失败返回 null
   * @param delim - 单字节分隔符（如 SOCKS4 的 0x00）
   */
  readUntil(delim: number): Promise<Buffer | null> {
    return this.await({ kind: "until", delim });
  }

  /**
   * 取走当前缓冲余量（不清除已挂起读取；供握手成功后把流水线残留交给桥接）
   * @returns 残余字节（可能为空 Buffer）
   */
  takeBuffered(): Buffer {
    const b = this.buf;

    this.buf = Buffer.alloc(0);

    return b;
  }

  /**
   * 终结读取器：停止消费 socket、清定时器；不销毁 socket（移交桥接用），幂等
   */
  dispose(): void {
    this.settled = true;
    this.clearTimer();
    this.detach();
    this.pending = undefined;
  }

  /** 发起一次读取，挂起条件并在数据到达时尝试满足 */
  private await(cond: ReadCond): Promise<Buffer | null> {
    if (this.settled || this.pending) {
      return Promise.resolve(null);
    }

    return new Promise<Buffer | null>((resolve) => {
      this.pending = { cond, resolve };
      this.armTimer();
      this.tryResolve();
    });
  }

  /** 尝试用当前缓冲满足挂起条件；命中即消费前缀并决议 */
  private tryResolve(): void {
    const p = this.pending;

    if (!p || this.settled) {
      return;
    }

    let out: Buffer | null = null;

    if (p.cond.kind === "exact") {
      if (this.buf.length >= p.cond.n) {
        out = this.buf.subarray(0, p.cond.n);
        this.buf = this.buf.subarray(p.cond.n);
      }
    } else {
      const idx = this.buf.indexOf(p.cond.delim);

      if (idx !== -1) {
        out = this.buf.subarray(0, idx);
        this.buf = this.buf.subarray(idx + 1);
      }
    }

    if (out === null) {
      return;
    }

    this.pending = undefined;
    this.clearTimer();
    p.resolve(out);
  }

  /** 数据到达：追加缓冲 → 尝试匹配 → 未满足且超限则判失败 */
  private readonly handleData = (chunk: Buffer): void => {
    if (this.settled) {
      return;
    }

    this.buf = Buffer.concat([this.buf, chunk]);
    this.tryResolve();

    if (this.settled) {
      return;
    }

    if (this.pending && this.buf.length > this.max) {
      this.fail("overflow");
    }
  };

  /** 对端关闭（end/close）：若有挂起读取则一并终结 */
  private readonly handleEnd = (): void => {
    this.fail("closed");
  };

  /** 底层错误：终结读取器 */
  private readonly handleError = (): void => {
    this.fail("error");
  };

  /** 失败收尾：清定时器/解绑/销毁 socket/决议挂起读取为 null */
  private fail(reason: SocksReadFail): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.clearTimer();
    this.detach();

    const p = this.pending;

    this.pending = undefined;

    if (reason === "timeout") {
      this.onTimeout?.(`socks handshake read timeout after ${this.timeout}ms`);
    } else if (reason === "overflow") {
      this.onInvalid?.(`socks handshake buffer overflow > ${this.max}B`);
    }

    if (!this.socket.destroyed) {
      this.socket.destroy();
    }

    p?.resolve(null);
  }

  /** 解绑 socket 监听（幂等） */
  private detach(): void {
    this.socket.off("data", this.handleData);
    this.socket.off("end", this.handleEnd);
    this.socket.off("close", this.handleEnd);
    this.socket.off("error", this.handleError);
  }

  /** 挂读超时定时器（unref 不阻塞进程退出） */
  private armTimer(): void {
    if (this.timeout <= 0) {
      return;
    }

    this.clearTimer();
    this.timer = setTimeout(() => {
      this.fail("timeout");
    }, this.timeout);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** 清除读超时定时器 */
  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * SOCKS4/4a 请求解析结果
 * @param userid - USERID 字段（socks4 鉴权承载）
 * @param host - 目标主机（IPv4 字面量或 4a 域名）
 * @param port - 目标端口
 * @param isSocks4a - 是否走 4a 域名扩展
 */
export interface Socks4Target {
  userid: string;
  host: string;
  port: number;
  isSocks4a: boolean;
}

/**
 * SOCKS 转发器
 * - 下游：socks4 / socks5 明文（TLS 由 server 层承载）
 * - 上游：按 proxyMode 与 upstreamProtocol 串联 http/https/socks
 * - 握手：由 server 层用 {@link SocksHandshakeReader} 逐阶段读取并鉴权，成功后再交本类拨号
 */
export class SocksForwarder {
  private dialer = new Dialer();

  constructor(private sink?: PipeEventSink) {}

  private emit(e: unknown): void {
    try {
      this.sink?.(e as never);
    } catch {}
  }

  /**
   * 读 SOCKS5 greeting（VER NMETHODS METHODS）；非法即 emit bad-request 并返回 null
   * @returns 客户端支持的鉴权方法列表，失败 null
   */
  async readGreeting(reader: SocksHandshakeReader): Promise<number[] | null> {
    const head = await reader.readExactly(2);

    if (!head || head[0] !== SOCKS5_VERSION) {
      this.emit({ type: "bad-request", message: "[socks] invalid socks5 greeting" });
      return null;
    }

    const n = head[1];

    if (n < 1) {
      this.emit({ type: "bad-request", message: "[socks] socks5 greeting without methods" });
      return null;
    }

    const body = await reader.readExactly(n);

    if (!body) {
      this.emit({ type: "bad-request", message: "[socks] socks5 greeting truncated" });
      return null;
    }

    return Array.from(body);
  }

  /**
   * 读 RFC1929 用户名/密码子协商（VER ULEN UNAME PLEN PASSWD）
   * @returns 解析出的用户名/密码，非法或截断返回 null
   */
  async readUserPass(reader: SocksHandshakeReader): Promise<{ user: string; pass: string } | null> {
    const head = await reader.readExactly(2);

    if (!head || head[0] !== SOCKS5_AUTH_VERSION) {
      return null;
    }

    const u = await reader.readExactly(head[1]);

    if (!u) {
      return null;
    }

    const plen = await reader.readExactly(1);

    if (!plen) {
      return null;
    }

    const p = await reader.readExactly(plen[0]);

    if (!p) {
      return null;
    }

    return { user: u.toString(), pass: p.toString() };
  }

  /**
   * 读 SOCKS4/4a 请求：VN CD PORT DSTIP USERID(0x00) [DOMAIN(0x00)]；非法即 emit bad-request 并返回 null
   * @returns USERID/host/port/isSocks4a，失败 null
   */
  async parseSocks4(reader: SocksHandshakeReader): Promise<Socks4Target | null> {
    const head = await reader.readExactly(8);

    if (!head || head[0] !== SOCKS4_VERSION || head[1] !== SOCKS_CMD_CONNECT) {
      this.emit({ type: "bad-request", message: "[socks] invalid socks4 request" });
      return null;
    }

    const port = head.readUInt16BE(2);
    const isSocks4a = head[4] === 0 && head[5] === 0 && head[6] === 0 && head[7] !== 0;
    const uid = await reader.readUntil(SOCKS4_NULL);

    if (!uid) {
      this.emit({ type: "bad-request", message: "[socks] socks4 missing USERID NUL" });
      return null;
    }

    const userid = uid.toString();
    let host = `${head[4]}.${head[5]}.${head[6]}.${head[7]}`;

    if (isSocks4a) {
      const dom = await reader.readUntil(SOCKS4_NULL);

      if (!dom) {
        this.emit({ type: "bad-request", message: "[socks] socks4a missing DOMAIN NUL" });
        return null;
      }

      host = dom.toString();

      if (!host) {
        this.emit({ type: "bad-request", message: "[socks] socks4a empty domain" });
        return null;
      }
    }

    return { userid, host, port, isSocks4a };
  }

  /**
   * SOCKS4/4a 已解析并鉴权：移交数据流余量并建隧
   * @param socket - 客户端双工流
   * @param parsed - 已解析目标
   * @param reader - 共享握手读取器（用于取走流水线余量并解绑）
   */
  serveSocks4(socket: Duplex, parsed: Socks4Target, reader: SocksHandshakeReader): void {
    const residual = this.detach(reader, socket);
    const client = (socket as unknown as { remoteAddress?: string }).remoteAddress ?? "unknown";

    this.emit({ type: "socks", message: `[socks] ${client} -> ${parsed.host}:${parsed.port} CONNECT (socks4${parsed.isSocks4a ? "a" : ""})` } as never);
    void this.connect(socket, parsed.host, parsed.port, 4, residual);
  }

  /**
   * SOCKS5 已鉴权：读 CONNECT 请求并建隧（复用同一读取器以承接流水线/分段）
   * @param socket - 客户端双工流
   * @param reader - 共享握手读取器
   */
  async serveSocks5Connect(socket: Duplex, reader: SocksHandshakeReader): Promise<void> {
    const target = await this.readSocks5Request(reader);

    if (!target) {
      reader.dispose();
      this.replyFail(socket, 5);
      return;
    }

    const residual = this.detach(reader, socket);
    const client = (socket as unknown as { remoteAddress?: string }).remoteAddress ?? "unknown";

    this.emit({ type: "socks", message: `[socks] ${client} -> ${target.host}:${target.port} CONNECT (socks5)` } as never);
    await this.connect(socket, target.host, target.port, 5, residual);
  }

  /**
   * 解析 SOCKS5 CONNECT：VER CMD RSV ATYP + 地址 + 端口，按 ATYP 精确所需长度
   * 域名型校验域名长度（1..255）与「域名 + 端口」字节齐全，缺字节由读取器等待/超时兜底
   */
  private async readSocks5Request(reader: SocksHandshakeReader): Promise<{ host: string; port: number } | null> {
    const head = await reader.readExactly(4);

    if (!head || head[0] !== SOCKS5_VERSION || head[1] !== SOCKS_CMD_CONNECT) {
      this.emit({ type: "bad-request", message: "[socks] invalid socks5 CONNECT request" });
      return null;
    }

    const atyp = head[3];

    if (atyp === SOCKS5_ATYP_IPV4) {
      const rest = await reader.readExactly(6);

      if (!rest) {
        this.emit({ type: "bad-request", message: "[socks] socks5 ipv4 truncated" });
        return null;
      }

      return { host: `${rest[0]}.${rest[1]}.${rest[2]}.${rest[3]}`, port: rest.readUInt16BE(4) };
    }

    if (atyp === SOCKS5_ATYP_DOMAIN) {
      const l = await reader.readExactly(1);

      if (!l) {
        this.emit({ type: "bad-request", message: "[socks] socks5 domain length truncated" });
        return null;
      }

      const len = l[0];

      if (len === 0) {
        this.emit({ type: "bad-request", message: "[socks] socks5 empty domain" });
        return null;
      }

      // 域名（<=255）+ 端口（2）必须齐全，缺字节时读取器等待至超时/关闭
      const rest = await reader.readExactly(len + 2);

      if (!rest) {
        this.emit({ type: "bad-request", message: "[socks] socks5 domain truncated" });
        return null;
      }

      return { host: rest.subarray(0, len).toString(), port: rest.readUInt16BE(len) };
    }

    this.emit({ type: "bad-request", message: `[socks] unsupported socks5 atyp=${atyp}` });
    return null;
  }

  /** 暂停 socket、取走流水线余量并解绑读取器，交桥接复用 */
  private detach(reader: SocksHandshakeReader, socket: Duplex): Buffer {
    socket.pause();

    const residual = reader.takeBuffered();

    reader.dispose();

    return residual;
  }

  /**
   * 拨号并建隧：SOCKS 上下文一律传空回复守卫，避免 HTTP 502/504 污染 SOCKS 客户端；
   * 失败统一由各 catch 回对应 SOCKS 失败应答
   */
  private async connect(client: Duplex, host: string, port: number, ver: 4 | 5, residual?: Buffer): Promise<void> {
    if (isSelfLoop(host, port)) {
      this.emit({ type: "loop-detected", target: `${host}:${port}` } as never);
      this.replyFail(client, ver);
      return;
    }

    // SOCKS 上下文：guard 只做超时/错误时的双向销毁，不写 HTTP 报文
    const guard: DialGuardOptions = { logPrefix: "socks", timeoutReply: "", errorReply: "" };
    const mode = get("proxyMode");

    if (mode !== "client") {
      try {
        const upstream = await this.dialer.dialDirect(client, host, port, guard);

        this.replySuccess(client, ver);
        this.emit({ type: "socks", message: `[socks] tunnel established ${host}:${port} (socks${ver})` } as never);
        this.establish(client, upstream, residual);
      } catch (e) {
        this.emit({ type: "upstream-error", message: `[socks] upstream error ${host}:${port}: ${(e as Error).message}` } as never);
        this.replyFail(client, ver);
      }

      return;
    }

    const proto = get("upstreamProtocol");
    const upstreamHost = get("upstreamHost");
    const upstreamPort = get("upstreamPort");
    const secure = proto === "sockss4" || proto === "sockss5" || proto === "https";

    // http(s) 上游载 CONNECT：等 200 才回成功
    if (proto === "http" || proto === "https") {
      try {
        const upstream = await this.dialer.choose(client, upstreamHost, upstreamPort, secure, guard);

        const auth = upstreamAuth();

        upstream.write(buildConnectRequest(host, port, auth));

        // 上游接受 TCP 后不回 CONNECT 应答时不能无限等待（拨号守卫在 connect 后已让出超时职责）：
        // upstreamTimeout 兜底，超时销毁上游并回 SOCKS 失败应答
        const timer = setTimeout(() => {
          this.emit({ type: "upstream-error", message: `[socks] upstream CONNECT response timeout ${upstreamHost}:${upstreamPort}` } as never);
          upstream.destroy();
          this.replyFail(client, ver);
        }, get("upstreamTimeout") as number);

        let buf = Buffer.alloc(0);

        const onData = (chunk: Buffer): void => {
          buf = Buffer.concat([buf, chunk]);

          const idx = buf.indexOf(DOUBLE_CRLF);

          if (idx === -1) {
            return;
          }

          clearTimeout(timer);

          // 严格取状态行三位码比对：响应头里出现 "200" 子串（如 realm="200"）不得误判为建链成功
          const statusCode = RE_HTTP_STATUS_LINE.exec(buf.subarray(0, idx).toString())?.[1];

          if (statusCode !== String(STATUS_OK)) {
            this.emit({ type: "upstream-refused", statusLine: buf.toString().split(CRLF)[0] } as never);
            this.replyFail(client, ver);
            upstream.destroy();
            return;
          }

          upstream.off("data", onData);
          this.replySuccess(client, ver);
          this.emit({ type: "socks", message: `[socks] tunnel via upstream ${upstreamHost}:${upstreamPort} -> ${host}:${port}` } as never);
          // 头部之后可能已有上游字节，一并回送客户端
          this.establish(client, upstream, residual, buf.subarray(idx + DOUBLE_CRLF.length));
        };

        upstream.on("data", onData);
      } catch (e) {
        this.emit({ type: "upstream-error", message: `[socks] upstream error ${host}:${port}: ${(e as Error).message}` } as never);
        this.replyFail(client, ver);
      }

      return;
    }

    // socks 上游做第二段握手到真实目标
    const version: 4 | 5 = proto === "socks4" || proto === "sockss4" ? 4 : 5;

    try {
      const upstream = await this.dialer.dialSocks(client, host, port, version, undefined, guard);

      this.replySuccess(client, ver);
      this.emit({ type: "socks", message: `[socks] tunnel via socks upstream ${host}:${port} (socks${ver}->socks${version})` } as never);
      this.establish(client, upstream, residual);
    } catch (e) {
      this.emit({ type: "upstream-error", message: `[socks] socks upstream error ${host}:${port}: ${(e as Error).message}` } as never);
      this.replyFail(client, ver);
    }
  }

  /** 建隧收尾：回灌客户端流水线余量与上游头部后字节，再双向桥接 */
  private establish(client: Duplex, upstream: Duplex, residual?: Buffer, upstreamHead?: Buffer): void {
    if (residual?.length) {
      upstream.write(residual);
    }

    if (upstreamHead?.length) {
      client.write(upstreamHead);
    }

    this.dialer.bridge(client, upstream);
  }

  private replySuccess(socket: Duplex, ver: number): void {
    if (ver === 5) {
      socket.write(SOCKS5_REPLY_SUCCESS);
    } else {
      socket.write(SOCKS4_REPLY_SUCCESS);
    }
  }

  private replyFail(socket: Duplex, ver: number): void {
    if (ver === 5) {
      socket.write(SOCKS5_REPLY_FAILURE);
    } else {
      socket.write(SOCKS4_REPLY_FAILURE);
    }

    // 延时 100：确保 FAIL 字节先发出再 destroy，防下游收不到回包
    setTimeout(() => {
      socket.destroy();
    }, 100);
  }
}
