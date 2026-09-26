import type { Duplex } from "node:stream";
import { isValidTargetHost, resolveRoute, writeReplyAndClose } from "@/core/helpers/index.js";
import { ipv6BytesToString } from "@/config/files/rules/index.js";
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
  STATUS_FORBIDDEN,
} from "@/utils/constants/index.js";
import type { SocksHandshakeReader } from "./socks-reader.js";
import type { CoreContext } from "@/core/context.js";
import type { RequestScope } from "@/core/request-scope.js";
import type { BufferedCharge, TrafficAccount } from "@/core/traffic/index.js";
import { connectorFor, directConnector } from "./connector/index.js";
import type { OpenedUpstream, UpstreamConnector } from "./connector/index.js";
import { ForwarderBase } from "./base.js";

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
 * - 上游：按有效模式（resolveRoute，见 forward/base）与 upstreamProtocol 串联 http/https/socks
 * - 握手：由 server 层用 {@link SocksHandshakeReader} 逐阶段读取并鉴权，成功后再交本类拨号
 * - 拨号器继承自 {@link ForwarderBase}；事件一律经 `scope.emit` 发出
 *
 * **本类是跨会话共享单例**（`SocksProxyBase` 在服务构造期建一次、四个 SOCKS server 各一个）。
 * 每一会话的 `user` / `requestId` / `connectionId` / 终态守卫**只经 `RequestScope` 参数逐次传入**
 * ——存字段即串号（并发会话会把 A 的身份记到 B 的事件上）。护栏见
 * `tests/integration/forwarder-instance-reuse.test.ts`。
 */
export class SocksForwarder extends ForwarderBase {
  /**
   * @param ctx - 依赖上下文，必须显式注入
   * @description 逐会话的事件槽与终态守卫经各入口方法的 `scope` 参数传入，
   * **不进构造期**：本实例是跨会话共享单例。
   */
  constructor(ctx: CoreContext, traffic: TrafficAccount) {
    super(ctx, traffic);
  }

