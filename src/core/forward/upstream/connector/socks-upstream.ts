/**
 * @fileoverview SOCKS 上游连接器的共享基类（socks4 / socks5 的唯一公共面）
 * @module core/forward/upstream/connector/socks-upstream
 * @description
 * 「怎么到达 dest」的代理形态之二/之三（`socks4.ts` / `socks5.ts`）在**协议之外**完全同形：
 * 拨上游 `upstreamHost:upstreamPort` → 版本握手 → 隧道直达真实目标。公共的部分因此收在
 * 本基类，两版连接器各自只提供那段**协议实现**（`handshake`）：
 *
 * - `open()`：白名单校验目标 → 拨上游（`Dialer.choose`）→ 跑 `handshake` → 以已建链 socket 决议
 *   （即搬迁前 `Dialer.withUpstreamDial` 的那层外壳，**唯一一份**，不许两版各抄一遍）
 * - `readReply()`：**握手应答的定长读取器**（2c 从 `Dialer` 搬来）——它只认「给我 n 字节」，
 *   但两条报错文案必然带 SOCKS 字样且会进落盘日志，故归 SOCKS 基类而非传输层，
 *   这样「`Dialer` 不知道任何上游协议」才**零例外**成立（详见该方法注释）
 * - `transport()` / `peerTarget()` / `upstreamAuthHeader()` / `selfLoopTarget()`：
 *   两个 SOCKS 连接器这四个成员**逐字相同**（SOCKS 隧道直达源站 → `origin`、
 *   凭证走握手而非 HTTP 头 → `undefined`、传输对端就是 `dest`、上游地址即自环判据），
 *   重复声明就是「同一事实有两个来源」的种子
 *
 * **最容易搞错的一点**（`socks4.ts` / `socks5.ts` 的对照表也重申一次）：
 * 「经 SOCKS 上游」**不等于**「对端是代理」——它对**源站**说话，凭证在 SOCKS 握手里，
 * 出站 HTTP 报文必须用 origin-form 且绝不能带上 `Proxy-Authorization`。
 * 这也是 `targetForm` 恒为 `"origin"` 的唯一理由，与 `http-connect.ts` 的 `"absolute"` 相对。
 *
 * **版本与 TLS 承载都是构造期常量**（`kind` 由子类声明、`secure` 由 registry 传入），
 * 两者都**不**按 `upstreamProtocol` 推导——推导会让「用哪个连接器」的身份取决于当前配置，
 * 那正是本层要消灭的第二真相源。
 *
 * 依赖方向：`connector/socks-upstream → forward/dial`（单向；反向禁止）。
 */

import { ContextualBase } from "@/core/context.js";
import type { CoreContext } from "@/core/context.js";
import { socksUpstreamGuard } from "@/core/guard.js";
import type { Duplex } from "node:stream";
import { isValidTargetHost } from "@/core/helpers/index.js";
import { Dialer } from "../dial.js";
import type { OpenContext, OpenedUpstream, UpstreamConnector } from "./types.js";

/** 无上游先发字节时的共享空缓冲（不可变，调用方只读） */
const NO_REST = Buffer.alloc(0);

/**
 * SOCKS 上游连接器基类：两版共用的拨号外壳与声明式数据
 *
 * @description
 * 无状态：每次 `open()` 现读配置（上游地址/端口/凭证/超时），连接器自身不缓存任何
 * 请求间会变的值，故可安全地在 registry 里缓存单例。
 */
export abstract class SocksUpstreamConnector extends ContextualBase implements UpstreamConnector {
  /** 逻辑协议身份：TLS 承载不参与（`sockss4`/`sockss5` 的 kind 即 `socks4`/`socks5`） */
  abstract readonly kind: "socks4" | "socks5";

  /** SOCKS 隧道直达源站 → origin-form（与 `http.forwardViaSocks` / `buildUpgradeReq` 一致） */
  readonly targetForm = "origin" as const;

  /** 上游是否 TLS 承载（`sockss4`/`sockss5` 传 true，`socks4`/`socks5` 传 false） */
  protected readonly secure: boolean;

