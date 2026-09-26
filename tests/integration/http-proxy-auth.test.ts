import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { set, testContext } from "../helpers/config.js";
import { HttpProxy } from "@/core/server/http.js";
import { FileAccountIdentity } from "@/core/identity.js";
import type { IdentityProvider } from "@/core/types/identity.js";
import { getFreePort } from "../helpers/net.js";
import { openAccessControl } from "../helpers/access.js";
import { restoreConfig, silenceLogs, snapshotConfig } from "../helpers/config.js";

function httpGetViaProxy(
  proxyPort: number,
  targetPort: number,
  pathSuffix = "/hello",
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: `http://127.0.0.1:${targetPort}${pathSuffix}`,
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

/** 在空闲端口上起一个带指定身份提供者的真代理，HttpServer 从 store 读监听地址所以先 set 再 new */
async function startProxy(identity: IdentityProvider): Promise<{ proxy: HttpProxy; port: number }> {
  const port = await getFreePort();
  set("port", port);
  // 鉴权用例与名单无关 → 显式点名「不判名单」（core 侧已无 access 缺省）
  const proxy = new HttpProxy({
      ctx: testContext, host: "127.0.0.1", port, identity, access: openAccessControl() });
  await proxy.start();
  return { proxy, port };
}

describe("integration/http-proxy-auth", () => {
  let targetPort = 0;
  let target: http.Server | null = null;
  const prev = snapshotConfig(["host", "port", "proxyMode", "logLevel", "logFile"]);

  beforeAll(async () => {
    targetPort = await getFreePort();
    silenceLogs();
    set("host", "127.0.0.1");
    set("proxyMode", "server");
    target = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello-from-target");
    });
    await new Promise<void>((resolve) => target!.listen(targetPort, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => target?.close(() => resolve()));
    restoreConfig(prev);
  });

  it("无鉴权：enabled=false 直接放行", async () => {
    const { proxy, port } = await startProxy(new FileAccountIdentity({ enabled: false, enableLogging: false }));
    try {
      const r = await httpGetViaProxy(port, targetPort);
      expect(r.status).toBe(200);
      expect(r.body).toBe("hello-from-target");
    } finally {
      await proxy.stop();
    }
  });

  it("总开关优先：enabled=false + type=basic，带错凭证也放行", async () => {
    const { proxy, port } = await startProxy(
      new FileAccountIdentity({
        enabled: false,
        type: "basic",
        accounts: [{ username: "u", password: "p" }],
        enableLogging: false,
      }),
    );
    try {
      const r = await httpGetViaProxy(port, targetPort, "/hello", {
        "Proxy-Authorization": "Basic d3Jvbmc=",
      });
      expect(r.status).toBe(200);
    } finally {
      await proxy.stop();
    }
  });

  it("basic经Header：正确放行 / 错误407 / 缺失407", async () => {
    const b64 = Buffer.from("u:p").toString("base64");
    const { proxy, port } = await startProxy(
      new FileAccountIdentity({
        enabled: true,
        type: "basic",
        accounts: [{ username: "u", password: "p" }],
        enableLogging: false,
      }),
    );
    try {
      const ok = await httpGetViaProxy(port, targetPort, "/hello", {
        "Proxy-Authorization": `Basic ${b64}`,
      });
      expect(ok.status).toBe(200);
      expect(ok.body).toBe("hello-from-target");
      const wrong = await httpGetViaProxy(port, targetPort, "/hello", {
        "Proxy-Authorization": "Basic d3Jvbmc=",
      });
      expect(wrong.status).toBe(407);
      const missing = await httpGetViaProxy(port, targetPort);
      expect(missing.status).toBe(407);
    } finally {
      await proxy.stop();
    }
  });

  it("jwt：合法token放行 / 非法407 / 缺失407", async () => {
    const { proxy, port } = await startProxy(
      new FileAccountIdentity({
        enabled: true,
        type: "jwt",
        jwtSecret: "s",
        jwtVerify: async (t, s) => t === "good-token" && s === "s",
        enableLogging: false,
      }),
    );
    try {
      const ok = await httpGetViaProxy(port, targetPort, "/hello", {
        Authorization: "Bearer good-token",
      });
      expect(ok.status).toBe(200);
      const bad = await httpGetViaProxy(port, targetPort, "/hello", {
        Authorization: "Bearer bad-token",
      });
      expect(bad.status).toBe(407);
      const missing = await httpGetViaProxy(port, targetPort);
      expect(missing.status).toBe(407);
    } finally {
      await proxy.stop();
    }
  });

  it("jwt误配（未注入verify）：拒绝407且服务不崩", async () => {
    const { proxy, port } = await startProxy(
      new FileAccountIdentity({ enabled: true, type: "jwt", jwtSecret: "s", enableLogging: false }),
    );
    try {
      const first = await httpGetViaProxy(port, targetPort, "/hello", {
        Authorization: "Bearer anything",
      });
      expect(first.status).toBe(407);
      // 服务仍存活，可继续拒绝下一个请求
      const second = await httpGetViaProxy(port, targetPort);
      expect(second.status).toBe(407);
      expect(proxy.isRunning()).toBe(true);
    } finally {
      await proxy.stop();
    }
  });
});