  /**
   * 读 SOCKS5 greeting（VER NMETHODS METHODS）；非法即 emit bad-request 并返回 null
   * @param reader - 共享握手读取器
   * @param scope - 本会话的作用域（事件出口 + 身份维度）；此时尚未鉴权，`user` 通常为空
   * @returns 客户端支持的鉴权方法列表，失败 null
   */
  async readGreeting(reader: SocksHandshakeReader, scope: RequestScope): Promise<number[] | null> {
    const head = await reader.readExactly(2);

    if (!head || head[0] !== SOCKS5_VERSION) {
      return this.badRequest("[socks] invalid socks5 greeting", scope);
    }

    const n = head[1];

    if (n < 1) {
      return this.badRequest("[socks] socks5 greeting without methods", scope);
    }

    const body = await reader.readExactly(n);

    if (!body) {
      return this.badRequest("[socks] socks5 greeting truncated", scope);
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
   * @param reader - 共享握手读取器
   * @param scope - 本会话的作用域（事件出口 + 身份维度）
   * @returns USERID/host/port/isSocks4a，失败 null
   */
  async parseSocks4(
    reader: SocksHandshakeReader,
    scope: RequestScope,
  ): Promise<Socks4Target | null> {
    const head = await reader.readExactly(8);

    if (!head || head[0] !== SOCKS4_VERSION || head[1] !== SOCKS_CMD_CONNECT) {
      return this.badRequest("[socks] invalid socks4 request", scope);
    }

    const port = head.readUInt16BE(2);
    // 4a 哨兵：DSTIP 落在 0.0.0.0/24（IANA 保留的 "this network"，不会是真实拨号目标）。
    // 规范草稿写全 0（0.0.0.0），curl / PySocks 等事实标准发 0.0.0.1 —— 两种都必须认：
    // 漏掉全 0 会把请求当纯4、目标成了 0.0.0.0，域名字段残留在握手缓冲里被当载荷打进隧道，
    // 客户端先收到假的 90 GRANTED、再拿到上游本机吐的 400 垃圾（比直接失败更难查）。
    const isSocks4a = head[4] === 0 && head[5] === 0 && head[6] === 0;
    const uid = await reader.readUntil(SOCKS4_NULL);

    if (!uid) {
      return this.badRequest("[socks] socks4 missing USERID NUL", scope);
    }

    const userid = uid.toString();
    let host = `${head[4]}.${head[5]}.${head[6]}.${head[7]}`;

    if (isSocks4a) {
      const dom = await reader.readUntil(SOCKS4_NULL);

      if (!dom) {
        return this.badRequest("[socks] socks4a missing DOMAIN NUL", scope);
      }

      host = dom.toString();

      if (!host) {
        return this.badRequest("[socks] socks4a empty domain", scope);
      }
    }

    return { userid, host, port, isSocks4a };
  }

  /**
   * SOCKS4/4a 已解析并鉴权：移交数据流余量并建隧
   * @param socket - 客户端双工流
   * @param parsed - 已解析目标
   * @param reader - 共享握手读取器（用于取走流水线余量并解绑）
   * @param scope - 本会话的作用域（事件出口 + 已鉴权 `user` + 终态守卫）：**逐会话传入，绝不存字段**
   */
  serveSocks4(
    socket: Duplex,
    parsed: Socks4Target,
    reader: SocksHandshakeReader,
    scope: RequestScope,
  ): void {
    const terminal = scope.terminal;
    const residual = this.detach(reader, socket);
    const client = getSocketAddress(socket);
    terminal.setContext({ target: `${parsed.host}:${parsed.port}` });

    scope.emit({
      type: "socks",
      message: `[socks] ${client} -> ${parsed.host}:${parsed.port} CONNECT (socks4${parsed.isSocks4a ? "a" : ""})`,
    });
    void this.connect(socket, parsed.host, parsed.port, 4, residual, scope);
  }

  /**
   * SOCKS5 已鉴权：读 CONNECT 请求并建隧（复用同一读取器以承接流水线/分段）
   * @param socket - 客户端双工流
   * @param reader - 共享握手读取器
   * @param scope - 本会话的作用域（事件出口 + 已鉴权 `user` + 终态守卫）：**逐会话传入，绝不存字段**
   */
  async serveSocks5Connect(
    socket: Duplex,
    reader: SocksHandshakeReader,
    scope: RequestScope,
  ): Promise<void> {
    const terminal = scope.terminal;

    /** 失败收尾：解绑读取器并回 SOCKS5 失败应答（延时销毁） */
    const fail = (): void => {
      reader.dispose();
      this.replyFail(socket, 5);
    };

    const target = await this.readSocks5Request(reader, scope);

    if (!target) {
      fail();
      terminal.reject("invalid-socks5-request", "parse");
      return;
    }

    const residual = this.detach(reader, socket);
    const client = getSocketAddress(socket);
    terminal.setContext({ target: `${target.host}:${target.port}` });

    scope.emit({
      type: "socks",
      message: `[socks] ${client} -> ${target.host}:${target.port} CONNECT (socks5)`,
    });
    await this.connect(socket, target.host, target.port, 5, residual, scope);
  }

  /**
   * 解析 SOCKS5 CONNECT：VER CMD RSV ATYP + 地址 + 端口，按 ATYP 精确所需长度
   * 域名型校验域名长度（1..255）与「域名 + 端口」字节齐全，缺字节由读取器等待/超时兜底
   * @param scope - 本会话的作用域（bad-request 事件出口 + 身份维度）
   */
  private async readSocks5Request(
    reader: SocksHandshakeReader,
    scope: RequestScope,
  ): Promise<{ host: string; port: number } | null> {
    const head = await reader.readExactly(4);

    if (!head || head[0] !== SOCKS5_VERSION || head[1] !== SOCKS_CMD_CONNECT) {
      return this.badRequest("[socks] invalid socks5 CONNECT request", scope);
    }

    const atyp = head[3];

    if (atyp === SOCKS5_ATYP_IPV4) {
      const rest = await reader.readExactly(6);

      if (!rest) {
        return this.badRequest("[socks] socks5 ipv4 truncated", scope);
      }

      return { host: `${rest[0]}.${rest[1]}.${rest[2]}.${rest[3]}`, port: rest.readUInt16BE(4) };
    }

    if (atyp === SOCKS5_ATYP_IPV6) {
      const rest = await reader.readExactly(18);

      if (!rest) {
        return this.badRequest("[socks] socks5 ipv6 truncated", scope);
      }

      return { host: ipv6BytesToString(rest.subarray(0, 16)), port: rest.readUInt16BE(16) };
    }

    if (atyp === SOCKS5_ATYP_DOMAIN) {
      const l = await reader.readExactly(1);

      if (!l) {
        return this.badRequest("[socks] socks5 domain length truncated", scope);
      }

      const len = l[0];

      if (len === 0) {
        return this.badRequest("[socks] socks5 empty domain", scope);
      }

      // 域名（<=255）+ 端口（2）必须齐全，缺字节时读取器等待至超时/关闭
      const rest = await reader.readExactly(len + 2);

      if (!rest) {
        return this.badRequest("[socks] socks5 domain truncated", scope);
      }

      return { host: rest.subarray(0, len).toString(), port: rest.readUInt16BE(len) };
    }

    return this.badRequest(`[socks] unsupported socks5 atyp=${atyp}`, scope);
  }

  /**
   * 统一 bad-request 出口：发事件后返回 null，供各解析分支一行收尾
   * @param message - 与原先逐处 emit 的文案逐字一致
   * @param scope - 本会话的作用域（事件出口 + 身份维度）
   * @returns 恒为 null
   */
  private badRequest(message: string, scope: RequestScope): null {
    scope.emit({ type: "bad-request", message });
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
   * @param scope - 本会话的作用域（事件出口 + 已鉴权 `user` + 终态守卫）：**逐会话参数，不落单例字段**
   */
  private async connect(
    client: Duplex,
    host: string,
    port: number,
    ver: 4 | 5,
    residual: Buffer | undefined,
    scope: RequestScope,
  ): Promise<void> {
    const terminal = scope.terminal;
    terminal.setContext({ target: `${host}:${port}` });

    // 目标主机来自客户端原始字节（SOCKS 域名不过 HTTP 解析器）：先过白名单与长度上限，
    // 再进基类前置守卫（自环+名单）/ buildConnectRequest / SOCKS 上游请求，杜绝报文注入与 1 字节长度域截断
    if (!isValidTargetHost(host)) {
      this.replyFail(client, ver);
      terminal.reject("invalid-target", "parse");
      return;
    }

    // 自环 + 目标名单与 http/tunnel/websocket 共用前置守卫：
    // 名单事件经 scope.emit 附带本会话用户名，clientAddr 供日志定位；
    // 拒绝收尾不看状态码（SOCKS 语境回 HTTP 报文会污染协议，统一回失败应答）
    if (
      this.preDial(
        {
          clientAddr: getSocketAddress(client),
          dial: { host, port },
          dest: { host, port },
          deny: (status) => {
            this.replyFail(client, ver);
            if (status === STATUS_FORBIDDEN) {
              terminal.reject("target-denied", "access");
            } else {
              terminal.fail(new Error("proxy loop detected"), "dial");
            }
          },
        },
        scope,
      )
    ) {
      return;
    }

    // 路由判定（preDial 之后）：配置 server 短路不查 upstream 组；client 命中名单回落直连
    const route = resolveRoute({ host, port }, this.config);
    this.emitRoute({ host, port }, route, scope);

    // 「用哪个连接器」与「有效路由是不是 direct」是同一件事：`route.route === "direct"` ⟺ 该拨真实目标
    // （见 connector/registry 的模块头裁决 1）。命中 upstream 路由名单回落直连的请求**必须**走
    // directConnector，绝不能碰 connectorFor —— 那会绕过名单判定去拨上游。
    const connector =
      route.route === "direct"
        ? directConnector(this.ctx)
        : connectorFor(this.config.get("upstreamProtocol"), this.ctx);

    const upstreamHost = this.config.get("upstreamHost");
    const upstreamPort = this.config.get("upstreamPort");

    // 上游自环：client 模式下 http/https 与 socks 两种上游拨的都是 upstreamHost:upstreamPort，
    // 上游指回自身监听地址会成环（真实目标的自环已在上方判过）。直连连接器无上游地址 → 跳过
    const loop = connector.selfLoopTarget();

    if (
      loop &&
      this.denyUpstreamLoop(
        loop.host,
        loop.port,
        () => {
          this.replyFail(client, ver);
          terminal.fail(new Error("upstream proxy loop detected"), "dial");
        },
        scope,
      )
    ) {
      return;
    }

    // 有效模式：配置 server 或 client 命中路由名单 → 走直连分支（成功文案与 server 模式一致）
    if (connector.kind === "direct") {
      await this.connectVia(
        client,
        ver,
        residual,
        scope,
        `[socks] tunnel established ${host}:${port} (socks${ver})`,
        (e) => `[socks] upstream error ${host}:${port}: ${e.message}`,
        () => this.openVia(connector, client, { host, port }, scope),
      );
      return;
    }

    // http(s) 上游载 CONNECT：等 200 才回成功；非 200 由 `refusal` 如实带回，处置在本 channel
    // （SOCKS 语境回 HTTP 报文会污染协议，故是「发 upstream-refused 事件 + 回失败应答」而非 tunnel 的原样透传）
    if (connector.targetForm === "absolute") {
      await this.connectVia(
        client,
        ver,
        residual,
        scope,
        `[socks] tunnel via upstream ${upstreamHost}:${upstreamPort} -> ${host}:${port}`,
        (e) => `[socks] upstream error ${host}:${port}: ${e.message}`,
        async () => {
          const { sock, rest, refusal } = await this.openVia(connector, client, { host, port }, scope);

          // 严格取状态行三位码比对：响应头里出现 "200" 子串（如 realm="200"）不得误判为建链成功
          if (refusal) {
            scope.emit({
              type: "upstream-refused",
              statusLine: Buffer.concat([refusal.head, refusal.rest]).toString().split(CRLF)[0],
            });
            this.replyFail(client, ver);
            sock.destroy();
            terminal.fail(new Error(`upstream CONNECT returned ${refusal.statusCode}`), "dial");
            return null;
          }

          // 头部之后可能已有上游字节，一并回送客户端
          return { sock, rest };
        },
      );
      return;
    }

    // SOCKS 上游做第二段握手到真实目标（版本与 TLS 承载由连接器构造期钉死；日志文案里的
    // **版本号也从 `connector.kind` 取**——`kind` 就是「这个连接器是哪一版」的声明，
    // 再从 `upstreamProtocol` 二次推导就是连接器层要消灭的第二真相源，且两处迟早漂移）
    const version = connector.kind === "socks4" ? 4 : 5;

    await this.connectVia(
      client,
      ver,
      residual,
      scope,
      `[socks] tunnel via socks upstream ${host}:${port} (socks${ver}->socks${version})`,
      (e) => `[socks] socks upstream error ${host}:${port}: ${e.message}`,
      () => this.openVia(connector, client, { host, port }, scope),
    );
  }

  /**
   * 拨号闭包形态：经连接器打开一条到 `dest` 的字节管道
   *
   * @description
   * SOCKS 语境的两条硬约束在此收口：
   * - 守卫前缀恒为 `"socks"`（与既有 `socksUpstreamGuard("socks", …)` 一致）；连接器内部一律走
   *   `socksUpstreamGuard`（空回复 + `keepClientOnFailure`）——只做超时/错误时的上游销毁，
   *   不写 HTTP 报文（SOCKS 语境会被 502/504 污染），客户端留给各 catch 回 SOCKS 失败应答；
   * - `onEvent` 原样走本会话的事件槽：拨号守卫事件（`HelperEvent`）历史上就没有 user 维度，
   *   现在与 channel 侧事件共用同一个 `scope.emit`，身份（`socks` / `upstream-refused` /
   *   `upstream-error` / preDial / 上游自环五处）由 `RequestScope` 一次性带上，两者不混。
   * @param scope - 本会话的作用域（事件出口 + 身份维度）
   */
  private openVia(
    connector: UpstreamConnector,
    client: Duplex,
    dest: { host: string; port: number },
    scope: RequestScope,
  ): Promise<OpenedUpstream> {
    return connector.open({
      client,
      dest,
      onEvent: scope.emit,
      logPrefix: "socks",
    });
  }

  /**
   * direct / http 上游 / socks 上游三分支共用的建隧模板：
   * 拨号 → 回成功应答 → emit 建隧成功 → establish 桥接；拨号失败 emit upstream-error 后回失败应答
   * （成功/失败日志文案随分支传入，逐字保持原样）
   * @param client - 客户端双工流
   * @param ver - 入站 SOCKS 版本（决定成功与失败应答字节）
   * @param residual - 客户端流水线余量（建隧时回灌上游）
   * @param scope - 本会话的作用域（事件出口 + 已鉴权 `user` + 终态守卫）
   * @param successMessage - 建隧成功日志文案
   * @param failMessage - 拨号异常 → upstream-error 日志文案
   * @param dial - 拨号闭包；经连接器打开一条字节管道，返回 null 表示已在闭包内自行收尾
   *   （http 上游非 200，即 `OpenedUpstream.refusal`），不再走成功/失败模板
   */
  private async connectVia(
    client: Duplex,
    ver: 4 | 5,
    residual: Buffer | undefined,
    scope: RequestScope,
    successMessage: string,
    failMessage: (e: Error) => string,
    dial: () => Promise<OpenedUpstream | null>,
  ): Promise<void> {
    try {
      const dialed = await dial();

      if (!dialed) {
        return;
      }

      // 计量开在回成功应答**之前**：余量（`residual`）与上游先发字节（`rest`）都要计入，
      // 而 `replySuccess` 是协议字节、不计量。耗尽即双端 destroy（应答已发出，改不了）。
      const meter = this.openTunnelMeter(client, dialed.sock, scope);

      this.replySuccess(client, ver);
      scope.terminal.complete();
      scope.emit({ type: "socks", message: successMessage });
      this.establish(client, dialed.sock, meter, residual, dialed.rest);
    } catch (e) {
      scope.emit({ type: "upstream-error", message: failMessage(e as Error) });
      this.replyFail(client, ver);
      scope.terminal.fail(e, "dial");
    }
  }

  /**
   * 建隧收尾：回灌客户端流水线余量与上游头部后字节，再双向桥接
   * @description 二进制 replySuccess 留在调用方（`connectVia`），此处只是基类 `bridgeWithBuffered`
   * 的转发。`residual`（客户端流水线余量）计 `up`、`upstreamHead`（上游先发字节）计 `down`——
   * 两者都是建隧后的**真实载荷**，握手与应答本身不计量。
   */
  private establish(
    client: Duplex,
    upstream: Duplex,
    meter: BufferedCharge,
    residual?: Buffer,
    upstreamHead?: Buffer,
  ): void {
    this.bridgeWithBuffered(client, upstream, meter, residual, upstreamHead);
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
