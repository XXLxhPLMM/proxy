/**
 * @fileoverview SOCKS5 上游连接器
 * @module core/forward/upstream/connector/socks5
 * @description
 * 「怎么到达 dest」的代理形态之三：拨上游 `upstreamHost:upstreamPort` → SOCKS5
 * 方法协商（+ 可选 RFC1929 用户密码子协商）→ CONNECT 真实目标 → 隧道直达源站。
 *
 * 正确性对照（与现有行为逐条一致）：
 * | targetForm | upstreamAuthHeader | selfLoopTarget | transport | peerTarget |
 * |---|---|---|---|---|
 * | `origin`（SOCKS 隧道**直达源站**，不是发给代理） | `undefined`（凭证走 SOCKS 握手而非 HTTP 头） | `upstreamHost:upstreamPort` | = `open().sock` | `dest` |
 *
 * 与 `socks4.ts` 同理：「经 SOCKS 上游」不等于「对端是代理」——它对**源站**说话，
 * 出站 HTTP 报文必须用 origin-form 且绝不能带上 `Proxy-Authorization`
 * （与 `http.forwardViaSocks` / `socks.connect` / `websocket.buildUpgradeReq` 的
 * `toUpstreamProxy === false` 分支逐字一致）。
 *
 * `upstreamProtocol` 的 `socks5`（明文承载）与 `sockss5`（TLS 承载）映射到本类，
 * TLS 承载是构造参数（传输细节），逻辑 kind 恒为 `socks5`。
 *
 * **本类只提供 SOCKS5 协议实现**（{@link Socks5Connector.handshake} 与
 * {@link Socks5Connector.readConnectReply}）；拨号外壳（白名单 → `choose` → 握手）、
 * 握手应答读取器 `readReply`（带 SOCKS 文案，故 2c 从 `Dialer` 搬来）与四个声明式成员
 * 在基类 `socks-upstream.ts`（与 `socks4.ts` 共用唯一一份）。
 *
 * 依赖方向：`connector/socks5 → connector/socks-upstream → forward/dial`（单向；反向禁止）。
 */

import type { Duplex } from "node:stream";
import { normalizeIp } from "@/config/files/rules/index.js";
import {
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
} from "@/utils/constants/index.js";
import { SocksUpstreamConnector } from "./socks-upstream.js";

/**
 * SOCKS5 上游连接器
 *
 * @description
 * 无状态：每次 `open()` 现读配置（上游地址/端口/账号/密码/超时），连接器自身不缓存任何
 * 请求间会变的值，故可安全地被 `ConnectorSource` 记忆成单例复用。
 */
export class Socks5Connector extends SocksUpstreamConnector {
  /** 逻辑协议身份：TLS 承载不参与，`sockss5` 的 kind 即 `socks5` */
  readonly kind = "socks5" as const;

  /**
   * SOCKS5 握手：首轮按上游账号提供方法（无账号只报无鉴权，有账号同时报无鉴权与用户密码，由上游挑选），
   * 选中 0x02 走 RFC1929 子协商（`upstreamUsername`/`upstreamPassword`，超 255 字节直接失败）；
   * CONNECT 的 ATYP 按目标地址族选：IPv6 字面量用 0x04 + 16 字节地址（域名型是字符串，
   * 无法承载 v6——拼出 `::1` 字符串会被上游按域名解析而失败），IPv4/域名沿用 0x03 域名型
   * （刻意的简化：不区分二者，上游兼容性最好）；回包 REP 0x00=成功
   */
  protected async handshake(sock: Duplex, target: { host: string; port: number }): Promise<void> {
    const username = this.config.get("upstreamUsername") || "";

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
      const pass = Buffer.from(this.config.get("upstreamPassword") || "");

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

    const ip = normalizeIp(target.host);
    const portBuf = Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]);

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
      const hostBuf = Buffer.from(target.host);

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
