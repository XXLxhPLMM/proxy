import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { ContextualBase } from "@/core/context.js";
import type { CoreContext } from "@/core/context.js";
import { upstreamTlsOptions } from "@/utils/tls/index.js";
import { guardDialing, type DialGuardOptions } from "@/core/guard.js";

/**
 * @fileoverview 传输层拨号器：建链 + 桥接
 * @module core/forward/upstream/dial
 * @description
 * 本文件是**传输层**：把一条 TCP/TLS 连接建起来、把两条流桥起来。
 *
 * **硬不变量（零例外）**：**本文件不知道任何上游协议**——不认 SOCKS、不认 CONNECT、不拼任何
 * 协议报文，**连报错文案里都不许出现协议词汇**。协议词汇连注释里都不许出现，所以哪怕是
 * 「字节级原语但文案带协议字样」的 `readReply` 也住在 `connector/socks-upstream.ts`。
 * 本文件零协议常量、零「按协议拨号」入口。防职责回流的负向断言在
 * `tests/unit/dialer-protocol-boundary.test.ts`（锁 `Dialer.prototype`
 * 方法闭集 + **去注释后的源码文本不含协议词汇**）。
 *
 * 两块职责：① **建链**（`dialDirect` / `dialTls` / `choose` + 私有 `dialWith`）——只负责「连上」，
 * 连上之后的对端协议协商不归这里；② **桥接**（{@link Dialer.bridge}）——稳态双向 pipe，管道已经
 * 建好、只差把两端接起来。
 *
 * 依赖方向：`connector/* → forward/upstream/dial`（单向；反向禁止）。
 */

/**
 * 拨号/等上游应答超时错误
 *
 * @description
 * 守卫不再替调用方写应答（`keepClientOnFailure` + 空回复）后，超时与连接错误
 * 都以 reject 形态进调用方 catch——用本类标记超时成因，让 HTTP 调用方能区分
 * 「回 504 Gateway Timeout」还是「回 502 Bad Gateway」（SOCKS/Upgrade 忽略该区分）。
 * 由连接器抛出时同样经 `open()` 透传（`open()` 只如实报告失败、不吞）。
 * @example e instanceof DialTimeoutError // => true（拨号超时 / 等应答超时）
 */
export class DialTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DialTimeoutError";
  }
}

/**
 * 传输层拨号器
 * - 统一 net/tls 建链与拨号守卫（`dialDirect` / `dialTls` / `choose`）
 * - 建链之后的稳态桥接（`bridge`）
 * - **不含任何上游协议实现**（见文件头「硬不变量」：SOCKS 4/5 握手、握手应答读取器
 *   `readReply`、HTTP CONNECT 上游对接分别住在 `forward/upstream/connector/socks4.ts` /
 *   `socks5.ts` / `http-connect.ts`）
 * - 配置访问器经 {@link ContextualBase} 的 `config` getter 取用（本类不自有字段）
 */
export class Dialer extends ContextualBase {
  /**
   * @param ctx - 依赖上下文，必须显式注入；上游地址/端口/协议/凭证/超时都经 `ctx.config` 读取
   */
  constructor(ctx: CoreContext) {
    super(ctx);
  }

  /**
   * 稳态桥接：双向 pipe；仅监听 upstream 错误即双关，client 侧由上层 close 守卫接管（非双监听的分工）
   *
   * @description
   * **它不是「拨号」**（不建立任何连接、不读任何配置），而是「把已经建好的两条流接起来」——
   * 管道形态的最后一棒，故与建链同住传输层；调用点只有转发器两处，两条都是**稳态**
   * （拿到 socket 即桥接），故本方法不涉及任何协议协商。
   * 为何仍住传输层：它与建链同属「纯传输」，且无请求态。
   */
  bridge(client: Duplex, upstream: Duplex): void {
    upstream.pipe(client);
    client.pipe(upstream);

    upstream.on("error", () => {
      if (!client.destroyed) {
        client.destroy();
      }

      if (!upstream.destroyed) {
        upstream.destroy();
      }
    });
  }