  /** 共享拨号器（无请求间状态；握手体经它读应答字节） */
  protected readonly dialer: Dialer;

  /**
   * @param ctx - 依赖上下文，必须显式注入
   * @param secure - 上游是否 TLS 承载（传输细节，不进 `kind`）
   */
  constructor(ctx: CoreContext, secure: boolean) {
    super(ctx);
    this.secure = secure;
    this.dialer = new Dialer(ctx);
  }

  /**
   * 经 SOCKS 上游拨到 `ctx.dest`
   *
   * @description
   * 拨号失败 / 握手失败 / 沉默上游超时一律 **reject**（不吞），且**绝不向 `ctx.client`
   * 写任何字节**——成败应答的协议形态归 channel。
   *
   * 守卫与日志路由：
   * - 守卫选项 `socksUpstreamGuard(logPrefix, onEvent, clientLifetime)` + `target`，
   *   `target` 取自 `tunnel.viaSocks` 的全量形式
   *   `"<host>:<port> via <kind> <upstreamHost>:<upstreamPort>"`（另三处既有调用点不传
   *   `target`，统一给出只会让日志多出目标信息，路由文本自此是锁死的契约）。
   * - `clientLifetime` 原样透传：`open()` 兼作 `transport()`（本层传输层就是隧道本身），
   *   两种用途的差别只有 channel 知道，故由 channel 申报、这里不推断。
   * - `rest` 恒空（`readReply` 精确消费应答，SOCKS 应答之后不产余量），无 `refusal`。
   */
  async open(ctx: OpenContext): Promise<OpenedUpstream> {
    const target = ctx.dest;
    const sock = await this.dialViaSocks(ctx, (s) => this.handshake(s, target));

    return { sock, rest: NO_REST };
  }

  /**
   * SOCKS 握手外壳（搬迁前 `Dialer.withUpstreamDial`）：白名单校验目标主机 → 拨上游 → 执行握手体
   *
   * @description
   * 拨号失败与握手体抛错统一 reject；握手体自行销毁已建链的上游（两版语义与抽壳前逐字一致）。
   * @param ctx - 打开上下文（`dest` 目标、`client` 供守卫取地址、`onEvent`/`logPrefix`/`clientLifetime` 透传守卫）
   * @param handshake - 握手体：向已建链的上游发请求并等应答，失败 throw
   * @returns 已完成二次握手的上游 socket
   */
  protected dialViaSocks(
    ctx: OpenContext,
    handshake: (sock: Duplex) => Promise<void>,
  ): Promise<Duplex> {
    const { host, port } = ctx.dest;
    const upstreamHost = this.config.get("upstreamHost");
    const upstreamPort = this.config.get("upstreamPort");
    const upstream = `${upstreamHost}:${upstreamPort}`;

    return new Promise((resolve, reject) => {
      // 目标主机进握手报文前先过白名单（防 CRLF 注入与长度域截断）
      if (!isValidTargetHost(host)) {
        reject(new Error("invalid target host"));
        return;
      }

      this.dialer
        .choose(ctx.client, upstreamHost, upstreamPort, this.secure, {
          ...socksUpstreamGuard(ctx.logPrefix, ctx.onEvent, ctx.clientLifetime),
          target: `${host}:${port} via ${this.kind} ${upstream}`,
        })
        .then((sock) => {
          handshake(sock).then(() => resolve(sock), reject);
        })
        .catch(reject);
    });
  }

  /**
   * 版本握手体（子类唯一必须实现的东西）：向已建链的上游发本版本的 CONNECT 并等成功应答
   *
   * @param sock - 已建链的上游（TLS 已握手、拨号守卫已 `established()`）
   * @param target - 真实目标三元组（`host` 已由 {@link dialViaSocks} 过白名单）
   * @throws 握手失败（**必须自行销毁 `sock`**：外壳不代劳，这是「失败即断链」的既有语义）
   */
  protected abstract handshake(sock: Duplex, target: OpenContext["dest"]): Promise<void>;

