/**
 * @fileoverview HTTP/HTTPS 上游 CONNECT 连接器
 * @module core/forward/upstream/connector/http-connect
 * @description
 * 「怎么到达 dest」的代理形态之一：拨上游 `upstreamHost:upstreamPort` → 发
 * `CONNECT dest HTTP/1.1` → 等状态行。覆盖 `upstreamProtocol` 的 `http`（明文承载）
 * 与 `https`（TLS 承载）两种取值——**TLS 承载是传输细节**（构造参数 `secure`），
 * 逻辑 kind 仍分别是 `http` / `https`。
 *
 * 正确性对照（与现有行为逐条一致）：
 * | targetForm | upstreamAuthHeader | selfLoopTarget | transport | peerTarget |
 * |---|---|---|---|---|
 * | `absolute`（对端是代理，它需要完整 URL 才能转发） | 有配 `upstreamUsername` 则返回值，否则 `undefined` | `upstreamHost:upstreamPort` | 只拨号到上游（不 CONNECT） | = `selfLoopTarget()` |
 *
 * **CONNECT 协议实现住在本文件**（{@link HttpConnectConnector.connectViaUpstream}，
 * 即搬迁前的 `Dialer.dialViaHttpUpstream`）：拨号守卫走 `keepClientOnFailure` + 空回复，
 * **绝不向 `ctx.client` 写任何字节**，成败应答归 channel。
 *
 * **职责边界**：本类**只如实报告上游是否拒绝建链**。非 200 应答的具体处置留在 channel——
 * `tunnel.openUpstream` 是「原样透传 `head`+`rest` 给客户端再销毁上游」，
 * `socks.connect` 是「发 `upstream-refused` 事件 + 回 SOCKS 失败应答再销毁上游」，
 * 协议形态不同（见 `src/core/AGENTS.md`「刻意不收的」）。本切片一行 channel 代码都不改。
 *
 * 依赖方向：`connector/http-connect → forward/dial`（单向；反向禁止）。
 */

import { ContextualBase } from "@/core/context.js";
import type { CoreContext } from "@/core/context.js";
import { awaitStatusLine, createHelperEmitter, socksUpstreamGuard } from "@/core/guard.js";
import type { Duplex } from "node:stream";
import { buildConnectRequest, upstreamAuthHeaderLine, upstreamAuthValue } from "@/core/helpers/index.js";
import { getSocketAddress } from "@/utils/ip.js";
import { STATUS_OK } from "@/utils/constants/index.js";
import { Dialer, DialTimeoutError } from "../dial.js";
import type { OpenContext, OpenedUpstream, UpstreamConnector } from "./types.js";

/**
 * HTTP/HTTPS 上游 CONNECT 连接器
 *
 * @description
 * 无状态：每次 `open()` 现读配置（上游地址/端口/凭证/超时），连接器自身不缓存任何
 * 请求间会变的值，故可安全地被 `ConnectorSource` 记忆成单例复用。
 */
export class HttpConnectConnector extends ContextualBase implements UpstreamConnector {
  /** 逻辑协议身份：TLS 承载不参与，`https` 即 `https` */
  readonly kind: "http" | "https";

  /** 对端是代理 → absolute-form（`http.forwardViaRequest` 的 client 分支 / `buildUpgradeReq` 的 `toUpstreamProxy`） */
  readonly targetForm = "absolute" as const;

  /** 上游是否 TLS 承载（传输细节，不进 `kind`） */
  private readonly secure: boolean;

  /** 共享拨号器（无请求间状态） */
  private readonly dialer: Dialer;

  /**
   * @param ctx - 依赖上下文，必须显式注入
   * @param secure - 上游是否 TLS 承载（`https` 上游传 true，`http` 上游传 false）；`kind` 由它推导
   */
  constructor(ctx: CoreContext, secure: boolean) {
    super(ctx);
    this.secure = secure;
    this.kind = secure ? "https" : "http";
    this.dialer = new Dialer(ctx);
  }