  /**
   * 直拨：明文 net.connect，超时/错误由 guard 统一接管
   *
   * @description `guard` **必填**（历史遗留的 `opts?` 已删）。四个拨号方法的缺席都会落到
   * `guardDialing` 的缺省档——那份缺省会**向客户端写 502/504 原始 HTTP 报文**且上下游同生命周期，
   * 恰好违反本层「连接器绝不向 `ctx.client` 写任何字节」的硬契约。取舍与断言见
   * `tests/unit/dead-optionality-cleared.test.ts` 的档头注释。
   */
  dialDirect(client: Duplex, host: string, port: number, guard: DialGuardOptions): Promise<Duplex> {
    return this.dialWith(client, host, port, (h, p, cb) => net.connect(p, h, cb), guard);
  }

  /**
   * 加密拨：tls.connect，证书校验锚定建链目标（servername/rejectUnauthorized/ca 三选项收敛在 upstreamTlsOptions）
   *
   * @description `guard` 必填，理由同 {@link dialDirect}。
   */
  dialTls(client: Duplex, host: string, port: number, guard: DialGuardOptions): Promise<Duplex> {
    return this.dialWith(
      client,
      host,
      port,
      (h, p, cb) => {
        const s = tls.connect(
          {
            host: h,
            port: p,
            // IP 按 RFC6066 置空 SNI，按连接 host 校验 SAN-IP（见 upstreamTlsOptions）
            ...upstreamTlsOptions(h, this.config),
          },
          cb,
        );

        return s as unknown as Duplex;
      },
      guard,
    );
  }

  /**
   * 通用拨号：open 回调/error/timeout 三源竞态，settled 只决议一次
   * established 由 open 回调触发（net 的 connect / tls 的 secureConnect），
   * 拨号超时保留到真正建链成功，避免 TLS 握手卡死时超时被提前清除而永不 settle
   *
   * @description 三源收敛成一次竞态（否掉了「每个 `dial*` 各自处理一份」）——三处要等的信号形态不同，
   * 各写一份必然漂。
   * @description `guard` 必填，理由同 {@link dialDirect}：再给一份可选项就是**同一个事实的
   * 第三个入口**。
   */
  private dialWith(
    client: Duplex,
    host: string,
    port: number,
    open: (h: string, p: number, cb: () => void) => Duplex,
    guard: DialGuardOptions,
  ): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      let done = false;

      const settle = (fn: () => void): void => {
        if (done) {
          return;
        }

        done = true;
        fn();
      };

      // 句柄占位：open 回调为异步触发，届时 guardHandle.established 已就绪
      const guardHandle: { established: () => void } = { established: () => {} };

      const upstream = open(host, port, () => {
        // 真正拨号成功才进稳态：TLS 未 secureConnect 前仍受拨号超时保护
        guardHandle.established();

        settle(() => {
          resolve(upstream);
        });
      });

      const dial = guardDialing(client, upstream, {
        timeout: this.config.get("upstreamTimeout"),
        target: `${host}:${port}`,
        ...guard,
        onError: (e) => {
          guard.onError?.(e);

          settle(() => {
            reject(e);
          });
        },
        onTimeout: () => {
          guard.onTimeout?.();

          settle(() => {
            // 超时用可识别类型：调用方 catch 据此回 504（连接错误回 502）
            reject(new DialTimeoutError(`timeout ${host}:${port}`));
          });
        },
      });

      guardHandle.established = dial.established;

      upstream.once("error", (e) => {
        settle(() => {
          reject(e as Error);
        });
      });
    });
  }

  /**
   * 按是否加密自动选 net/tls
   *
   * @description 「这个目标要不要 TLS」是协议事实、连接器是它的唯一持有者，故**不**让调用方传
   * `net`/`tls` 进来（否掉了「让调用方声明协议事实」）。
   * `guard` 必填，理由同 {@link dialDirect}。
   */
  choose(
    client: Duplex,
    host: string,
    port: number,
    secure: boolean,
    guard: DialGuardOptions,
  ): Promise<Duplex> {
    if (secure) {
      return this.dialTls(client, host, port, guard);
    }

    return this.dialDirect(client, host, port, guard);
  }
}
