import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import {
  isValidTargetHost,
  isTlsUpstreamProto,
  resolveRoute,
  socksVersionOf,
  writeReplyAndClose,
} from "@/core/proxy-helpers.js";
import { socksUpstreamGuard } from "@/core/guard.js";
import { ipv6BytesToString, normalizeIp } from "@/utils/addr/address.js";
import { getSocketAddress, getSocketLocalBinding } from "@/utils/net/socket.js";
import { CRLF, STATUS_OK } from "@/utils/protocol/http.js";
import {
  SOCKS4_NULL,
  SOCKS4_REPLY_FAILURE,
  SOCKS4_VERSION,
  SOCKS5_ATYP_DOMAIN,
  SOCKS5_ATYP_IPV4,
  SOCKS5_ATYP_IPV6,
  SOCKS5_AUTH_VERSION,
  SOCKS5_REPLY_FAILURE,
  SOCKS5_VERSION,
  SOCKS_CMD_CONNECT,
  buildSocks4ReplySuccess,
  buildSocks5ReplySuccess,
} from "@/utils/protocol/socks.js";
import type { SocksHandshakeReader } from "./socks-reader.js";
import { ForwarderBase } from "./base.js";

/**
 * 取应答 BND 字段：出站 socket 的本地绑定地址（4 字节 IPv4）+ 端口
 * @description
 * - ATYP 恒 `0x01`（IPv4），故真 IPv6 绑定地址无处可填（改 IPv6 会把 10 字节应答变成 22 字节），
 *   一律回退 `0.0.0.0:0` 并经 `onFallback` 说明原因；
 * - v4-mapped IPv6（`::ffff:1.2.3.4`，Windows/双栈常态）经 `normalizeIp` 归一为 4 字节；
 * - 取不到地址或端口（含未连接的替身 socket）同样回退，**绝不抛错**。
 * @param upstream - 已建成的出站 socket（duplex，本地绑定事实只在 socket 上）
 * @param onFallback - 回退原因回调（core 零日志：只发 debug 事件，由 server 层落盘）
 */
