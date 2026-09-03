import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { get, set } from "@/config/store.js";
import { defaults } from "@/config/store.js";
import { HttpProxy } from "@/server/http.js";
import { Auth } from "@/core/auth.js";

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function httpGetViaProxy(proxyPort: number, targetPort: number, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: `http://127.0.0.1:${targetPort}/hello`,
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

describe("integration/http-proxy", () => {
  let targetPort = 0;
  let proxyPort = 0;
  let target: http.Server | null = null;
  let proxy: HttpProxy | null = null;
  const prev = { host: get("host"), port: get("port"), mode: get("proxyMode"), logLevel: get("logLevel"), logFile: get("logFile") };

  beforeAll(async () => {
    targetPort = await getFreePort();
    proxyPort = await getFreePort();
    // 降噪：关闭控制台与文件日志
    set("logLevel", "silent");
    set("logFile", "");
    set("host", "127.0.0.1");
    set("port", proxyPort);
    set("proxyMode", "server");

    target = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello-from-target");
    });
    await new Promise<void>((resolve) => target!.listen(targetPort, "127.0.0.1", resolve));

    proxy = new HttpProxy({ host: "127.0.0.1", port: proxyPort, auth: new Auth({ enabled: false }) });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy?.stop().catch(() => undefined);
    await new Promise<void>((resolve) => target?.close(() => resolve()));
    set("host", prev.host);
    set("port", prev.port);
    set("proxyMode", prev.mode);
    set("logLevel", prev.logLevel);
    set("logFile", prev.logFile as typeof defaults.logFile);
  });

  it("普通 HTTP 经代理转发到目标并回包", async () => {
    const { status, body } = await httpGetViaProxy(proxyPort, targetPort);
    expect(status).toBe(200);
    expect(body).toBe("hello-from-target");
  });

  it("生命周期：运行态快照正确，重复 start 幂等", async () => {
    expect(proxy!.isRunning()).toBe(true);
    expect(proxy!.state).toBe("running");
    await proxy!.start();
    expect(proxy!.state).toBe("running");
    const stats = proxy!.getStats();
    expect(stats.protocol).toBe("http");
    expect(stats.running).toBe(true);
  });

  it("鉴权开启时无凭证回 407，有凭证放行", async () => {
    // 另起一个带鉴权的代理实例，避免污染主实例
    const authPort = await getFreePort();
    set("port", authPort);
    const authed = new HttpProxy({
      host: "127.0.0.1",
      port: authPort,
      auth: new Auth({ enabled: true, type: "basic", username: "u", password: "p", enableLogging: false }),
    });
    await authed.start();
    try {
      const denied = await httpGetViaProxy(authPort, targetPort);
      expect(denied.status).toBe(407);
      const b64 = Buffer.from("u:p").toString("base64");
      const allowed = await httpGetViaProxy(authPort, targetPort, { "Proxy-Authorization": `Basic ${b64}` });
      expect(allowed.status).toBe(200);
      expect(allowed.body).toBe("hello-from-target");
    } finally {
      await authed.stop();
      set("port", proxyPort);
    }
  });
});
