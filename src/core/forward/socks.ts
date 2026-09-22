import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import {
  guardPreDial,
  isSelfLoop,
  isValidTargetHost,
  isTlsUpstreamProto,
  socksVersionOf,
  writeReplyAndClose,
} from "@/core/proxy-helpers.js";
import { socksUpstreamGuard, type HelperEvent } from "@/core/guard.js";
import { ipv6BytesToString } from "@/utils/ip-list.js";
import { getSocketAddress } from "@/utils/ip.js";
import {
  CRLF,
  SOCKS4_NULL,
  SOCKS4_REPLY_FAILURE,
  SOCKS4_REPLY_SUCCESS,
  SOCKS4_VERSION,
  SOCKS5_ATYP_DOMAIN,
  SOCKS5_ATYP_IPV4,
  SOCKS5_ATYP_IPV6,
  SOCKS5_AUTH_VERSION,
  SOCKS5_REPLY_FAILURE,
  SOCKS5_REPLY_SUCCESS,
  SOCKS5_VERSION,
  SOCKS_CMD_CONNECT,
  STATUS_OK,
} from "@/utils/constants.js";
import type { PipeEvent } from "@/core/types/proxy.js";
import { ForwarderBase } from "./base.js";

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
 * - 拨号器、事件槽与 `emitWithUser` 继承自 {@link ForwarderBase}
 */
export class SocksForwarder extends ForwarderBase<PipeEvent | HelperEvent> {

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
   * @param user - 已鉴权用户名（无鉴权模式为 undefined），随事件带给日志
   */
  serveSocks4(
    socket: Duplex,
    parsed: Socks4Target,
    reader: SocksHandshakeReader,
    user?: string,
  ): void {
    const residual = this.detach(reader, socket);
    const client = getSocketAddress(socket);

    this.emitWithUser(
      {
        type: "socks",
        message: `[socks] ${client} -> ${parsed.host}:${parsed.port} CONNECT (socks4${parsed.isSocks4a ? "a" : ""})`,
      },
      user,
    );
    void this.connect(socket, parsed.host, parsed.port, 4, residual, user);
  }