  /**
   * 拨上游 → 发 CONNECT → 等状态行，把结果映射成 {@link OpenedUpstream}
   *
   * @description
   * - `target`（日志路由 + CONNECT 请求行之外的失败文案）逐字取自 `tunnel.viaHttp` 与
   *   `socks.connect` 两个既有调用点（两处完全一致：
   *   `` `${host}:${port} via ${upstreamHost}:${upstreamPort}` ``），守卫与等状态行超时的
   *   日志路由文本因此逐字不变；
   * - 映射规则：非 200 → 放 `refusal` 且 **`sock` 照常返回**（销毁与否是 channel 的决定）；
   *   成功 → 只回 `sock` + `rest`，`refusal` 不出现；
   * - 等状态行的超时以 `upstreamTimeout` 兜底（拨号守卫在建链时已让出超时职责），
   *   累积/封顶/状态行提取由 `awaitStatusLine` 承担。
   */
  async open(ctx: OpenContext): Promise<OpenedUpstream> {
    const { host, port } = ctx.dest;
    const upstream = `${this.config.get("upstreamHost")}:${this.config.get("upstreamPort")}`;
    const target = `${host}:${port} via ${upstream}`;

    const { sock, statusCode, head, rest } = await this.connectViaUpstream(ctx, host, port, target);

    if (statusCode !== String(STATUS_OK)) {
      return { sock, rest, refusal: { statusCode, head, rest } };
    }

    return { sock, rest };
  }

  /**
   * 经 HTTP/HTTPS 上游建 CONNECT 隧道：拨号 → 发 CONNECT → 等状态行，一段收口
   *
   * @description
   * - **绝不向客户端写任何字节**：成败应答归调用方（tunnel 回 200 / 原样透传响应，
   *   socks 回成功/失败应答）；
   * - 拨号守卫走 `keepClientOnFailure` + 空回复：拨号失败只销毁上游，客户端留给调用方 catch 收尾；
   * - 等状态行以 `upstreamTimeout` 兜底——拨号守卫在建链时已让出超时职责；
   *   超时/超限经 `onEvent` 上抛成因，随后销毁上游并抛错。
   *
   * @param ctx - 打开上下文（`client` 仅供守卫联动取地址，本方法不向它写入；
   *   `onEvent`/`logPrefix`/`clientLifetime` 透传守卫与等状态行事件）
   * @param host - 目标主机（拼进 CONNECT 请求行）
   * @param port - 目标端口
   * @param target - 日志路由字符串（如 "example.com:443 via 127.0.0.1:8080"）
   * @returns 已建链的上游 socket 与状态行解析结果（`statusCode`/`head`/`rest`）
   * @throws 拨号失败 / 等状态行超时或超限（超时为 {@link DialTimeoutError}，供调用方回 504；
   *   此时上游已销毁，客户端应答归调用方）
   */
  private async connectViaUpstream(
    ctx: OpenContext,
    host: string,
    port: number,
    target: string,
  ): Promise<{ sock: Duplex; statusCode: string; head: Buffer; rest: Buffer }> {
    const prefix = ctx.logPrefix;
    const emitEvent = createHelperEmitter(ctx.onEvent);
    const route = `${getSocketAddress(ctx.client)} -> ${target}`;

    const sock = await this.dialer.choose(
      ctx.client,
      this.config.get("upstreamHost"),
      this.config.get("upstreamPort"),
      this.secure,
      {
        ...socksUpstreamGuard(prefix, ctx.onEvent, ctx.clientLifetime),
        target,
      },
    );

    sock.write(buildConnectRequest(host, port, upstreamAuthHeaderLine(this.config)));

    // 拨号守卫建链后已让出超时职责：等状态行按 upstreamTimeout 兜底，
    // 累积/封顶/状态行提取由 awaitStatusLine（包装 readResponseHead）承担，
    // 超时/超限经事件上抛后归入下方 throw；失败时上游由 awaitStatusLine 统一销毁
    const res = await awaitStatusLine(sock, {
      timeout: this.config.get("upstreamTimeout") as number,
      onTimeout: () => {
        emitEvent({
          type: "upstream-timeout",
          message: `[${prefix}] CONNECT response timeout ${route}`,
        });
      },
      onOverflow: () => {
        emitEvent({
          type: "upstream-error",
          message: `[${prefix}] CONNECT response overflow ${route}`,
        });
      },
    });

    if (!res.ok) {
      // 超时/超限（成因已上抛、上游已销毁）：抛错，客户端应答归调用方
      // 超时标记为 DialTimeoutError（HTTP 调用方回 504），超限属坏网关回 502
      throw res.cause === "timeout"
        ? new DialTimeoutError(`CONNECT response timeout ${target}`)
        : new Error(`CONNECT response ${res.cause} ${target}`);
    }

    return { sock, statusCode: res.statusCode, head: res.head, rest: res.rest };
  }

