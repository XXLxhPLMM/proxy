import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { set, testContext } from "../helpers/config.js";
import { HttpProxy } from "@/core/server/http.js";
import { FileAccountIdentity } from "@/core/identity.js";
import { createConnectorSource } from "@/core/forward/upstream/connector/index.js";
import type { ConnectorSource } from "@/core/forward/upstream/connector/index.js";
import { getFreePort, listen } from "../helpers/net.js";
import { openAccessControl } from "../helpers/access.js";
import { restoreConfig, silenceLogs, snapshotConfig } from "../helpers/config.js";
import { TEST_CA_PATH, TEST_TLS_CERTS } from "../helpers/certs.js";

/**
 * 连接器源：**现读** `upstreamProtocol` 的那份。
 *
 * @description
 * 生产默认实现 `createConnectorSource(ctx)` 把「走上游」记忆在一份 source 上，正确性挂在
 * 「`UPSTREAM_PROTOCOL` 是 startup 相位、accessor 对它读冻结值」上。本文件的代理在
 * `beforeAll` 建一次、三条用例逐条 `set("upstreamProtocol", https|http|socks5)` 轮换，
 * 那个前提不成立：沿用记忆化那份会让第一条走上游的用例把协议粘死，后两条全部 502。
 *
 * `ConnectorSource` 是**端口**，「记忆化」只是默认实现的一个选择而非契约；这里实现的是
 * 同一端口的现读档，与「每请求现读一次 `upstreamProtocol`」逐字同形。
 *
 * ⚠️ 本应住在 `tests/helpers/proxy.ts` 紧邻 `withProxy`（所有直构 core 的汇聚点）；
 * 它就地定义而没有放进 `tests/helpers/**`（登记在 `tests/AGENTS.md`，待收口）。
 */
function liveConnectors(): ConnectorSource {
  return {
    direct: () => createConnectorSource(testContext).direct(),
    upstream: () => createConnectorSource(testContext).upstream(),
  };
}

function httpGetViaProxy(
  proxyPort: number,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: url,
        headers: { Host: "example.com", ...headers },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * 上游代理桩（https 或 http 形态）：回显本代理发给它的 req.url
 * client 串联保留客户端请求行形态，absolute-form 原样可见
 */
function makeUpstream(tls: { key: Buffer; cert: Buffer } | null): https.Server | http.Server {
  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`upstream-ok:${req.url}`);
  };
  return tls ? https.createServer(tls, handler) : http.createServer(handler);
}

describe("integration/http-proxy upstream protocol", () => {
  let proxyPort = 0;
  let tlsUpstreamPort = 0;
  let plainUpstreamPort = 0;
  let tlsUpstream: https.Server | null = null;
  let plainUpstream: http.Server | null = null;
  let proxy: HttpProxy | null = null;
  const prev = snapshotConfig(["proxyMode", "upstreamProtocol", "upstreamHost", "upstreamPort", "upstreamCa", "upstreamInsecure", "logLevel", "logFile"]);

  beforeAll(async () => {
    proxyPort = await getFreePort();
    tlsUpstreamPort = await getFreePort();
    plainUpstreamPort = await getFreePort();
    silenceLogs();
    set("host", "127.0.0.1");
    set("port", proxyPort);
    set("proxyMode", "client");
    set("upstreamHost", "127.0.0.1");
    set("upstreamUsername", "");
    set("upstreamPassword", "");

    tlsUpstream = makeUpstream(TEST_TLS_CERTS) as https.Server;
    await listen(tlsUpstream, tlsUpstreamPort);
    plainUpstream = makeUpstream(null) as http.Server;
    await listen(plainUpstream, plainUpstreamPort);

    proxy = new HttpProxy({
      ctx: testContext,
      host: "127.0.0.1",
      port: proxyPort,
      identity: new FileAccountIdentity({ enabled: false }),
      // 上游协议选择用例与名单无关 → 显式点名「不判名单」
      access: openAccessControl(),
      connectors: liveConnectors(),
    });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy?.stop().catch(() => undefined);
    await new Promise<void>((resolve) => tlsUpstream?.close(() => resolve()));
    await new Promise<void>((resolve) => plainUpstream?.close(() => resolve()));
    restoreConfig(prev);
  });

  it("upstream=https：TLS 建链 + CA 校验通过转发到 https 上游代理", async () => {
    set("upstreamProtocol", "https");
    set("upstreamPort", tlsUpstreamPort);
    set("upstreamCa", TEST_CA_PATH);
    set("upstreamInsecure", false);
    const { status, body } = await httpGetViaProxy(proxyPort, "http://example.com/hello");
    expect(status).toBe(200);
    // 钉住线上形态：client 串联给上游代理保留客户端的 absolute-form，不回退 origin-form
    expect(body).toBe("upstream-ok:http://example.com/hello");
  });

  it("upstream=http：明文上游不回归", async () => {
    set("upstreamProtocol", "http");
    set("upstreamPort", plainUpstreamPort);
    const { status, body } = await httpGetViaProxy(proxyPort, "http://example.com/plain");
    expect(status).toBe(200);
    expect(body).toBe("upstream-ok:http://example.com/plain");
  });

  it("upstream=socks5：经 SOCKS 隧道转发到真实目标", async () => {
    // 最小 SOCKS5 上游桩：无鉴权握手 → CONNECT 域名 → 直连目标透传
    const socksUpstream = net.createServer((client) => {
      client.once("data", () => {
        client.write(Buffer.from([0x05, 0x00]));
        client.once("data", (req: Buffer) => {
          const len = req[4];
          const host = req.subarray(5, 5 + len).toString();
          const port = req.readUInt16BE(5 + len);
          const target = net.connect(port, host, () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            client.pipe(target);
            target.pipe(client);
          });
          target.on("error", () => client.destroy());
        });
      });
      client.on("error", () => undefined);
    });
    const socksPort = await getFreePort();
    await new Promise<void>((resolve) =>
      socksUpstream.listen(socksPort, "127.0.0.1", () => resolve()),
    );
    try {
      set("upstreamProtocol", "socks5");
      set("upstreamHost", "127.0.0.1");
      set("upstreamPort", socksPort);
      // 真实目标：明文上游 serve 的 example.com 映射到本机 plainUpstream
      const { status } = await httpGetViaProxy(
        proxyPort,
        `http://127.0.0.1:${plainUpstreamPort}/via-socks`,
      );
      expect(status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => socksUpstream.close(() => resolve()));
    }
  });
});
