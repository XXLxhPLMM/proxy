import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import { upstreamTlsOptions } from "@/utils/net/upstream-tls.js";
import { getSocketAddress } from "@/utils/net/socket.js";
import { normalizeIp } from "@/utils/addr/ip.js";
import {
  buildConnectRequest,
  isValidTargetHost,
  isTlsUpstreamProto,
  socksVersionOf,
  upstreamAuthHeaderLine,
} from "@/core/proxy-helpers.js";
import {
  awaitStatusLine,
  createHelperEmitter,
  guardDialing,
  socksUpstreamGuard,
  type DialGuardOptions,
  type HelperEventSink,
} from "@/core/guard.js";
import {
  SOCKS4A_FAKE_IP,
  SOCKS4_NULL,
  SOCKS4_REPLY_BYTES,
  SOCKS4_REPLY_GRANTED,
  SOCKS4_REPLY_VN,
  SOCKS4_VERSION,
  SOCKS5_ATYP_DOMAIN,
  SOCKS5_ATYP_IPV4,
  SOCKS5_ATYP_IPV6,
  SOCKS5_AUTH_VERSION,
  SOCKS5_HANDSHAKE_REQ,
  SOCKS5_METHOD_NO_AUTH,
  SOCKS5_METHOD_REPLY_BYTES,
  SOCKS5_METHOD_USER_PASS,
  SOCKS5_REPLY_HEAD_BYTES,
  SOCKS5_REP_SUCCESS,
  SOCKS5_VERSION,
  SOCKS_CMD_CONNECT,
} from "@/utils/protocol/socks.js";

/**
 * 拨号/等上游应答超时错误
 *
 * @description
 * 守卫不再替调用方写应答（`keepClientOnFailure` + 空回复）后，超时与连接错误
 * 都以 reject 形态进调用方 catch——用本类标记超时成因，让 HTTP 调用方能区分
 * 「回 504 Gateway Timeout」还是「回 502 Bad Gateway」（SOCKS/Upgrade 忽略该区分）。
 * @example e instanceof DialTimeoutError // => true（拨号超时 / CONNECT 状态行超时）
 */
export class DialTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DialTimeoutError";
  }
}

/**
 * 拨号器
 * - 统一 net/tls 建链与守卫
 * - 提供 SOCKS 隧道能力，供任意 client → 任意上游互转
 * - 提供 HTTP/HTTPS 上游 CONNECT 隧道（`dialViaHttpUpstream`），tunnel 与 socks 共用
 */
export class Dialer {
  /**
   * 稳态桥接：双向 pipe；仅监听 upstream 错误即双关，client 侧由上层 close 守卫接管（非双监听的分工）
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
   */
  dialDirect(client: Duplex, host: string, port: number, opts?: DialGuardOptions): Promise<Duplex> {
    return this.dialWith(client, host, port, (h, p, cb) => net.connect(p, h, cb), opts);
  }

