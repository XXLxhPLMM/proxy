/**
 * @fileoverview SOCKS4/4a/5 入站适配器 - 握手解析 + 会话驱动
 * @module core/forward/inbound/socks
 * @description
 * SOCKS **入站协议**的全部内容都在本文件：握手逐阶段读取与解析、目标解析、
 * 会话驱动（发 CONNECT 分类行 / 建隧）、SOCKS 二进制应答（成功 replySuccess / 失败 FAIL）。
 *
 * ```
 * server 层（socks-base + socks-session）构造 SocksHandshakeReader
 *      ↓ 逐阶段读 greeting / USERID / RFC1929 子协商 / CONNECT
 *   SocksInbound.parseSocks4 / readGreeting / readUserPass / readSocks5Request
 *      ↓ 鉴权（server 层做，identity 回传）
 *   SocksInbound.serveSocks4 / serveSocks5Connect
 *      ↓ 目标白名单 → routing.plan() → preDial → emitRoute
 *   dispatch(plan, responder)  ← 与传输维度正交，交给 plugins/forwarders.ts
 * ```
 *
 * 职责边界：
 * - **入站协议解析**（greeting / USERID / RFC1929 / SOCKS4 / SOCKS4a 哨兵 / SOCKS5 CONNECT）
 * - 目标白名单（`isValidTargetHost`：SOCKS 域名是客户端原始字节，不过 HTTP 解析器）
 * - 路由决策接线 + 前置守卫 + 路由事件
 * - `ProtocolResponder`：成功走 `buildSocks5ReplySuccess` / `buildSocks4ReplySuccess`（BND 规则见下），
 *   失败一律回 FAIL（**不看 HTTP 状态码**）；**刻意不实现 `relayUpstreamResponse`**
 *   （把 HTTP 字节写进 SOCKS 流就是协议污染）
 * - 建隧成功事实行（`tunnel established ...` / `tunnel via upstream ...` /
 *   `tunnel via socks upstream ...`）——三条文案由**计划**决定，故在应答器闭包里按
 *   `plan.transport` 逐字复现，与重构前 `SocksForwarder.connectVia` 的三条 dial 分支一一对应
 *
 * **本文件不做**（全在 `plugins/forwarders.ts`）：拨号、SOCKS 上游二次握手、
 * CONNECT 报文、上游状态行等待、拨号失败成因分流、余量回灌与桥接。
 *
 * 两条不可动的协议不变量（红线）：
 * - **成功应答的 BND 字段**（见 {@link boundReplyAddress}）：ATYP 恒 `0x01`、v4-mapped 归一、
 *   真 IPv6/取不到回退 `0.0.0.0:0` 并发 `debug` 事件，**绝不抛错、绝不让会话失败**
 * - **拒绝一律回 SOCKS FAIL，不看 HTTP 状态码**（403/502 回成 HTTP 报文会污染协议）
 *   而 `bad-request` 事件必须带上读取器自维护的 `bytesReceived`（0 字节 = 裸 TCP 探活，
 *   落盘降 debug 由 server 层定级，core 不定级）
 */

import type { Duplex } from "node:stream";
import { isValidTargetHost, socksVersionOf, writeReplyAndClose } from "@/core/proxy-helpers.js";
import { ipv4BytesToString, ipv6BytesToString, normalizeIp } from "@/utils/addr/address.js";
import { getSocketAddress } from "@/utils/net/socket.js";
import { STATUS_BAD_GATEWAY } from "@/utils/protocol/http.js";
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
import type { ForwardPlan, ForwardTarget, ProtocolResponder } from "@/core/types/plan.js";
import type { SocksHandshakeReader } from "./socks-reader.js";
import { InboundForwarderBase } from "./base.js";