  /**
   * 只拨号到上游，**不发 CONNECT、不等状态行**
   *
   * @description
   * 供 `http.ts` 的单一路径经 `http.request({ createConnection })` 使用：
   * 普通 HTTP 请求走 http(s) 上游时**不建隧道**——Node 自己把 absolute-form 请求行
   * 写在这条连接上（上游代理据此转发），所以这里**必须**停在「传输层已建立」这一步，
   * 一旦多发一个 CONNECT 就会把上游代理的协议状态机带偏（它会先回 200 再等 CONNECT，
   * 而 Node 已经在等 HTTP 响应 → 死锁）。
   *
   * 这条路径**没有协议级实现**可言，故直接用传输层原语 `dialer.choose`：
   * - `secure` 传构造参数（`kind` 的同一个来源），**不**让 `choose` 按 `upstreamProtocol` 推导；
   * - 守卫选项与 `open()` 同形（`socksUpstreamGuard(prefix, onEvent, clientLifetime)` + `target`），
   *   `target` 也用 `"<dest> via <upstream>"` 全量形式，故两条路径的守卫 route 文本逐字同源；
   * - TLS 三选项（servername/rejectUnauthorized/ca）由 `dialTls` 内的 `upstreamTlsOptions` 承担，
   *   锚点就是 `upstreamHost`（建链目标）——**`http.ts` 侧因此不再注入任何 TLS 选项**。
   */
  async transport(ctx: OpenContext): Promise<Duplex> {
    const upstream = `${this.config.get("upstreamHost")}:${this.config.get("upstreamPort")}`;

    return this.dialer.choose(
      ctx.client,
      this.config.get("upstreamHost"),
      this.config.get("upstreamPort"),
      this.secure,
      {
        ...socksUpstreamGuard(ctx.logPrefix, ctx.onEvent, ctx.clientLifetime),
        target: `${ctx.dest.host}:${ctx.dest.port} via ${upstream}`,
      },
    );
  }

  /**
   * 传输对端 = 上游地址（对端是代理本身：`http.request` 的报文直接写给它）
   *
   * @description 与 {@link selfLoopTarget} 同一事实、同一读法（配置里的上游地址），
   * 故直接委托，不另抄一份 `config.get`——那会造出「两个都自称上游地址」的成员。
   *
   * **这里刻意不声明 `dest` 形参**（端口签名是 `peerTarget(dest)`，TS 允许实现收窄）：
   * 本连接器的对端与本次请求的目标无关，多一个用不到的形参只会诱使人去 `void` 它。
   * 调用方拿到的永远是端口类型 `UpstreamConnector`（`ConnectorSource.upstream()` 的返回类型），
   * 按端口传 `dest` 即可。**这不是签名不一致**（见 `types.ts` 裁决 4）。
   */
  peerTarget(): { host: string; port: number } {
    return this.selfLoopTarget();
  }

  /**
   * 上游 Basic 凭证头**值**（`Basic <base64>`）
   *
   * @description
   * 返回值形态而非 `Proxy-Authorization: Basic ...` 整行：出站请求层
   * （`http.forwardViaRequest` 的 `headers["proxy-authorization"] = …` 与
   * `buildUpgradeReq` 的头行拼装）两处既有调用点消费的都是**值**（`upstreamAuthValue`），
   * 头行形态（`upstreamAuthHeaderLine`）只服务于 `buildConnectRequest`，
   * 那条路在 `open()` 内部（{@link connectViaUpstream} 自己拼），不经本方法。
   * 仅显式配置 `upstreamUsername` 时携带，未配置返回 `undefined`。
   */
  upstreamAuthHeader(): string | undefined {
    return upstreamAuthValue(this.config);
  }

  /** 上游地址（client 模式下拨的是上游，上游指回自身监听地址会成环） */
  selfLoopTarget(): { host: string; port: number } {
    return { host: this.config.get("upstreamHost"), port: this.config.get("upstreamPort") };
  }
}