  /**
   * SOCKS5 已鉴权：读 CONNECT 请求并建隧（复用同一读取器以承接流水线/分段）
   * @param socket - 客户端双工流
   * @param reader - 共享握手读取器
   * @param user - 已鉴权用户名（无鉴权模式为 undefined），随事件带给日志
   */
  async serveSocks5Connect(
    socket: Duplex,
    reader: SocksHandshakeReader,
    user?: string,
  ): Promise<void> {
    const target = await this.readSocks5Request(reader);

    if (!target) {
      reader.dispose();
      this.replyFail(socket, 5);
      return;
    }

    const residual = this.detach(reader, socket);
    const client = getSocketAddress(socket);

    this.emitWithUser(
      { type: "socks", message: `[socks] ${client} -> ${target.host}:${target.port} CONNECT (socks5)` },
      user,
    );
    await this.connect(socket, target.host, target.port, 5, residual, user);
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

    if (atyp === SOCKS5_ATYP_IPV6) {
      const rest = await reader.readExactly(18);

      if (!rest) {
        this.emit({ type: "bad-request", message: "[socks] socks5 ipv6 truncated" });
        return null;
      }

      return { host: ipv6BytesToString(rest.subarray(0, 16)), port: rest.readUInt16BE(16) };
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
   * @param user - 已鉴权用户名，随事件带给日志（每会话参数，不落单例字段）
   */
  private async connect(
    client: Duplex,
    host: string,
    port: number,
    ver: 4 | 5,
    residual?: Buffer,
    user?: string,
  ): Promise<void> {
    // 目标主机来自客户端原始字节（SOCKS 域名不过 HTTP 解析器）：先过白名单与长度上限，
    // 再进 isSelfLoop / buildConnectRequest / SOCKS 上游请求，杜绝报文注入与 1 字节长度域截断
    if (!isValidTargetHost(host)) {
      this.replyFail(client, ver);
      return;
    }

    // 自环 + 目标名单与 http/tunnel/websocket 共用前置守卫：
    // 名单事件经 emitWithUser 附带本会话用户名，clientAddr 供日志定位；
    // 拒绝收尾不看状态码（SOCKS 语境回 HTTP 报文会污染协议，统一回失败应答）
    if (
      guardPreDial({
        emit: (e) => this.emitWithUser(e, user),
        clientAddr: getSocketAddress(client),
        dial: { host, port },
        dest: { host, port },
        deny: () => this.replyFail(client, ver),
      })
    ) {
      return;
    }

    // SOCKS 上下文：guard 经 socksUpstreamGuard 收口——只做超时/错误时的上游销毁，不写 HTTP 报文；
    // keepClientOnFailure 保证客户端留给各 catch 回 SOCKS 失败应答（否则客户端被连带销毁，应答写不出去）
    const guard = socksUpstreamGuard("socks", (e) => this.emit(e));
    const mode = get("proxyMode");

    if (mode !== "client") {
      try {
        const upstream = await this.dialer.dialDirect(client, host, port, guard);

        this.replySuccess(client, ver);
        this.emitWithUser(
          { type: "socks", message: `[socks] tunnel established ${host}:${port} (socks${ver})` },
          user,
        );
        this.establish(client, upstream, residual);
      } catch (e) {
        this.emitWithUser(
          {
            type: "upstream-error",
            message: `[socks] upstream error ${host}:${port}: ${(e as Error).message}`,
          },
          user,
        );
        this.replyFail(client, ver);
      }

      return;
    }

    const proto = get("upstreamProtocol");
    const upstreamHost = get("upstreamHost");
    const upstreamPort = get("upstreamPort");

    // 上游自环：client 模式下 http/https 与 socks 两个分支拨的都是上游，
    // 上游指回自身监听地址会成环（真实目标的自环已在上方判过），拨号前先拦
    if (isSelfLoop(upstreamHost, upstreamPort)) {
      this.emitWithUser({ type: "loop-detected", target: `${upstreamHost}:${upstreamPort}` }, user);
      this.replyFail(client, ver);
      return;
    }

    // http(s) 上游载 CONNECT：等 200 才回成功；拨号/报文/等状态行收口在 dialViaHttpUpstream
    if (proto === "http" || proto === "https") {
      try {
        const {
          sock: upstream,
          statusCode,
          head,
          rest,
        } = await this.dialer.dialViaHttpUpstream(
          client,
          host,
          port,
          `${host}:${port} via ${upstreamHost}:${upstreamPort}`,
          {
            // 此处 proto 仅可能是 http/https（socks 系在下方分支自行推导 secure）——
            // 原 `secure` 上的 sockss4/sockss5 条件为不可达死代码，已随收敛删除
            secure: isTlsUpstreamProto(proto),
            logPrefix: "socks",
            onEvent: (e) => this.emit(e),
          },
        );

        // 严格取状态行三位码比对：响应头里出现 "200" 子串（如 realm="200"）不得误判为建链成功
        if (statusCode !== String(STATUS_OK)) {
          this.emitWithUser(
            {
              type: "upstream-refused",
              statusLine: Buffer.concat([head, rest]).toString().split(CRLF)[0],
            },
            user,
          );
          this.replyFail(client, ver);
          upstream.destroy();
          return;
        }

        this.replySuccess(client, ver);
        this.emitWithUser(
          {
            type: "socks",
            message: `[socks] tunnel via upstream ${upstreamHost}:${upstreamPort} -> ${host}:${port}`,
          },
          user,
        );
        // 头部之后可能已有上游字节，一并回送客户端
        this.establish(client, upstream, residual, rest);
      } catch (e) {
        this.emitWithUser(
          {
            type: "upstream-error",
            message: `[socks] upstream error ${host}:${port}: ${(e as Error).message}`,
          },
          user,
        );
        this.replyFail(client, ver);
      }

      return;
    }

    // socks 上游做第二段握手到真实目标（版本由共享映射推导）
    const version = socksVersionOf(proto);

    try {
      const upstream = await this.dialer.dialSocks(client, host, port, version, undefined, guard);

      this.replySuccess(client, ver);
      this.emitWithUser(
        {
          type: "socks",
          message: `[socks] tunnel via socks upstream ${host}:${port} (socks${ver}->socks${version})`,
        },
        user,
      );
      this.establish(client, upstream, residual);
    } catch (e) {
      this.emitWithUser(
        {
          type: "upstream-error",
          message: `[socks] socks upstream error ${host}:${port}: ${(e as Error).message}`,
        },
        user,
      );
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
    // 回失败应答后延时销毁，确保 FAIL 字节先发出再断链（防下游收不到回包）
    writeReplyAndClose(socket, ver === 5 ? SOCKS5_REPLY_FAILURE : SOCKS4_REPLY_FAILURE);
  }
}
