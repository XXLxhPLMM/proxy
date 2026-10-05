/**
 * 经 node 客户端（`http.request` / 裸 `net` CONNECT）的三条：明文 HTTP 直转发、
 * Basic 鉴权三格（正确放行 / 错误 407 / 缺失 407）、以及 CONNECT 建隧后透传 HTTP。
 *
 * 两个 websocket 档（明文 Upgrade 与 wss 经 CONNECT+TLS）在 `http-client-node-upgrade.test.ts`；
 * 本地回声源站是**桩**（`_` 标了 200 + `hello-from-target`），不锁任何字节级行为。
 * 两档共用的 `startProxy` 与基础配置归 `./client-node-fixture.ts`；主题级判据与本目录清单见
 * `./AGENTS.md`。
 *
 * @module tests/integration/forward
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { FileAccountIdentity } from "@/core/identity.js";
import { getFreePort, listen } from "../../helpers/net.js";
import { restoreConfig, snapshotConfig } from "../../helpers/config.js";
import { KEYS, serverBaseConfig, startProxy } from "./client-node-fixture.js";

function httpGetViaProxy(
  proxyPort: number,
  targetPort: number,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: `http://127.0.0.1:${targetPort}/`,
        headers: { Host: `127.0.0.1:${targetPort}`, ...headers },
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

/** 裸 CONNECT 隧道后发 HTTP GET，验证 HTTPS 透传；返回首行状态码与 body */
function httpsGetViaConnect(
  proxyPort: number,
  targetPort: number,
  authB64?: string,
): Promise<{ connectStatus: number; status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(proxyPort, "127.0.0.1", () => {
      const auth = authB64 ? `Proxy-Authorization: Basic ${authB64}\r\n` : "";
      s.write(
        `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n${auth}Proxy-Connection: Keep-Alive\r\n\r\n`,
      );
    });
    s.once("data", (d) => {
      const header = d.toString();
      const line = header.split("\r\n")[0] ?? "";
      const connectStatus = parseInt(line.split(" ")[1] ?? "0", 10);
      if (connectStatus !== 200) {
        s.destroy();
        resolve({ connectStatus, status: 0, body: "" });
        return;
      }
      // CONNECT 成功后直接在同一 TCP 上发 HTTP 请求（目标为明文 http，故无需 TLS）
      s.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nConnection: close\r\n\r\n`);
      let data = "";
      s.on("data", (c) => (data += c.toString()));
      s.on("end", () => {
        const status = parseInt((data.split("\r\n")[0] ?? "").split(" ")[1] ?? "0", 10);
        resolve({ connectStatus, status, body: data });
      });
      s.on("error", reject);
    });
    s.on("error", reject);
    setTimeout(() => reject(new Error("CONNECT timeout")), 5000);
  });
}

describe("forward · http-client-node（经 node 客户端）", () => {
  let httpTargetPort = 0;
  let httpTarget: http.Server | null = null;

  const prev = snapshotConfig(KEYS);

  beforeAll(async () => {
    httpTargetPort = await getFreePort();

    serverBaseConfig();

    httpTarget = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello-from-target");
    });
    await listen(httpTarget, httpTargetPort);
  });

  afterAll(async () => {
    await new Promise<void>((r) => httpTarget?.close(() => r()));
    restoreConfig(prev);
  });

  it("http 明文经代理：无鉴权直接 200", async () => {
    const { proxy, port } = await startProxy(new FileAccountIdentity({ enabled: false }));
    try {
      const r = await httpGetViaProxy(port, httpTargetPort);
      expect(r.status).toBe(200);
      expect(r.body).toBe("hello-from-target");
    } finally {
      await proxy.stop();
    }
  });

  it("http 鉴权：正确 Basic 放行，错误/缺失 407", async () => {
    const b64 = Buffer.from("test:456").toString("base64");
    const { proxy, port } = await startProxy(
      new FileAccountIdentity({ enabled: true, type: "basic", accounts: [{ username: "test", password: "456" }], enableLogging: false }),
    );
    try {
      const ok = await httpGetViaProxy(port, httpTargetPort, { "Proxy-Authorization": `Basic ${b64}` });
      expect(ok.status).toBe(200);
      expect(ok.body).toBe("hello-from-target");

      const wrong = await httpGetViaProxy(port, httpTargetPort, {
        "Proxy-Authorization": `Basic ${Buffer.from("test:123").toString("base64")}`,
      });
      expect(wrong.status).toBe(407);

      const missing = await httpGetViaProxy(port, httpTargetPort);
      expect(missing.status).toBe(407);
    } finally {
      await proxy.stop();
    }
  });

  it("https CONNECT 隧道：鉴权通过后透传 HTTP，鉴权失败 407", async () => {
    const b64 = Buffer.from("test:456").toString("base64");
    const { proxy, port } = await startProxy(
      new FileAccountIdentity({ enabled: true, type: "basic", accounts: [{ username: "test", password: "456" }], enableLogging: false }),
    );
    try {
      const ok = await httpsGetViaConnect(port, httpTargetPort, b64);
      expect(ok.connectStatus).toBe(200);
      expect(ok.status).toBe(200);
      expect(ok.body).toContain("hello-from-target");

      const bad = await httpsGetViaConnect(port, httpTargetPort, Buffer.from("test:123").toString("base64"));
      expect(bad.connectStatus).toBe(407);

      const noAuth = await httpsGetViaConnect(port, httpTargetPort);
      expect(noAuth.connectStatus).toBe(407);
    } finally {
      await proxy.stop();
    }
  });
});