function boundReplyAddress(
  upstream: Duplex,
  onFallback: (message: string) => void,
): { address?: Buffer; port?: number } {
  const { address, port } = getSocketLocalBinding(upstream);
  const fallback = (reason: string): { address?: Buffer; port?: number } => {
    onFallback(`[socks] reply BND.ADDR falls back to 0.0.0.0:0: ${reason}`);
    return {};
  };

  if (address === undefined) {
    return fallback("upstream socket has no local address");
  }
  if (port === undefined) {
    return fallback("upstream socket has no local port");
  }

  const normalized = normalizeIp(address);

  if (!normalized) {
    return fallback(`local address is not an IP: ${address}`);
  }
  if (normalized.family !== 4) {
    return fallback(`local address is IPv6 (ATYP stays 0x01): ${address}`);
  }

  return { address: normalized.bytes, port };
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
 * 会话变体标签：日志括注用，**同一连接的所有行必须同源**
 * @description 反映握手变体（4 / 4a / 5），不反映传输（明文 socks4 与 TLS sockss4 同为 "socks4"）；
 * `CONNECT (...)` 分类行与 `tunnel established ... (...)` 成功行共用它，避免 4a 会话被标成 socks4 误导排查。
 */
export type SocksVariant = "socks4" | "socks4a" | "socks5";

/** 由 SOCKS4 解析结果取变体标签（4a 哨兵命中即为 socks4a） */
function socks4Variant(parsed: Socks4Target): SocksVariant {
  return parsed.isSocks4a ? "socks4a" : "socks4";
}

/**
 * SOCKS 转发器
 * - 下游：socks4 / socks5 明文（TLS 由 server 层承载）
 * - 上游：按有效模式（resolveRoute，见 forward/base）与 upstreamProtocol 串联 http/https/socks
 * - 握手：由 server 层用 {@link SocksHandshakeReader} 逐阶段读取并鉴权，成功后再交本类拨号
 * - 拨号器、事件槽与 `emitWithUser` 继承自 {@link ForwarderBase}
 */
export class SocksForwarder extends ForwarderBase {

  /**
   * 读 SOCKS5 greeting（VER NMETHODS METHODS）；非法即 emit bad-request 并返回 null
   * @returns 客户端支持的鉴权方法列表，失败 null
   */
  async readGreeting(reader: SocksHandshakeReader): Promise<number[] | null> {
    const head = await reader.readExactly(2);

    if (!head || head[0] !== SOCKS5_VERSION) {
      return this.badRequest(reader, "[socks] invalid socks5 greeting");
    }

    const n = head[1];

    if (n < 1) {
      return this.badRequest(reader, "[socks] socks5 greeting without methods");
    }

    const body = await reader.readExactly(n);

    if (!body) {
      return this.badRequest(reader, "[socks] socks5 greeting truncated");
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
      return this.badRequest(reader, "[socks] invalid socks4 request");
    }

    const port = head.readUInt16BE(2);
    // 4a 哨兵：DSTIP 落在 0.0.0.0/24（IANA 保留的 "this network"，不会是真实拨号目标）。
    // 规范草稿写全 0（0.0.0.0），curl / PySocks 等事实标准发 0.0.0.1 —— 两种都必须认：
    // 漏掉全 0 会把请求当纯4、目标成了 0.0.0.0，域名字段残留在握手缓冲里被当载荷打进隧道，
    // 客户端先收到假的 90 GRANTED、再拿到上游本机吐的 400 垃圾（比直接失败更难查）。
    const isSocks4a = head[4] === 0 && head[5] === 0 && head[6] === 0;
    const uid = await reader.readUntil(SOCKS4_NULL);

    if (!uid) {
      return this.badRequest(reader, "[socks] socks4 missing USERID NUL");
    }

    const userid = uid.toString();
    let host = `${head[4]}.${head[5]}.${head[6]}.${head[7]}`;

    if (isSocks4a) {
      const dom = await reader.readUntil(SOCKS4_NULL);

      if (!dom) {
        return this.badRequest(reader, "[socks] socks4a missing DOMAIN NUL");
      }

      host = dom.toString();

      if (!host) {
        return this.badRequest(reader, "[socks] socks4a empty domain");
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
    // 变体标签与下方建隧成功行同源：4a 会话两行都标 socks4a，不标成 socks4 误导排查
    const variant = socks4Variant(parsed);

    this.emitWithUser(
      {
        type: "socks",
        message: `[socks] ${client} -> ${parsed.host}:${parsed.port} CONNECT (${variant})`,
      },
      user,
    );
    void this.connect(socket, parsed.host, parsed.port, 4, variant, residual, user);
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
    /** 失败收尾：解绑读取器并回 SOCKS5 失败应答（延时销毁） */
    const fail = (): void => {
      reader.dispose();
      this.replyFail(socket, 5);
    };

    const target = await this.readSocks5Request(reader);

    if (!target) {
      fail();
      return;
    }

    const residual = this.detach(reader, socket);
    const client = getSocketAddress(socket);

    this.emitWithUser(
      { type: "socks", message: `[socks] ${client} -> ${target.host}:${target.port} CONNECT (socks5)` },
      user,
    );
    await this.connect(socket, target.host, target.port, 5, "socks5", residual, user);
  }

  /**
   * 解析 SOCKS5 CONNECT：VER CMD RSV ATYP + 地址 + 端口，按 ATYP 精确所需长度
   * 域名型校验域名长度（1..255）与「域名 + 端口」字节齐全，缺字节由读取器等待/超时兜底
   */
  private async readSocks5Request(reader: SocksHandshakeReader): Promise<{ host: string; port: number } | null> {
    const head = await reader.readExactly(4);

    if (!head || head[0] !== SOCKS5_VERSION || head[1] !== SOCKS_CMD_CONNECT) {
      return this.badRequest(reader, "[socks] invalid socks5 CONNECT request");
    }

    const atyp = head[3];

    if (atyp === SOCKS5_ATYP_IPV4) {
      const rest = await reader.readExactly(6);

      if (!rest) {
        return this.badRequest(reader, "[socks] socks5 ipv4 truncated");
      }

      return { host: `${rest[0]}.${rest[1]}.${rest[2]}.${rest[3]}`, port: rest.readUInt16BE(4) };
    }

    if (atyp === SOCKS5_ATYP_IPV6) {
      const rest = await reader.readExactly(18);

      if (!rest) {
        return this.badRequest(reader, "[socks] socks5 ipv6 truncated");
      }

      return { host: ipv6BytesToString(rest.subarray(0, 16)), port: rest.readUInt16BE(16) };
    }

    if (atyp === SOCKS5_ATYP_DOMAIN) {
      const l = await reader.readExactly(1);

      if (!l) {
        return this.badRequest(reader, "[socks] socks5 domain length truncated");
      }

      const len = l[0];

      if (len === 0) {
        return this.badRequest(reader, "[socks] socks5 empty domain");
      }

      // 域名（<=255）+ 端口（2）必须齐全，缺字节时读取器等待至超时/关闭
      const rest = await reader.readExactly(len + 2);

      if (!rest) {
        return this.badRequest(reader, "[socks] socks5 domain truncated");
      }

      return { host: rest.subarray(0, len).toString(), port: rest.readUInt16BE(len) };
    }

    return this.badRequest(reader, `[socks] unsupported socks5 atyp=${atyp}`);
  }

  /**
   * 统一 bad-request 出口：发事件后返回 null，供各解析分支一行收尾
   * @description 事件带上 `bytes`（读取器自维护的 `bytesReceived`，可靠、与 socket 属性无关），
   * 落盘等级由 server 层据此定级（见 `src/server/AGENTS.md`）：**0 字节 = 对端连上不发就断
   * （裸 TCP 探活/扫描/健康检查）→ debug**；**读到过任何字节 = 客户端真发了垃圾字节的畸形握手
   * → warn**。core 只发事实、不定级（0 字节的降级优先于 warn，判定全部收在 server 层一处）。
   * @param reader - 本次连接共用的握手读取器，取已收字节数
   * @param message - 与原先逐处 emit 的文案逐字一致
   * @returns 恒为 null
   */
  private badRequest(reader: SocksHandshakeReader, message: string): null {
    this.emit({ type: "bad-request", message, bytes: reader.bytesReceived });
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
   * 三分支共用 {@link connectVia} 的建隧模板，失败统一由其 catch 回对应 SOCKS 失败应答
   * @param variant - 会话变体标签（socks4/socks4a/socks5），建隧成功行括注与 CONNECT 分类行同源
   * @param user - 已鉴权用户名，随事件带给日志（每会话参数，不落单例字段）
   */
  private async connect(
    client: Duplex,
    host: string,
    port: number,
    ver: 4 | 5,
    variant: SocksVariant,
    residual?: Buffer,
    user?: string,
  ): Promise<void> {
    // 目标主机来自客户端原始字节（SOCKS 域名不过 HTTP 解析器）：先过白名单与长度上限，
    // 再进基类前置守卫（自环+名单）/ buildConnectRequest / SOCKS 上游请求，杜绝报文注入与 1 字节长度域截断
    if (!isValidTargetHost(host)) {
      this.replyFail(client, ver);
      return;
    }

    // 自环 + 目标名单与 http/tunnel/websocket 共用前置守卫：
    // 名单事件经 emitWithUser 附带本会话用户名，clientAddr 供日志定位；
    // 拒绝收尾不看状态码（SOCKS 语境回 HTTP 报文会污染协议，统一回失败应答）
    if (
      this.preDial({
        clientAddr: getSocketAddress(client),
        dial: { host, port },
        dest: { host, port },
        deny: () => this.replyFail(client, ver),
        user,
      })
    ) {
      return;
    }

    // SOCKS 上下文：guard 经 socksUpstreamGuard 收口——只做超时/错误时的上游销毁，不写 HTTP 报文；
    // keepClientOnFailure 保证客户端留给各 catch 回 SOCKS 失败应答（否则客户端被连带销毁，应答写不出去）
    const guard = socksUpstreamGuard("socks", (e) => this.emit(e));
    // 路由判定（preDial 之后）：配置 server 短路不查 upstream 组；client 命中名单回落直连
    const route = resolveRoute({ host, port });
    this.emitRoute({ host, port }, route);

    // 有效模式：配置 server 或 client 命中路由名单 → 走直连分支（成功文案与 server 模式一致）
    if (route.mode !== "client") {
      await this.connectVia(
        client,
        ver,
        residual,
        user,
        `[socks] tunnel established ${host}:${port} (${variant})`,
        (e) => `[socks] upstream error ${host}:${port}: ${e.message}`,
        async () => ({ upstream: await this.dialer.dialDirect(client, host, port, guard) }),
      );
      return;
    }

    const proto = get("upstreamProtocol");
    const upstreamHost = get("upstreamHost");
    const upstreamPort = get("upstreamPort");

    // 上游自环：client 模式下 http/https 与 socks 两个分支拨的都是上游，
    // 上游指回自身监听地址会成环（真实目标的自环已在上方判过），拨号前先拦
    if (this.denyUpstreamLoop(upstreamHost, upstreamPort, () => this.replyFail(client, ver), { user })) {
      return;
    }

    // http(s) 上游载 CONNECT：等 200 才回成功；拨号/报文/等状态行收口在 dialViaHttpUpstream
    if (proto === "http" || proto === "https") {
      await this.connectVia(
        client,
        ver,
        residual,
        user,
        `[socks] tunnel via upstream ${upstreamHost}:${upstreamPort} -> ${host}:${port}`,
        (e) => `[socks] upstream error ${host}:${port}: ${e.message}`,
        async () => {
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
            return null;
          }

          // 头部之后可能已有上游字节，一并回送客户端
          return { upstream, rest };
        },
      );
      return;
    }

    // socks 上游做第二段握手到真实目标（版本由共享映射推导）
    const version = socksVersionOf(proto);

    await this.connectVia(
      client,
      ver,
      residual,
      user,
      `[socks] tunnel via socks upstream ${host}:${port} (${variant}->socks${version})`,
      (e) => `[socks] socks upstream error ${host}:${port}: ${e.message}`,
      async () => ({ upstream: await this.dialer.dialSocks(client, host, port, version, undefined, guard) }),
    );
  }

  /**
   * direct / viaHttp / viaSocks 三分支共用的建隧模板：
   * 拨号 → 回成功应答 → emit 建隧成功 → establish 桥接；拨号失败 emit upstream-error 后回失败应答
   * （成功/失败日志文案随分支传入，逐字保持原样）
   * @param client - 客户端双工流
   * @param ver - 入站 SOCKS 版本（决定成功与失败应答字节）
   * @param residual - 客户端流水线余量（建隧时回灌上游）
   * @param user - 已鉴权用户名，随事件带给日志
   * @param successMessage - 建隧成功日志文案
   * @param failMessage - 拨号异常 → upstream-error 日志文案
   * @param dial - 拨号闭包；返回 null 表示已在闭包内自行收尾（http 上游状态码非 200），不再走成功/失败模板
   */
  private async connectVia(
    client: Duplex,
    ver: 4 | 5,
    residual: Buffer | undefined,
    user: string | undefined,
    successMessage: string,
    failMessage: (e: Error) => string,
    dial: () => Promise<{ upstream: Duplex; rest?: Buffer } | null>,
  ): Promise<void> {
    try {
      const dialed = await dial();

      if (!dialed) {
        return;
      }

      this.replySuccess(client, ver, dialed.upstream);
      this.emitWithUser({ type: "socks", message: successMessage }, user);
      this.establish(client, dialed.upstream, residual, dialed.rest);
    } catch (e) {
      this.emitWithUser({ type: "upstream-error", message: failMessage(e as Error) }, user);
      this.replyFail(client, ver);
    }
  }

  /**
   * 建隧收尾：回灌客户端流水线余量与上游头部后字节，再双向桥接
   * @description 二进制 replySuccess 留在调用方（`connectVia`），此处只是基类 `bridgeWithBuffered` 的转发
   */
  private establish(client: Duplex, upstream: Duplex, residual?: Buffer, upstreamHead?: Buffer): void {
    this.bridgeWithBuffered(client, upstream, residual, upstreamHead);
  }

  private replySuccess(socket: Duplex, ver: number, upstream: Duplex): void {
    // BND.ADDR/BND.PORT 取**出站 socket** 的本地绑定事实（RFC1928 §6 / RFC1925 §3）；
    // 取不到或非 IPv4 时回退 0.0.0.0:0 并经 debug 事件说明原因（core 零日志，绝不因此失败/抛错）
    const bound = boundReplyAddress(upstream, (message) => {
      this.emit({ type: "debug", message });
    });

    socket.write(
      ver === 5
        ? buildSocks5ReplySuccess(bound.address, bound.port)
        : buildSocks4ReplySuccess(bound.address, bound.port),
    );
  }

  private replyFail(socket: Duplex, ver: number): void {
    // 回失败应答后延时销毁，确保 FAIL 字节先发出再断链（防下游收不到回包）
    writeReplyAndClose(socket, ver === 5 ? SOCKS5_REPLY_FAILURE : SOCKS4_REPLY_FAILURE);
  }
}
