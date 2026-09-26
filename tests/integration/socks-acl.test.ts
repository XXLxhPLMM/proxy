import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readAcl } from "@/config/index.js";
import { set, testConfig, testContext } from "../helpers/config.js";
import type { ConfigKey } from "@/config/index.js";
import { Socks4Proxy } from "@/core/server/socks4.js";
import { Socks5Proxy } from "@/core/server/socks5.js";
import { createFileAccessControl } from "@/core/access-control.js";
import { getFreePort, listen } from "../helpers/net.js";
import { withProxy } from "../helpers/proxy.js";
import { restoreConfig, silenceLogs, snapshotConfig } from "../helpers/config.js";

/**
 * 文件驱动的访问控制。
 *
 * @description
 * `ProxyOptions.access` 是**必填**的（`access: AccessControl`，无 `?`）：core 侧**零缺省解析**
 * ⚠️ **`ProxyOptions.access` 必填、无缺省档**：全仓不存在 `OPEN_ACCESS_CONTROL` 那个「恒放行」符号，缺席即全放行，所以必须编译期拦。
 * 本文件直构 core，
 * 故必须显式注入，否则「名单判定」这条被测行为整条消失（表现为握手正常放行 / 应答 `05 00`）。
 *
 * ⚠️ 本应住在 `tests/helpers/proxy.ts` 紧邻 `withProxy`（那里是所有直构 core 的汇聚点）；
 * 它就地定义而没有放进 `tests/helpers/**`（登记在 `tests/AGENTS.md`，待收口）。
 */
const fileAccess = createFileAccessControl(testContext.config);
import {
  makeCollector,
  socks4aRequest,
  socks5ConnectIpv4,
  tcConnect,
} from "../helpers/socks-client.js";

/**
 * 访问控制（acl.json）在 SOCKS 入站的行为：
 * - 客户端来源命中名单：握手前直接断连（无协议应答）
 * - 目标命中名单：回对应版本的失败应答
 * - 空名单：正常建隧
 */

const KEYS: readonly ConfigKey[] = ["aclFile", "authEnabled", "authType", "logLevel", "logFile"];

const SOCKS5_NO_AUTH_REPLY = (b: Buffer): boolean =>
  b.length >= 2 && b[0] === 0x05 && b[1] === 0x00;

describe("integration/socks-acl", () => {
  let snap: Record<string, unknown>;
  let dir: string;
  let aclPath: string;
  let origin: http.Server;
  let originPort: number;
  let originHits: number;

  beforeEach(async () => {
    snap = snapshotConfig(KEYS);
    silenceLogs();
    set("authEnabled", false);
    set("authType", "none");

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-socks-acl-"));
    aclPath = path.join(dir, "acl.json");
    set("aclFile", aclPath);

    originHits = 0;
    origin = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
      originHits++;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("origin-ok");
    });
    originPort = await getFreePort();
    await listen(origin, originPort);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      origin.closeAllConnections?.();
      origin.close(() => resolve());
    });
    fs.rmSync(dir, { recursive: true, force: true });
    restoreConfig(snap);
  });

  function writeAcl(acl: unknown): void {
    fs.writeFileSync(aclPath, JSON.stringify(acl));
    readAcl({ config: testConfig, force: true });
  }

  it("客户端 IP 黑名单命中：握手前直接断连且不回任何字节", async () => {
    writeAcl({ clientIp: { blacklist: ["127.0.0.1"] } });

    await withProxy(Socks5Proxy, { access: fileAccess }, async (port) => {
      const sock = await tcConnect(port);
      const col = makeCollector(sock);
      await col.waitClose();
      expect(col.bytes().length).toBe(0);
    });
  });

  it("socks5 目标黑名单：握手正常但 CONNECT 回失败应答且不触达目标", async () => {
    writeAcl({ target: { blacklist: ["127.0.0.1"] } });

    await withProxy(Socks5Proxy, { access: fileAccess }, async (port) => {
      const sock = await tcConnect(port);
      const col = makeCollector(sock);

      sock.write(Buffer.from([0x05, 0x01, 0x00]));
      await col.waitFor(SOCKS5_NO_AUTH_REPLY);

      sock.write(socks5ConnectIpv4("127.0.0.1", originPort));
      const resp = await col.waitFor((b) => b.length >= 12);

      // 缓冲前 2 字节是握手应答（05 00），其后才是 CONNECT 应答
      expect(resp.subarray(2, 4)).toEqual(Buffer.from([0x05, 0x01]));
      expect(originHits).toBe(0);
      sock.destroy();
    });
  });

  it("socks4a 目标黑名单：回 0x5B 失败应答（域名条目，未拨号故不涉 DNS）", async () => {
    writeAcl({ target: { blacklist: ["blocked.invalid"] } });

    await withProxy(Socks4Proxy, { access: fileAccess }, async (port) => {
      const sock = await tcConnect(port);
      const col = makeCollector(sock);

      sock.write(socks4aRequest("anyone", "blocked.invalid", 80));
      const resp = await col.waitFor((b) => b.length >= 8);

      expect(resp[1]).toBe(0x5b);
      sock.destroy();
    });
  });

  it("空名单：正常建隧并触达目标", async () => {
    writeAcl({});

    await withProxy(Socks5Proxy, { access: fileAccess }, async (port) => {
      const sock = await tcConnect(port);
      const col = makeCollector(sock);

      sock.write(Buffer.from([0x05, 0x01, 0x00]));
      await col.waitFor(SOCKS5_NO_AUTH_REPLY);

      sock.write(socks5ConnectIpv4("127.0.0.1", originPort));
      const resp = await col.waitFor((b) => b.length >= 10);

      expect(resp[1]).toBe(0x00);

      // 隧道内发一个最小 HTTP 请求，确认真的通了
      sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nConnection: close\r\n\r\n`);
      await col.waitFor((b) => b.toString().includes("origin-ok"));
      expect(originHits).toBe(1);
      sock.destroy();
    });
  });
});