/**
 * 取应答 BND 字段：出站 socket 的本地绑定地址（4 字节 IPv4）+ 端口
 * @description
 * 事实来源是 `ProtocolResponder.establish({ local })` 交进来的出站 socket 本地绑定
 * （由 `utils/net/socket:getSocketLocalBinding` 鸭子类型嗅探，本地绑定只存在于 socket 上；
 * 传输策略侧**成对拿到**才交，缺项即 `undefined`）。
 * 硬规则（RFC1928 §6 / RFC1925 §3，破坏任一条就是协议失步）：
 * - ATYP 恒 `0x01`（IPv4），故真 IPv6 绑定地址无处可填（改 IPv6 会把 10 字节应答变成 22 字节，
 *   客户端按定长读取会把隧道首字节当成答尾巴），一律回退 `0.0.0.0:0` 并经 `onFallback` 说明原因；
 * - v4-mapped IPv6（`::ffff:1.2.3.4`，Windows/双栈常态）经 `normalizeIp` 归一为 4 字节；
 * - 取不到绑定（含未连接的替身 socket）同样回退，**绝不抛错**。
 * @param local - 出站 socket 的本地绑定（`host`/`port` 恒成对给出；缺省即「取不到」）
 * @param onFallback - 回退原因回调（core 零日志：只发 debug 事件，由 server 层落盘）
 */
