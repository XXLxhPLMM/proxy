/**
 * @fileoverview 直连连接器（`upstreamKind = "direct"`）
 * @module core/forward/upstream/connector/direct
 * @description
 * 「怎么到达 dest」的最平凡形态：明文 `net.connect` 直拨真实目标，不经任何中间代理。
 *
 * **刻意不提供 TLS**：现有直连路径（`tunnel.direct`、`http.forwardViaRequest` 在 server
 * 模式下把 `secure` 硬编码为 `false`、`socks.connect` 的直连分支、`websocket.viaSocks`
 * 的路由名单回落分支）**全部走明文**。直连的 TLS 由**入站**侧的 `https`/`sockss*` 协议
 * 承担（那是客户端↔本代理的 TLS），不是本连接器的事。别在这里「顺手」加 TLS。
 *
 * 正确性对照（与现有行为逐条一致）：
 * | targetForm | upstreamAuthHeader | selfLoopTarget | transport | peerTarget |
 * |---|---|---|---|---|
 * | `origin`（直达源站） | `undefined` | `undefined`（没有上游地址可成环） | = `open().sock` | `dest` |
 *
 * 依赖方向：`connector/direct → forward/dial`（单向；反向禁止）。
 */

import { ContextualBase } from "@/core/context.js";
import type { CoreContext } from "@/core/context.js";
import { socksUpstreamGuard } from "@/core/guard.js";
import type { Duplex } from "node:stream";
import { Dialer } from "../dial.js";
import type { OpenContext, OpenedUpstream, UpstreamConnector } from "./types.js";

/** 无上游先发字节时的共享空缓冲（不可变，调用方只读） */
const NO_REST = Buffer.alloc(0);

/**
 * 直连连接器：明文直拨 `dest`
 *
 * @description
 * 无状态：每次 `open()` 现读配置（`upstreamTimeout` 等走 `Dialer` 内的 `this.config`），
 * 连接器自身不缓存任何请求间会变的值，故可安全地被 `ConnectorSource` 记忆成单例复用。
 * **本形态没有协议实现**（不与任何代理对话），故不像 socks4/socks5/http-connect 那样
 * 带一个「握手体」；`open()` 直接由传输层建链原语组成。
 */
export class DirectConnector extends ContextualBase implements UpstreamConnector {
  /** 逻辑协议身份：直连 */
  readonly kind = "direct";

  /** 直达源站 → origin-form（与 `http.forwardViaRequest` 的 server 模式分支一致） */
  readonly targetForm = "origin" as const;

  /** 共享拨号器（与 {@link ContextualBase} 读同一份上下文；无请求间状态） */
  private readonly dialer: Dialer;

  /**
   * @param ctx - 依赖上下文，必须显式注入
   */
  constructor(ctx: CoreContext) {
    super(ctx);
    this.dialer = new Dialer(ctx);
  }

  /**
   * 明文直拨 `dest`
   *
   * @description
   * **本形态没有协议级协商可做**——直连不与任何中间代理对话，因此这里**就是**完整实现：
   * 建链由传输层原语 `dialer.dialDirect(client, host, port, guard)` 承担，拨完之后
   * 直接交字节管道，中间没有任何握手状态机（这也是它不需要 `connector/<协议>.ts` 那种
   * 「实现住在协议文件里」的原因：直连没有协议）。
   *
   * 守卫选项由 `socksUpstreamGuard(logPrefix, onEvent, clientLifetime)` + `target` 拼成，
   * 逐字复刻 `tunnel.direct` 既有写法（空回复 + 保客户端，成败应答归 channel 的 catch）。
   * `clientLifetime` 原样透传：`open()` 兼作 `transport()`（本连接器的传输层就是明文管道），
   * 两种用途的差别只有 channel 知道，故由 channel 申报、这里不推断。
   * `rest` 恒空（明文直连没有「应答头之后还有余量」这回事），无 `refusal`。
   */
  async open(ctx: OpenContext): Promise<OpenedUpstream> {
    const { host, port } = ctx.dest;

    const sock = await this.dialer.dialDirect(ctx.client, host, port, {
      ...socksUpstreamGuard(ctx.logPrefix, ctx.onEvent, ctx.clientLifetime),
      target: `${host}:${port}`,
    });

    return { sock, rest: NO_REST };
  }

  /**
   * 与 {@link open} 同源：直连没有「协议级协商」可省，返回的就是同一条明文管道
   *
   * @description `open()` 的契约保证 `rest` 恒空（明文直连没有「应答头之后还有余量」这回事），
   * 故 `transport()` 只取 `sock` 即为完整等价；不存在「丢弃了先发字节」的问题。
   */
  async transport(ctx: OpenContext): Promise<Duplex> {
    return (await this.open(ctx)).sock;
  }

  /**
   * 传输对端 = 目标地址（直连没有中间代理，拨的就是 dest 本身）
   *
   * @param dest - 本次请求的真实目标，原样返回
   */
  peerTarget(dest: OpenContext["dest"]): { host: string; port: number } {
    return { host: dest.host, port: dest.port };
  }

  /** 直连不带上游凭证（没有中间代理） */
  upstreamAuthHeader(): undefined {
    return undefined;
  }

  /** 直连没有上游地址，故无上游自环可判（真实目标的自环由 channel 的 `preDial` 判） */
  selfLoopTarget(): undefined {
    return undefined;
  }
}