  /**
   * 加密拨：tls.connect，证书校验锚定建链目标（servername/rejectUnauthorized/ca 三选项收敛在 upstreamTlsOptions）
   */
  dialTls(client: Duplex, host: string, port: number, opts?: DialGuardOptions): Promise<Duplex> {
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
            ...upstreamTlsOptions(h),
          },
          cb,
        );

        return s as unknown as Duplex;
      },
      opts,
    );
  }

  /**
   * 通用拨号：open 回调/error/timeout 三源竞态，settled 只决议一次
   * established 由 open 回调触发（net 的 connect / tls 的 secureConnect），
   * 拨号超时保留到真正建链成功，避免 TLS 握手卡死时超时被提前清除而永不 settle
   */
  private dialWith(
    client: Duplex,
    host: string,
    port: number,
    open: (h: string, p: number, cb: () => void) => Duplex,
    guard?: DialGuardOptions,
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
        timeout: get("upstreamTimeout"),
        target: `${host}:${port}`,
        ...guard,
        onError: (e) => {
          guard?.onError?.(e);

          settle(() => {
            reject(e);
          });
        },
        onTimeout: () => {
          guard?.onTimeout?.();

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
   */
  choose(
    client: Duplex,
    host: string,
    port: number,
    secure: boolean,
    guard?: DialGuardOptions,
  ): Promise<Duplex> {
    if (secure) {
      return this.dialTls(client, host, port, guard);
    }

    return this.dialDirect(client, host, port, guard);
  }

  /**
   * 经 HTTP/HTTPS 上游建 CONNECT 隧道：拨号 → 发 CONNECT → 等状态行，一段收口
   *
   * @description
   * 收敛 `tunnel.viaHttp` 与 `socks.connect`（http 上游分支）逐字重复的
   * 「choose → buildConnectRequest → readResponseHead」序列：
   * - **绝不向客户端写任何字节**：成败应答归调用方（tunnel 回 200 / 原样透传响应，socks 回成功/失败应答）；
   * - 拨号守卫走 `keepClientOnFailure` + 空回复：拨号失败只销毁上游，客户端留给调用方 catch 收尾；
   * - 等状态行以 `opts.timeout`（缺省 `upstreamTimeout`）自行兜底——拨号守卫在建链时已让出超时职责；
   *   超时/超限经 `onEvent` 上抛成因，随后销毁上游并抛错。
   *
   * @param client - 客户端 Duplex（仅供守卫联动取地址，本方法不向它写入）
   * @param host - 目标主机（拼进 CONNECT 请求行）
   * @param port - 目标端口
   * @param target - 日志路由字符串（如 "example.com:443 via 127.0.0.1:8080"）
   * @param opts - `secure` 上游是否 TLS 承载；`onEvent` 守卫/等待事件汇；`timeout` 等状态行超时；`logPrefix` 日志前缀（缺省 "tunnel"）
   * @returns 已建链的上游 socket 与状态行解析结果（`statusCode`/`head`/`rest`）
   * @throws 拨号失败 / 等状态行超时或超限（超时为 {@link DialTimeoutError}，供调用方回 504；
   *   此时上游已销毁，客户端应答归调用方）
   */
  async dialViaHttpUpstream(
    client: Duplex,
    host: string,
    port: number,
    target: string,
    opts: {
      secure: boolean;
      onEvent?: HelperEventSink;
      timeout?: number;
      logPrefix?: string;
    },
  ): Promise<{ sock: Duplex; statusCode: string; head: Buffer; rest: Buffer }> {
    const prefix = opts.logPrefix ?? "tunnel";
    const emitEvent = createHelperEmitter(opts.onEvent);
    const route = `${getSocketAddress(client)} -> ${target}`;

    const sock = await this.choose(client, get("upstreamHost"), get("upstreamPort"), opts.secure, {
      ...socksUpstreamGuard(prefix, opts.onEvent),
      target,
    });

    sock.write(buildConnectRequest(host, port, upstreamAuthHeaderLine()));

    // 拨号守卫建链后已让出超时职责：等状态行按 timeout 兜底（缺省 upstreamTimeout），
    // 累积/封顶/状态行提取由 awaitStatusLine（包装 readResponseHead）承担，
    // 超时/超限经事件上抛后归入下方 throw；失败时上游由 awaitStatusLine 统一销毁
    const res = await awaitStatusLine(sock, {
      timeout: opts.timeout ?? (get("upstreamTimeout") as number),
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
   * 经由 SOCKS 上游拨到真实目标（供 http→socks / tunnel→socks / socks→socks 串联）
   * version 缺省时按 upstreamProtocol 推导（`socksVersionOf`：socks4/sockss4 → 4，其余 → 5）
   * secure 缺省时按 upstreamProtocol 推导（`isTlsUpstreamProto`：sockss* 走 TLS）
   */
  dialSocks(
    client: Duplex,
    targetHost: string,
    targetPort: number,
    version?: 4 | 5,
    secure?: boolean,
    guard?: DialGuardOptions,
  ): Promise<Duplex> {
    const upstreamHost = get("upstreamHost");
    const upstreamPort = get("upstreamPort");
    const proto = get("upstreamProtocol");

    const ver: 4 | 5 = version ?? socksVersionOf(proto);

    const useTls: boolean = secure ?? isTlsUpstreamProto(proto);

    return this.handshakeSocks(
      client,
      upstreamHost,
      upstreamPort,
      targetHost,
      targetPort,
      ver,
      useTls,
      guard,
    );
  }

  /**
   * SOCKS 握手：版本由调用方或 upstreamProtocol 推导指定
   */
  private handshakeSocks(
    client: Duplex,
    upstreamHost: string,
    upstreamPort: number,
    targetHost: string,
    targetPort: number,
    version: 4 | 5,
    secure: boolean,
    guard?: DialGuardOptions,
  ): Promise<Duplex> {
    if (version === 4) {
      return this.handshakeSocks4(
        client,
        upstreamHost,
        upstreamPort,
        targetHost,
        targetPort,
        secure,
        guard,
      );
    }

    return this.handshakeSocks5(
      client,
      upstreamHost,
      upstreamPort,
      targetHost,
      targetPort,
      secure,
      guard,
    );
  }

  /**
   * SOCKS 握手外壳：白名单校验目标主机 → 拨上游 → 执行握手体，成功以已建链 socket 决议
   * @description `handshakeSocks4`/`handshakeSocks5` 共用的
   * `new Promise → isValidTargetHost → choose().then().catch()` 壳：
   * 拨号失败与握手体抛错统一 reject；握手体自行销毁已建链的上游（两版语义与抽壳前逐字一致）
   * @param targetHost - 真实目标主机（进握手体前过白名单，防 CRLF 注入与长度域截断）
   * @param handshake - 握手体：向已建链的上游发请求并等应答，失败 throw
   * @returns 已完成二次握手的上游 socket
   */
  private withUpstreamDial(
    client: Duplex,
    upstreamHost: string,
    upstreamPort: number,
    targetHost: string,
    secure: boolean,
    guard: DialGuardOptions | undefined,
    handshake: (sock: Duplex) => Promise<void>,
  ): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      if (!isValidTargetHost(targetHost)) {
        reject(new Error("invalid target host"));
        return;
      }

      this.choose(client, upstreamHost, upstreamPort, secure, guard)
        .then((sock) => {
          handshake(sock).then(() => resolve(sock), reject);
        })
        .catch(reject);
    });
  }

  /**
   * SOCKS4a 握手：发 0x04=VER、0x01=CONNECT；回 0x00=null、0x5a=granted 才算建链；域名走 0.0.0.1+尾部域名；
   * USERID 取 `upstreamUsername`（协议无密码字段，未配置即空，与直连旧语义一致）
   */
  private handshakeSocks4(
    client: Duplex,
    upstreamHost: string,
    upstreamPort: number,
    targetHost: string,
    targetPort: number,
    secure: boolean,
    guard?: DialGuardOptions,
  ): Promise<Duplex> {
    return this.withUpstreamDial(
      client,
      upstreamHost,
      upstreamPort,
      targetHost,
      secure,
      guard,
      async (sock) => {
        const portHi = (targetPort >> 8) & 0xff;
        const portLo = targetPort & 0xff;

        const octets = targetHost.split(".");
        const isIpv4 =
          octets.length === 4 &&
          octets.every((o) => {
            const n = Number(o);

            return String(n) === o && n >= 0 && n <= 255;
          });

        // SOCKS4 认证即 USERID：取上游账号名，未配置保持空（旧语义）
        const userid = Buffer.from(get("upstreamUsername") || "");

        let req: Buffer;

        if (isIpv4) {
          req = Buffer.concat([
            Buffer.from([
              SOCKS4_VERSION,
              SOCKS_CMD_CONNECT,
              portHi,
              portLo,
              Number(octets[0]),
              Number(octets[1]),
              Number(octets[2]),
              Number(octets[3]),
            ]),
            userid,
            Buffer.from([SOCKS4_NULL]),
          ]);
        } else {
          const domain = Buffer.from(targetHost);

          req = Buffer.concat([
            Buffer.from([SOCKS4_VERSION, SOCKS_CMD_CONNECT, portHi, portLo, ...SOCKS4A_FAKE_IP]),
            userid,
            Buffer.from([SOCKS4_NULL]),
            domain,
            Buffer.from([SOCKS4_NULL]),
          ]);
        }

        sock.write(req);

        // 应答固定 8 字节：可能跨 TCP 分段到达，按字节读满（余量回灌 socket）；
        // 读失败沿用抽壳前语义——销毁已建链上游再抛（超时已在 readReply 内销毁，这里幂等）
        let r: Buffer;

        try {
          r = await this.readReply(sock, SOCKS4_REPLY_BYTES);
        } catch (e) {
          sock.destroy();
          throw e;
        }

        if (r[0] !== SOCKS4_REPLY_VN || r[1] !== SOCKS4_REPLY_GRANTED) {
          sock.destroy();
          throw new Error("socks4 connect failed");
        }
      },
    );
  }

  /**
   * SOCKS5 握手：首轮按上游账号提供方法（无账号只报无鉴权，有账号同时报无鉴权与用户密码，由上游挑选），
   * 选中 0x02 走 RFC1929 子协商（`upstreamUsername`/`upstreamPassword`，超 255 字节直接失败）；
   * CONNECT 的 ATYP 按目标地址族选：IPv6 字面量用 0x04 + 16 字节地址（域名型是字符串，
   * 无法承载 v6，此前拼出 `::1` 字符串会被上游按域名解析而失败），IPv4/域名沿用 0x03 域名型
   * （刻意的简化：不区分二者，上游兼容性最好）；回包 REP 0x00=成功
   */
  private handshakeSocks5(
    client: Duplex,
    upstreamHost: string,
    upstreamPort: number,
    targetHost: string,
    targetPort: number,
    secure: boolean,
    guard?: DialGuardOptions,
  ): Promise<Duplex> {
    return this.withUpstreamDial(
      client,
      upstreamHost,
      upstreamPort,
      targetHost,
      secure,
      guard,
      async (sock) => {
        const username = get("upstreamUsername") || "";

        sock.write(
          username
            ? Buffer.from([SOCKS5_VERSION, 0x02, SOCKS5_METHOD_NO_AUTH, SOCKS5_METHOD_USER_PASS])
            : SOCKS5_HANDSHAKE_REQ,
        );

        const method = await this.readReply(sock, SOCKS5_METHOD_REPLY_BYTES);

        if (method[0] !== SOCKS5_VERSION) {
          sock.destroy();
          throw new Error("socks handshake failed");
        }

        if (method[1] === SOCKS5_METHOD_USER_PASS) {
          const user = Buffer.from(username);
          const pass = Buffer.from(get("upstreamPassword") || "");

          if (user.length === 0 || user.length > 255 || pass.length > 255) {
            sock.destroy();
            throw new Error("socks5 upstream auth failed");
          }

          sock.write(
            Buffer.concat([
              Buffer.from([SOCKS5_AUTH_VERSION, user.length]),
              user,
              Buffer.from([pass.length]),
              pass,
            ]),
          );

          const sub = await this.readReply(sock, SOCKS5_METHOD_REPLY_BYTES);

          if (sub[0] !== SOCKS5_AUTH_VERSION || sub[1] !== SOCKS5_REP_SUCCESS) {
            sock.destroy();
            throw new Error("socks5 upstream auth failed");
          }
        } else if (method[1] !== SOCKS5_METHOD_NO_AUTH) {
          sock.destroy();
          throw new Error("socks handshake failed");
        }

        const ip = normalizeIp(targetHost);
        const portBuf = Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]);

        let req: Buffer;

        if (ip?.family === 6) {
          // IPv6 字面量：域名型是字符串无 v6 语义，必须用 16 字节地址型（RFC1928 ATYP 0x04）
          req = Buffer.concat([
            Buffer.from([SOCKS5_VERSION, SOCKS_CMD_CONNECT, SOCKS5_REP_SUCCESS, SOCKS5_ATYP_IPV6]),
            ip.bytes,
            portBuf,
          ]);
        } else {
          // IPv4/域名沿用域名型（刻意简化：不区分二者，上游兼容性最好）
          const hostBuf = Buffer.from(targetHost);

          req = Buffer.concat([
            Buffer.from([
              SOCKS5_VERSION,
              SOCKS_CMD_CONNECT,
              SOCKS5_REP_SUCCESS,
              SOCKS5_ATYP_DOMAIN,
              hostBuf.length,
            ]),
            hostBuf,
            portBuf,
          ]);
        }

        sock.write(req);

        await this.readConnectReply(sock);
      },
    );
  }

  /**
   * 读取上游应答（跨 TCP 分段累积，精确消费 n 字节）
   * @description
   * - 上游 SOCKS 应答可能被拆成多个 data 包：单个 `once("data")` 会把合法上游误判为失败
   * - 用「暂停 + `read(n)`」精确取走 n 字节：应答之后的余量（可能已带 server-speaks-first 目标首包）
   *   留在 socket 内部缓冲，交后续 bridge / http.request 原样读取——既不丢也不多读
   *   （不采用先 data 事件再 unshift 回灌：在 data 回调内回灌的字节不会可靠地再次触发读取）
   * @param sock - 上游连接
   * @param n - 期望字节数
   * @returns 恰好 n 字节的应答
   * @throws 读取超时 / 对端提前关闭 / socket 错误
   */
  private readReply(sock: Duplex, n: number): Promise<Buffer> {
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
      const timer = setTimeout(() => {
        cleanup();
        sock.destroy();
        reject(new Error("socks reply timeout"));
      }, get("upstreamTimeout") as number);

      // 暂停而非挂 data 监听：数据进内部缓冲，按需 read(n) 精确消费
      sock.pause();
      sock.on("readable", onReadable);
      sock.once("close", onClose);
      sock.once("error", onError);
    });
  }

  /**
   * 读上游 SOCKS5 CONNECT 应答：4 字节固定头定 ATYP，再按类型读满地址与端口
   * @param sock - 上游连接（已发 CONNECT）
   * @throws 应答非成功 / ATYP 非法 / 读取失败
   */
  private async readConnectReply(sock: Duplex): Promise<void> {
    const head = await this.readReply(sock, SOCKS5_REPLY_HEAD_BYTES);

    // 版本与 REP 都要校验：只看 REP 会放过非 SOCKS5 报文
    if (head[0] !== SOCKS5_VERSION || head[1] !== SOCKS5_REP_SUCCESS) {
      sock.destroy();
      throw new Error("socks connect failed");
    }

    const atyp = head[3];

    if (atyp === SOCKS5_ATYP_IPV4) {
      await this.readReply(sock, 4 + 2);
      return;
    }

    if (atyp === SOCKS5_ATYP_IPV6) {
      await this.readReply(sock, 16 + 2);
      return;
    }

    if (atyp === SOCKS5_ATYP_DOMAIN) {
      const len = await this.readReply(sock, 1);
      await this.readReply(sock, len[0] + 2);
      return;
    }

    sock.destroy();
    throw new Error("socks connect failed: bad atyp");
  }
}
