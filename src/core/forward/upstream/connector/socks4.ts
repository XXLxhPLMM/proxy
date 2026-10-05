/**
 * @fileoverview SOCKS4/4a 上游连接器
 * @module core/forward/upstream/connector/socks4
 * @description
 * 「怎么到达 dest」的代理形态之二：拨上游 `upstreamHost:upstreamPort` → SOCKS4/4a
 * 握手（USERID 取 `upstreamUsername`）→ 隧道直达真实目标。
 *
 * 「经 SOCKS 上游」**不等于**「对端是代理」——它对**源站**说话，出站 HTTP 报文必须用
 * origin-form 且绝不能带上 `Proxy-Authorization`（与 `http.forwardViaSocks` / `socks.connect` /
 * `websocket.buildUpgradeReq` 的 `toUpstreamProxy === false` 分支逐字一致）。这条最容易搞错的
 * 结论与它的理由见基类 `socks-upstream.ts` 的模块头。
 *
 * `upstreamProtocol` 的 `socks4`（明文承载）与 `sockss4`（TLS 承载）映射到本类，
 * TLS 承载是构造参数（传输细节），逻辑 kind 恒为 `socks4`。
 *
 * **本类只提供 SOCKS4 协议实现**（{@link Socks4Connector.handshake}）；拨号外壳、
 * 握手应答读取器 `readReply` 与四个声明式成员在基类 `socks-upstream.ts`
 * （与 `socks5.ts` 共用唯一一份）。
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
 * 无状态：每次 `open()` 现读配置、连接器自身不缓存任何请求间会变的值，故可安全地被
 * `ConnectorSource` 记忆成单例复用。
 */
export class Socks4Connector extends SocksUpstreamConnector {
  /** 逻辑协议身份：TLS 承载不参与，`sockss4` 的 kind 即 `socks4` */
  readonly kind = "socks4" as const;

  /**
   * SOCKS4/4a 握手：发 0x04=VER、0x01=CONNECT；回 0x00=null、0x5a=granted 才算建链；域名走 0.0.0.1+尾部域名；
   * USERID 取 `upstreamUsername`（协议无密码字段，未配置即空，与直连旧语义一致）
   *
   * @description
   * 纯 IPv4 字面量走 4 字节地址，**其余一切（含 IPv6 字面量）走 4a 哨兵**；USERID 未配置即空串
   * 终止符（不是拒绝）。这两条都是**有测试牙齿的刻意取舍**，结论与否掉了什么见
   * `tests/unit/core/forward/upstream/connector/open-socks.test.ts` 的档头注释（那里逐字节锁死了本方法的出站报文）。
   *
   * 应答固定 8 字节：可能跨 TCP 分段到达，按字节读满（余量留在 socket 内部缓冲）。
   * 读失败销毁已建链上游再抛（超时已在 `readReply` 内销毁，这里幂等）。
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
