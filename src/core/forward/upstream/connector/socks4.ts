/**
 * @fileoverview SOCKS4/4a 上游连接器
 * @module core/forward/upstream/connector/socks4
 * @description
 * 「怎么到达 dest」的代理形态之二：拨上游 `upstreamHost:upstreamPort` → SOCKS4/4a
 * 握手（USERID 取 `upstreamUsername`）→ 隧道直达真实目标。
 *
 * 正确性对照（与现有行为逐条一致）：
 * | targetForm | upstreamAuthHeader | selfLoopTarget | transport | peerTarget |
 * |---|---|---|---|---|
 * | `origin`（SOCKS 隧道**直达源站**，不是发给代理） | `undefined`（凭证走 SOCKS 握手而非 HTTP 头） | `upstreamHost:upstreamPort` | = `open().sock` | `dest` |
 *
 * 这两条与 `http.forwardViaSocks`（origin-form + 不注入 `proxy-authorization`）、
 * `socks.connect` 的 socks 分支、以及 `websocket.buildUpgradeReq` 的
 * `toUpstreamProxy === false` 分支逐字一致。**最容易搞错的恰恰是这里**：
 * 「经 SOCKS 上游」不等于「对端是代理」——它对**源站**说话，凭证在 SOCKS 握手里，
 * 出站 HTTP 报文必须用 origin-form 且绝不能带上 `Proxy-Authorization`。
 *
 * `upstreamProtocol` 的 `socks4`（明文承载）与 `sockss4`（TLS 承载）映射到本类，
 * TLS 承载是构造参数（传输细节），逻辑 kind 恒为 `socks4`。
 *
 * **本类只提供 SOCKS4 协议实现**（{@link Socks4Connector.handshake}）；拨号外壳
 * （白名单 → `choose` → 握手）、握手应答读取器 `readReply`（带 SOCKS 文案，故 2c 从 `Dialer` 搬来）
 * 与四个声明式成员在基类 `socks-upstream.ts`（与 `socks5.ts` 共用唯一一份）。
 *
 * 依赖方向：`connector/socks4 → connector/socks-upstream → forward/dial`（单向；反向禁止）。
 */

import type { Duplex } from "node:stream";
import {
  SOCKS4A_FAKE_IP,
  SOCKS4_NULL,
  SOCKS4_REPLY_BYTES,
  SOCKS4_REPLY_GRANTED,
  SOCKS4_REPLY_VN,
  SOCKS4_VERSION,
  SOCKS_CMD_CONNECT,
} from "@/utils/constants/index.js";
import { SocksUpstreamConnector } from "./socks-upstream.js";

/**
 * SOCKS4/4a 上游连接器
 *
 * @description
 * 无状态：每次 `open()` 现读配置（上游地址/端口/USERID/超时），连接器自身不缓存任何
 * 请求间会变的值，故可安全地在 registry 里缓存单例。
 */
export class Socks4Connector extends SocksUpstreamConnector {
  /** 逻辑协议身份：TLS 承载不参与，`sockss4` 的 kind 即 `socks4` */
  readonly kind = "socks4" as const;

  /**
   * SOCKS4/4a 握手：发 0x04=VER、0x01=CONNECT；回 0x00=null、0x5a=granted 才算建链；域名走 0.0.0.1+尾部域名；
   * USERID 取 `upstreamUsername`（协议无密码字段，未配置即空，与直连旧语义一致）
   *
   * @description
   * 纯 IPv4 字面量走 4 字节地址；**其余一切（含 IPv6 字面量）走 4a 哨兵**——
   * SOCKS4 没有地址族字段，IPv6 无处安放，按域名串交给上游（**刻意不加分支**，
   * 域名/字符串由上游解析是 SOCKS4a 的既定能力）。
   * 应答固定 8 字节：可能跨 TCP 分段到达，按字节读满（余量留在 socket 内部缓冲）。
   * 读失败沿用抽壳前语义——销毁已建链上游再抛（超时已在 `readReply` 内销毁，这里幂等）。
   */
  protected async handshake(sock: Duplex, target: { host: string; port: number }): Promise<void> {
    const portHi = (target.port >> 8) & 0xff;
    const portLo = target.port & 0xff;

    const octets = target.host.split(".");
    const isIpv4 =
      octets.length === 4 &&
      octets.every((o) => {
        const n = Number(o);

        return String(n) === o && n >= 0 && n <= 255;
      });

    // SOCKS4 认证即 USERID：取上游账号名，未配置保持空（旧语义）
    const userid = Buffer.from(this.config.get("upstreamUsername") || "");

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
      const domain = Buffer.from(target.host);

      req = Buffer.concat([
        Buffer.from([SOCKS4_VERSION, SOCKS_CMD_CONNECT, portHi, portLo, ...SOCKS4A_FAKE_IP]),
        userid,
        Buffer.from([SOCKS4_NULL]),
        domain,
        Buffer.from([SOCKS4_NULL]),
      ]);
    }

    sock.write(req);

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
  }
}