  /**
   * 读取上游应答（跨 TCP 分段累积，精确消费 n 字节）——**只有 SOCKS 握手用它**（2c 起从 `Dialer` 搬来）
   *
   * @description
   * 字节级原语，只认「给我 n 字节」、不解释这些字节是什么协议的什么字段——但**它的报错文案
   * 必然带 SOCKS 字样**（下面两条），而文案会经 channel 的 catch 进入**落盘日志**。
   * 这正是它住在本基类而不是传输层的理由：**「通用读取器」与「协议文案」无法分离**
   * ——留在 `Dialer` 就等于让「`Dialer` 不知道任何上游协议」这条不变量永远带一个例外
   * （上轮的两条报错文案就是那个例外）。只有 SOCKS 握手在用它，故归 SOCKS 连接器基类，
   * 不变量因此**零例外**成立。**文案逐字不动**：改文案即改日志文本。
   *
   * - 上游应答可能被拆成多个 data 包：单个 `once("data")` 会把合法上游误判为失败
   * - 用「暂停 + `read(n)`」精确取走 n 字节：应答之后的余量（可能已带 server-speaks-first 目标首包）
   *   留在 socket 内部缓冲，交后续 bridge / http.request 原样读取——既不丢也不多读
   *   （不采用先 data 事件再 unshift 回灌：在 data 回调内回灌的字节不会可靠地再次触发读取）
   * - 沉默上游兜底：TCP 建链成功后拨号超时已让出，握手读取自行按 `upstreamTimeout` 兜底
   *
   * @param sock - 上游连接
   * @param n - 期望字节数
   * @returns 恰好 n 字节的应答
   * @throws 读取超时 / 对端提前关闭 / socket 错误
   */
  protected readReply(sock: Duplex, n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let acc = Buffer.alloc(0);

      const cleanup = (): void => {
        clearTimeout(timer);
        sock.off("readable", onReadable);
        sock.off("close", onClose);
        sock.off("error", onError);
      };

      const onReadable = (): void => {
        const chunk = sock.read(n - acc.length) as Buffer | null;

        if (chunk === null) {
          return;
        }

        acc = Buffer.concat([acc, chunk]);

        if (acc.length < n) {
          return;
        }

        cleanup();
        resolve(acc);
      };

      const onClose = (): void => {
        cleanup();
        reject(new Error("socks upstream closed before reply"));
      };

      const onError = (e: Error): void => {
        cleanup();
        reject(e);
      };

      // 沉默上游兜底：TCP 建链成功后拨号超时已让出，握手读取自行按 upstreamTimeout 兜底
      const timer = setTimeout(
        () => {
          cleanup();
          sock.destroy();
          reject(new Error("socks reply timeout"));
        },
        this.config.get("upstreamTimeout") as number,
      );

      // 暂停而非挂 data 监听：数据进内部缓冲，按需 read(n) 精确消费
      sock.pause();
      sock.on("readable", onReadable);
      sock.once("close", onClose);
      sock.once("error", onError);
    });
  }

  /**
   * 与 {@link open} 等价：SOCKS 隧道**直达 dest**，传输层就是隧道本身
   *
   * @description `open()` 的契约保证 `rest` 恒空（`readReply` 精确消费应答，
   * SOCKS 应答之后不产余量），故取 `sock` 即为完整等价。
   */
  async transport(ctx: OpenContext): Promise<Duplex> {
    return (await this.open(ctx)).sock;
  }

  /**
   * 传输对端 = 目标地址（SOCKS 隧道**直达源站**，不是上游代理）
   *
   * @param dest - 本次请求的真实目标，原样返回
   */
  peerTarget(dest: OpenContext["dest"]): { host: string; port: number } {
    return { host: dest.host, port: dest.port };
  }

  /** SOCKS 上游不注入 HTTP 凭证头（凭证走握手：SOCKS4 的 USERID / SOCKS5 的 RFC1929 子协商） */
  upstreamAuthHeader(): undefined {
    return undefined;
  }

  /** 上游地址（client 模式下拨的是上游，上游指回自身监听地址会成环） */
  selfLoopTarget(): { host: string; port: number } {
    return { host: this.config.get("upstreamHost"), port: this.config.get("upstreamPort") };
  }
}