function boundReplyAddress(
  local: { host: string; port: number } | undefined,
  onFallback: (message: string) => void,
): { address?: Buffer; port?: number } {
  const fallback = (reason: string): { address?: Buffer; port?: number } => {
    onFallback(`[socks] reply BND.ADDR falls back to 0.0.0.0:0: ${reason}`);
    return {};
  };

  if (!local) {
    return fallback("upstream socket has no local binding");
  }

  const normalized = normalizeIp(local.host);

  if (!normalized) {
    return fallback(`local address is not an IP: ${local.host}`);
  }
  if (normalized.family !== 4) {
    return fallback(`local address is IPv6 (ATYP stays 0x01): ${local.host}`);
  }

  return { address: normalized.bytes, port: local.port };
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
 * 建隧成功事实文案：三条传输分支各一条（逐字复现重构前 `SocksForwarder.connectVia` 的 dial 闭包）
 * @description 事实的**发出点**在应答器的 `establish`（传输策略建链成功的那一刻），
 * 而文案取决于**计划**（走哪条传输策略 / 上游是什么），故在入站侧按计划渲染。
 * @param plan - 本次转发计划
 * @param target - 客户端请求的目标
 * @param variant - 会话变体标签（socks4/socks4a/socks5），与 CONNECT 分类行同源
 * @returns 建隧成功行的 message 文案
 */
function tunnelEstablishedMessage(plan: ForwardPlan, target: ForwardTarget, variant: SocksVariant): string {
  const { host, port } = target;
  const upstream = plan.upstream;

  if (!upstream || plan.transport === "direct-stream") {
    return `[socks] tunnel established ${host}:${port} (${variant})`;
  }

  if (plan.transport === "http-upstream") {
    return `[socks] tunnel via upstream ${upstream.host}:${upstream.port} -> ${host}:${port}`;
  }

  // socks 上游：版本标签由共享映射按端点 protocol 推导（与 dialSocks 内部同一来源，不重复推导）
  const version = socksVersionOf(upstream.protocol);
  return `[socks] tunnel via socks upstream ${host}:${port} (${variant}->socks${version})`;
}

/**
 * SOCKS 入站适配器
 * - 下游：socks4 / socks5 明文（TLS 由 server 层承载）
 * - 握手：由 server 层用 {@link SocksHandshakeReader} 逐阶段读取并鉴权，成功后再交本类分派
 * - 传输：按 `plan.transport` 交给注册表里的传输策略（direct / http(s) 上游 / socks 上游）
 * - 路由入口、前置守卫与策略分派继承自 {@link InboundForwarderBase}
 */
export class SocksInbound extends InboundForwarderBase {
  /**
   * 读 SOCKS5 greeting（VER NMETHODS METHODS）；非法即 emit bad-request 并返回 null
   * @returns 客户端支持的鉴权方法列表，失败 null
   * @param reader - 共享握手读取器
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
   * @param reader - 共享握手读取器
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
   * @param reader - 共享握手读取器
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
   * SOCKS4/4a 已解析并鉴权：发 CONNECT 分类行后按 `plan.transport` 分派
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
    // 变体标签与建隧成功行同源：4a 会话两行都标 socks4a，不标成 socks4 误导排查
    const variant = socks4Variant(parsed);

    this.emitWithUser(
      {
        type: "socks",
        message: `[socks] ${client} -> ${parsed.host}:${parsed.port} CONNECT (${variant})`,
      },
      user,
    );
    this.serve(socket, { host: parsed.host, port: parsed.port, path: "" }, 4, variant, residual, user);
  }

  /**
   * SOCKS5 已鉴权：读 CONNECT 请求后按 `plan.transport` 分派（复用同一读取器以承接流水线/分段）
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
    this.serve(socket, { host: target.host, port: target.port, path: "" }, 5, "socks5", residual, user);
  }

  /**
   * 解析 SOCKS5 CONNECT：VER CMD RSV ATYP + 地址 + 端口，按 ATYP 精确所需长度
   * @description 域名型校验域名长度（1..255）与「域名 + 端口」字节齐全，缺字节由读取器等待/超时兜底
   * @param reader - 共享握手读取器
   * @returns `{ host, port }`；格式非法返回 null（已发 `bad-request`）
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

      return { host: ipv4BytesToString(rest.subarray(0, 4)), port: rest.readUInt16BE(4) };
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
   * 落盘等级由 server 层据此定级（见 `src/core/AGENTS.md`）：**0 字节 = 对端连上不发就断
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
   * 目标已解析并鉴权：目标白名单 → 路由决策 → 前置守卫 → 路由事件 → 按 `plan.transport` 分派
   * @description
   * 目标主机来自客户端原始字节（SOCKS 域名不过 HTTP 解析器）：先过白名单与长度上限，
   * 再进基类前置守卫（自环+名单）与传输策略（`Dialer` 内部的上游报文构造），
   * 杜绝报文注入与 1 字节长度域截断。
   * @param client - 客户端双工流
   * @param target - 客户端请求的目标（握手原始字节，不过 HTTP 解析器）
   * @param ver - 入站 SOCKS 版本（4 | 5，决定成功与失败应答字节）
   * @param variant - 会话变体标签（socks4/socks4a/socks5），建隧成功行括注与 CONNECT 分类行同源
   * @param residual - 客户端握手之后的流水线余量（建隧时回灌上游）
   * @param user - 已鉴权用户名，随事件带给日志（每会话参数，不落单例字段）
   */
  private serve(
    client: Duplex,
    target: ForwardTarget,
    ver: 4 | 5,
    variant: SocksVariant,
    residual: Buffer | undefined,
    user: string | undefined,
  ): void {
    const clientAddr = getSocketAddress(client);

    if (!isValidTargetHost(target.host)) {
      this.replyFail(client, ver);
      return;
    }

    const responder = this.responder(client, ver, user);

    const plan = this.planRoute(
      {
        inbound: "socks",
        target,
        // SOCKS 通道没有请求路径（隧道内是裸字节流）
        requestPath: "",
        clientAddress: clientAddr,
        username: user,
      },
      responder,
      { user, client: clientAddr },
    );

    if (!plan) {
      return;
    }

    // 自环 + 目标名单与 http/tunnel/websocket 共用前置守卫：
    // 名单事件经 emitWithUser 附带本会话用户名，clientAddr 供日志定位；
    // 拒绝收尾不看状态码（SOCKS 语境回 HTTP 报文会污染协议，由应答器统一回失败应答）
    if (
      this.preDial({
        clientAddr,
        dial: this.dialTarget(plan),
        dest: plan.target,
        listen: plan.listen,
        responder,
        user,
      })
    ) {
      return;
    }

    // preDial 已过：名单参与判定的请求恰发一条路由事件（server 模式在 emitRoute 内短路）
    this.emitRoute(plan);

    // 非直连：确认上游端点存在（fail-closed）并补判上游自环
    // （经上游时 http(s) 与 socks 两个分支拨的都是上游，真实目标的自环已在上方判过；名单不判上游）
    if (plan.transport !== "direct-stream") {
      const upstream = this.requireUpstream(plan, responder);

      if (!upstream) {
        return;
      }

      if (
        this.denyUpstreamLoop(
          upstream.host,
          upstream.port,
          plan.listen,
          () => this.refuse(responder, STATUS_BAD_GATEWAY),
          { user },
        )
      ) {
        return;
      }
    }

    this.dispatch(plan, this.establishedResponder(client, ver, user, plan, variant), {
      client,
      head: residual,
    });
  }

  /**
   * 传输阶段专用的应答器 = 基础应答器 + **建隧成功事实行**
   * @description
   * 基础应答器（{@link responder}）在**路由阶段**就要用（`planRoute` / `preDial` 的拒绝收尾），
   * 那时计划还不存在，建隧成功文案无从渲染；而「建链成功的瞬间」只有传输策略调
   * `establish()` 时才知道，故在拿到计划后再造一个带成功事实的应答器交给 `dispatch`。
   *
   * 顺序与重构前逐字一致：先写 SOCKS 成功应答字节 → 再发 `socks` 成功事实 → 传输策略回灌余量并桥接。
   * @param socket - 客户端双工流
   * @param ver - 入站 SOCKS 版本（4 | 5）
   * @param user - 已鉴权用户名（身份逐会话传入，绝不存字段）
   * @param plan - 已批准的转发计划（决定走哪条传输策略，即决定成功行文案）
   * @param variant - 会话变体标签（与 CONNECT 分类行同源）
   */
  private establishedResponder(
    socket: Duplex,
    ver: number,
    user: string | undefined,
    plan: ForwardPlan,
    variant: SocksVariant,
  ): ProtocolResponder {
    const base = this.responder(socket, ver, user);

    return {
      establish: (extra) => {
        base.establish(extra);
        this.emitWithUser(
          { type: "socks", message: tunnelEstablishedMessage(plan, plan.target, variant) },
          user,
        );
      },
      fail: base.fail,
      username: base.username,
    };
  }

  /**
   * 协议应答器：SOCKS 二进制应答（成功走 `establish`、失败一律走 `fail`）
   * @description
   * - `establish` 按入站版本回 replySuccess，BND.ADDR/BND.PORT 取 `extra.local`
   *   （出站 socket 的本地绑定事实；v4-mapped 归一、真 IPv6/取不到回退 `0.0.0.0:0` 并发 `debug` 事件，
   *   **绝不因此抛错或让会话失败**，见 {@link boundReplyAddress}）
   * - `fail` **忽略状态码**：SOCKS 语境回 HTTP 状态行会污染协议，一律回 FAIL 应答
   *   （403 名单拒绝 / 502 自环 / 504 超时在 SOCKS 侧不区分，与裸 socket 报文的分流同理）
   * - **刻意不实现 `relayUpstreamResponse`**：把上游的 HTTP 字节写进 SOCKS 流就是协议污染，
   *   传输策略据此回退到「`upstream-refused` 事实 + FAIL 应答」（与重构前逐字一致）
   * @param socket - 客户端双工流
   * @param ver - 入站 SOCKS 版本（4 | 5，决定成功与失败应答字节）
   * @param user - 已鉴权用户名（身份逐会话传入，绝不存字段）
   */
  private responder(socket: Duplex, ver: number, user?: string): ProtocolResponder {
    return {
      establish: (extra) => {
        const bound = boundReplyAddress(extra?.local, (message) => {
          this.emitWithUser({ type: "debug", message }, user);
        });

        socket.write(
          ver === 5
            ? buildSocks5ReplySuccess(bound.address, bound.port)
            : buildSocks4ReplySuccess(bound.address, bound.port),
        );
      },
      fail: () => {
        this.replyFail(socket, ver);
      },
      username: user ?? "",
    };
  }

  /**
   * 回失败应答后延时销毁，确保 FAIL 字节先发出再断链（防下游收不到回包）
   * @param socket - 待回复并关闭的连接
   * @param ver - 入站 SOCKS 版本（决定失败应答字节；失败应答的 BND 恒为全零，RFC 不要求）
   */
  private replyFail(socket: Duplex, ver: number): void {
    writeReplyAndClose(socket, ver === 5 ? SOCKS5_REPLY_FAILURE : SOCKS4_REPLY_FAILURE);
  }
}
