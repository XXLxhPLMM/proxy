import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import { guardDialing, type DialGuardOptions } from "@/core/proxy-helpers.js";
import { SOCKS5_HANDSHAKE_REQ } from "@/utils/constants.js";

/**
 * 读取上游 CA（自签场景），不存在则回退系统信任库
 */
function readCa(): Buffer | undefined {
  const p = get("upstreamCa");

  if (p && fs.existsSync(p)) {
    return fs.readFileSync(p);
  }

  return undefined;
}

/**
 * 拨号器
 * - 统一 net/tls 建链与守卫
 * - 提供 SOCKS 隧道能力，供任意 client → 任意上游互转
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
   * 加密拨：tls.connect，证书校验锚定建链目标（见 servername 规则）
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
            // IP 按 RFC6066 置空 SNI，按连接 host 校验 SAN-IP
            servername: net.isIP(h) ? "" : h,
            rejectUnauthorized: !get("upstreamInsecure"),
            ca: readCa(),
          },
          cb,
        );

        return s as unknown as Duplex;
      },
      opts,
    );
  }

  /**
   * 通用拨号：open 回调/error/timeout 三源竞态，settled 只决议一次；兼听 secureConnect 兼容 tls 建链
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

      const upstream = open(host, port, () => {
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
            reject(new Error(`timeout ${host}:${port}`));
          });
        },
      });

      upstream.once("error", (e) => {
        settle(() => {
          reject(e as Error);
        });
      });

      upstream.once("connect", () => {
        dial.established();
      });

      (
        upstream as unknown as {
          once(e: string, cb: () => void): void;
        }
      ).once("secureConnect", () => {
        dial.established();
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
   * 经由 SOCKS 上游拨到真实目标（供 http→socks / tunnel→socks / socks→socks 串联）
   * version 缺省时按 upstreamProtocol 推导：socks4/sockss4 → 4，其余 → 5
   * secure 缺省时按 upstreamProtocol 是否 sockss* 推导
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

    const ver: 4 | 5 = version ?? (proto === "socks4" || proto === "sockss4" ? 4 : 5);

    const useTls: boolean = secure ?? proto.startsWith("sockss");

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
   * SOCKS4a 握手：发 0x04=VER、0x01=CONNECT；回 0x00=null、0x5a=granted 才算建链；域名走 0.0.0.1+尾部域名
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
    return new Promise((resolve, reject) => {
      this.choose(client, upstreamHost, upstreamPort, secure, guard)
        .then((sock) => {
          const portHi = (targetPort >> 8) & 0xff;
          const portLo = targetPort & 0xff;

          const octets = targetHost.split(".");
          const isIpv4 =
            octets.length === 4 &&
            octets.every((o) => {
              const n = Number(o);

              return String(n) === o && n >= 0 && n <= 255;
            });

          let req: Buffer;

          if (isIpv4) {
            req = Buffer.concat([
              Buffer.from([
                0x04,
                0x01,
                portHi,
                portLo,
                Number(octets[0]),
                Number(octets[1]),
                Number(octets[2]),
                Number(octets[3]),
                0x00,
              ]),
            ]);
          } else {
            const domain = Buffer.from(targetHost);

            req = Buffer.concat([
              Buffer.from([0x04, 0x01, portHi, portLo, 0x00, 0x00, 0x00, 0x01, 0x00]),
              domain,
              Buffer.from([0x00]),
            ]);
          }

          sock.write(req);

          sock.once("data", (r: Buffer) => {
            if (r.length < 2 || r[0] !== 0x00 || r[1] !== 0x5a) {
              sock.destroy();
              reject(new Error("socks4 connect failed"));
              return;
            }

            resolve(sock);
          });

          sock.once("error", (e) => {
            reject(e as Error);
          });
        })
        .catch(reject);
    });
  }

  /**
   * SOCKS5 握手：首轮发 0x05/0x01/0x00 选无鉴权，回 0x05/0x00 才续发；CONNECT 统一 ATYP 0x03 域名型（简化+上游兼容，IPv4 亦然）；回包 REP 0x00=成功
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
    return new Promise((resolve, reject) => {
      this.choose(client, upstreamHost, upstreamPort, secure, guard)
        .then((sock) => {
          sock.write(SOCKS5_HANDSHAKE_REQ);

          sock.once("data", (d: Buffer) => {
            if (d.length < 2 || d[0] !== 0x05 || d[1] !== 0x00) {
              sock.destroy();
              reject(new Error("socks handshake failed"));
              return;
            }

            const hostBuf = Buffer.from(targetHost);
            const req = Buffer.concat([
              Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
              hostBuf,
              Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
            ]);

            sock.write(req);

            sock.once("data", (r: Buffer) => {
              if (r.length < 2 || r[1] !== 0x00) {
                sock.destroy();
                reject(new Error("socks connect failed"));
                return;
              }

              resolve(sock);
            });
          });

          sock.once("error", (e) => {
            reject(e as Error);
          });
        })
        .catch(reject);
    });
  }
}
