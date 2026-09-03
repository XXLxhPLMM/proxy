import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { get, set } from "@/config/store.js";
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

/** 在空闲端口上起一个带指定 Auth 的真代理，HttpServer 从 store 读监听地址所以先 set 再 new */
async function startProxy(auth: Auth): Promise<{ proxy: HttpProxy; port: number }> {
  const port = await getFreePort();
  set("port", port);
  const proxy = new HttpProxy({ host: "127.0.0.1", port, auth });
  await proxy.start();
  return { proxy, port };
}

describe("integration/http-proxy-auth", () => {
  let targetPort = 0;
  let target: http.Server | null = null;
  const prev = { host: get("host"), port: get("port"), mode: get("proxyMode"), logLevel: get("logLevel"), logFile: get("logFile") };

  beforeAll(async () => {
    targetPort = await getFreePort();
    set("logLevel", "silent");
    set("logFile", "");
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
    set("host", prev.host);
    set("port", prev.port);
    set("proxyMode", prev.mode);
    set("logLevel", prev.logLevel);
    set("logFile", prev.logFile);
  });

  it("无鉴权：enabled=false 直接放行", async () => {
    const { proxy, port } = await startProxy(new Auth({ enabled: false, enableLogging: false }));
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
      new Auth({ enabled: false, type: "basic", username: "u", password: "p", enableLogging: false }),
    );
    try {
      const r = await httpGetViaProxy(port, targetPort, "/hello", { "Proxy-Authorization": "Basic d3Jvbmc=" });
      expect(r.status).toBe(200);
    } finally {
      await proxy.stop();
    }
  });

  it("basic经Header：正确放行 / 错误407 / 缺失407", async () => {
    const b64 = Buffer.from("u:p").toString("base64");
    const { proxy, port } = await startProxy(
      new Auth({ enabled: true, type: "basic", username: "u", password: "p", enableLogging: false }),
    );
    try {
      const ok = await httpGetViaProxy(port, targetPort, "/hello", { "Proxy-Authorization": `Basic ${b64}` });
      expect(ok.status).toBe(200);
      expect(ok.body).toBe("hello-from-target");
      const wrong = await httpGetViaProxy(port, targetPort, "/hello", { "Proxy-Authorization": "Basic d3Jvbmc=" });
      expect(wrong.status).toBe(407);
      const missing = await httpGetViaProxy(port, targetPort);
      expect(missing.status).toBe(407);
    } finally {
      await proxy.stop();
    }
  });

  it("basic经Cookie：token 别名携带放行", async () => {
    const { proxy, port } = await startProxy(
      new Auth({ enabled: true, type: "basic", username: "u", password: "p", enableLogging: false }),
    );
    try {
      const r = await httpGetViaProxy(port, targetPort, "/hello", { Cookie: "foo=1; token=u:p; bar=2" });
      expect(r.status).toBe(200);
      expect(r.body).toBe("hello-from-target");
    } finally {
      await proxy.stop();
    }
  });

  it("basic经URL：?token= 携带放行", async () => {
    const { proxy, port } = await startProxy(
      new Auth({ enabled: true, type: "basic", username: "u", password: "p", enableLogging: false }),
    );
    try {
      const r = await httpGetViaProxy(port, targetPort, "/hello?token=u%3Ap");
      expect(r.status).toBe(200);
      expect(r.body).toBe("hello-from-target");
    } finally {
      await proxy.stop();
    }
  });

  it("jwt：合法token放行 / 非法407 / 缺失407", async () => {
    const { proxy, port } = await startProxy(
      new Auth({
        enabled: true,
        type: "jwt",
        jwtSecret: "s",
        jwtVerify: async (t, s) => t === "good-token" && s === "s",
        enableLogging: false,
      }),
    );
    try {
      const ok = await httpGetViaProxy(port, targetPort, "/hello", { Authorization: "Bearer good-token" });
      expect(ok.status).toBe(200);
      const bad = await httpGetViaProxy(port, targetPort, "/hello", { Authorization: "Bearer bad-token" });
      expect(bad.status).toBe(407);
      const missing = await httpGetViaProxy(port, targetPort);
      expect(missing.status).toBe(407);
    } finally {
      await proxy.stop();
    }
  });

  it("jwt误配（未注入verify）：拒绝407且服务不崩", async () => {
    const { proxy, port } = await startProxy(
      new Auth({ enabled: true, type: "jwt", jwtSecret: "s", enableLogging: false }),
    );
    try {
      const first = await httpGetViaProxy(port, targetPort, "/hello", { Authorization: "Bearer anything" });
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
